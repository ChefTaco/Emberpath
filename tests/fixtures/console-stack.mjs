import { passkeyFixture } from './passkeys.mjs';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { InMemoryHiveMemStore } from '../../../hive-mem/ts-core/dist/src/store.js';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHiveMemServer } from '../../../hive-mem/ts-core/dist/src/server.js';
import { signToken } from '../../../hive-mem/ts-core/dist/src/auth.js';
const state = mkdtempSync(join(tmpdir(), 'hive-console-e2e-'));
const secret = randomBytes(32).toString('hex');
const store = new InMemoryHiveMemStore();
store.registerAgent({ agentId: 'fixture-operator', scopes: ['*'], rawClaims: { role: 'admin' } }, { agent_id: 'navigation-fixture', display_name: 'Navigation fixture' }, 'unused');
const register = store.registerAgent.bind(store); const failed = new Set();
store.registerAgent = (principal, body, token) => {
  if (body.agent_id.startsWith('partial-') && !failed.has(body.agent_id)) { failed.add(body.agent_id); throw new Error('Injected fixture enrollment failure'); }
  const result = register(principal, body, token);
  if (body.agent_id.startsWith('lost-memory-') && !failed.has(body.agent_id)) { failed.add(body.agent_id); throw new Error('Injected response loss after Memory commit'); }
  return result;
};
const rotate = store.rotateAgentCredentials.bind(store);
store.rotateAgentCredentials = (principal, id) => { if (id.startsWith('rotation-') && !failed.has('rotate:' + id)) { failed.add('rotate:' + id); throw new Error('Injected fixture rotation failure'); } return rotate(principal, id); };
const memory = createHiveMemServer({ jwtSecret: secret, store });
const accounts = new Map();
let passwordPolicy = { name: 'Default', minLength: 10, maxLength: 128, requireUppercase: true, requireLowercase: true, requireNumbers: true, requireSpecial: false, maxAgeDays: 90, historyCount: 5, lockoutAttempts: 5, lockoutDurationMin: 15 };
async function alterFixtureDatabase(sql) {
  for (let attempt = 0; ; attempt++) {
    const database = new DatabaseSync(join(state, 'router.db'));
    try { database.exec(sql); return; }
    catch (error) { if (error.errcode !== 5 || attempt >= 100) throw error; }
    finally { database.close(); }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const passkeys = await passkeyFixture(state);
const iam = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString(); let body = {}; try { body = JSON.parse(text); } catch {}
  response.setHeader('content-type', 'application/json'); let result = {};
  if (request.url.startsWith('/api/v1/webauthn/fixture-')) { try { result = await passkeys.handle(request, body); } catch { response.statusCode = 400; result = { error: 'Ceremony rejected' }; } }
  else if (request.url.endsWith('/oauth/token')) result = { access_token: 'fixture-proxy', expires_in: 600, token_type: 'Bearer' };
  else if (request.url === '/api/v1/service-accounts' && request.method === 'POST') {
    let account = accounts.get(body.operationId); const existing = Boolean(account);
    if (!account) { account = { id: 'fixture-iam-' + accounts.size, active: true, rotationCount: 0, apiKey: randomBytes(24).toString('hex'), ...body }; accounts.set(body.operationId, account); }
    result = { ...account, ...(existing ? { apiKey: '' } : {}) }; response.statusCode = 201;
    if (body.name?.startsWith('hive-actor-lost-iam-') && !failed.has(body.name)) { failed.add(body.name); response.statusCode = 503; result = { error: 'Injected response loss after IAM commit' }; }
    if (body.name?.startsWith('hive-actor-router-crash-') && !existing) {
      await alterFixtureDatabase("CREATE TRIGGER fixture_router_key_rollback BEFORE UPDATE OF routerKeyId ON ActorEnrollment WHEN NEW.actorId LIKE 'router-crash-%' AND NEW.routerKeyId IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Injected Router receipt checkpoint failure'); END");
    }
  }
  else if (request.url.includes('/rotate')) {
    const id = request.url.split('/').at(-2); const account = [...accounts.values()].find((entry) => entry.id === id);
    if (!account?.active) { response.statusCode = 403; result = { error: 'Account inactive or missing' }; }
    else { account.apiKey = randomBytes(24).toString('hex'); account.rotationCount++; result = { apiKey: account.apiKey }; }
  }
  else if (request.url === '/api/v1/service-accounts') result = { serviceAccounts: [...accounts.values()].map(({ apiKey, ...account }) => account) };
  else if (request.url.startsWith('/api/v1/password-policy') && request.method === 'GET') result = { policy: passwordPolicy };
  else if (request.url.startsWith('/api/v1/password-policy') && request.method === 'PATCH') {
    let operator = {}; try { operator = JSON.parse(String(request.headers['x-hive-operator'] ?? '{}')); } catch {}
    if (request.headers.authorization !== 'Bearer fixture-proxy' || !operator.id || !operator.sessionId || typeof operator.authenticatedAt !== 'number' || Date.now() - operator.authenticatedAt > 900_000) {
      response.statusCode = 403; result = { error: 'Recent verified Router operator context required' };
    } else { passwordPolicy = { ...passwordPolicy, ...body }; result = { policy: passwordPolicy, operatorVerified: true }; }
  }
  else if (request.url === '/api/v1/health') result = { status: 'ok' };
  else if (request.url === '/api/v1/roles') result = { roles: [] };
  else if (request.url.startsWith('/api/v1/users?')) result = { users: [], total: 0, page: 1, limit: 100 };
  else if (request.url === '/api/v1/clients') result = { clients: [] };
  else if (request.url === '/api/v1/sessions') result = { sessions: [] };
  else if (request.url === '/api/v1/system-users') result = { systemUsers: [] };
  else if (request.url === '/api/v1/audit/stats') result = { totalEvents: 0 };
  else if (request.url.startsWith('/api/v1/audit?')) result = { events: [], total: 0, page: 1, limit: 50 };
  else if (request.method === 'GET' && request.url.startsWith('/api/v1/service-accounts/')) {
    const account = [...accounts.values()].find((entry) => entry.id === request.url.split('/').at(-1));
    if (account?.name.startsWith('hive-actor-router-crash-')) await alterFixtureDatabase('DROP TRIGGER IF EXISTS fixture_router_key_rollback');
    if (account) { const { apiKey, ...safe } = account; result = safe; } else { response.statusCode = 404; result = { error: 'Missing account' }; }
  }
  else if (request.method === 'PATCH' && request.url.includes('/service-accounts/')) { const account = [...accounts.values()].find((entry) => entry.id === request.url.split('/').at(-1)); if (account) { account.active = body.active; result = { active: account.active }; } else { response.statusCode = 404; result = { error: 'Missing account' }; } }
  else { response.statusCode = 503; result = { error: 'Fixture route unavailable' }; }
  response.end(JSON.stringify(result));
});
await new Promise((resolve) => iam.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => memory.listen(0, '127.0.0.1', resolve));
const memoryUrl = `http://127.0.0.1:${memory.address().port}`;
const token = signToken(secret, { sub: 'console-fixture', role: 'admin', scope: '*', exp: Math.floor(Date.now() / 1000) + 600 });
const child = spawn(process.execPath, ['dist/src/index.js'], { stdio: ['ignore', 'inherit', 'inherit'], env: {
  ...process.env, HIVE_AUTO_MIGRATE:'true',HIVE_UPDATE_CHECK:'false', NODE_ENV: 'test', API_HOST: '127.0.0.1', ADMIN_HOST: '127.0.0.1', API_PORT: '15020', ADMIN_PORT: '19443',
  PUBLIC_API_URL: 'http://127.0.0.1:15020', PUBLIC_ADMIN_URL: 'http://127.0.0.1:19443', DATABASE_URL: `file:${state}/router.db`, DATA_DIR: state, TRACE_DIR: join(state, 'traces'),
  HIVE_ROUTER_SECRET: randomBytes(32).toString('hex'), HIVE_ROUTER_AUTH_MODE: 'os', HIVE_ROUTER_ADMIN_USERS: 'admin', HIVE_ROUTER_OS_AUTH_COMMAND: './tests/fixtures/os-auth.mjs',
  HIVEMEM_INTERNAL_URL: memoryUrl, HIVEMEM_PUBLIC_URL: memoryUrl, HIVE_ROUTER_MEMORY_PROXY_TOKEN: token, HIVE_IAM_INTERNAL_URL: `http://127.0.0.1:${iam.address().port}`, HIVE_ROUTER_IAM_CLIENT_SECRET: randomBytes(32).toString('hex'), HIVE_ROUTER_SECURITY_EXPORT_STATIC_FALLBACK_ENABLED: 'false',
} });
let closing = false;
function close() { if (closing) return; closing = true; child.kill('SIGTERM'); passkeys.stop(); memory.close(); iam.close(); }
process.on('SIGTERM', close); process.on('SIGINT', close);
child.once('exit', (code) => { passkeys.stop(); memory.close(); iam.close(); rmSync(state, { recursive: true, force: true }); process.exit(closing ? 0 : code ?? 1); });
