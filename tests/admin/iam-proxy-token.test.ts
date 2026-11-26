// The Router's own Oathweave client token for IAM reads and writes: requested once and shared,
// cached, renewed and retried once when Oathweave refuses it, and not fetched per request
// when a fresh token is refused.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';

const clientSecret = 'synthetic-router-client-secret-0123456789';
const tokenForms: URLSearchParams[] = [];
const iamCalls: Array<{ url: string; token: string }> = [];
const refused = new Set<string>();
let issued = 0;

const server: Server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v1/oauth/token') {
      tokenForms.push(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      issued += 1;
      return response.end(JSON.stringify({ access_token: `synthetic-proxy-token-${issued}`, expires_in: 300, token_type: 'Bearer' }));
    }
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /u, '');
    if (request.url?.startsWith('/api/v1/')) iamCalls.push({ url: request.url, token });
    if (refused.has(token)) {
      response.statusCode = 401;
      return response.end(JSON.stringify({ error: 'invalid_token' }));
    }
    return response.end(JSON.stringify({ users: [], serviceAccounts: [], systemUsers: [] }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const directory = mkdtempSync(join(tmpdir(), 'emberpath-iam-proxy-token-'));
const secret = randomBytes(48).toString('hex');
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'router.db'));
vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('DATA_DIR', directory);
vi.stubEnv('TRACE_DIR', join(directory, 'traces'));
vi.stubEnv('HIVE_ROUTER_SECRET', secret);
vi.stubEnv('HIVE_IAM_INTERNAL_URL', baseUrl);
vi.stubEnv('HIVEMEM_INTERNAL_URL', baseUrl);
vi.stubEnv('HIVE_ROUTER_IAM_CLIENT_SECRET', clientSecret);
vi.stubEnv('HIVE_ROUTER_IAM_PROXY_SCOPES', 'iam:users:read iam:sa:read');

const { ensureSqliteSchema } = await import('../../src/storage/schema.js');
await ensureSqliteSchema();
const { prisma } = await import('../../src/storage/client.js');
const { createAdminApp } = await import('../../src/admin/app.js');

let cookie = '';
beforeAll(async () => {
  const user = await prisma.adminUser.create({ data: { username: 'admin', passwordHash: 'obviously-fake-password-hash' } });
  await prisma.adminSession.create({ data: { sessionId: 'operator-session', userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) } });
  cookie = 'hive_router_admin=' + await new SignJWT({ sid: 'operator-session', username: 'admin', roles: [], permissions: ['*'], authMode: 'os' })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
});
afterAll(async () => {
  vi.useRealTimers();
  server.close();
  await prisma.$disconnect();
  globalThis.__hiveRouterPrisma = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

const listActors = async () => {
  iamCalls.length = 0;
  const response = await createAdminApp().request('/api/hive/actors', { headers: { cookie } });
  expect(response.status).toBe(200);
  return iamCalls.map((call) => call.token);
};

describe('the IAM proxy client token', () => {
  it('is requested once with the Router client and proxy scopes, shared by concurrent calls and cached', async () => {
    expect(new Set(await listActors())).toEqual(new Set(['synthetic-proxy-token-1']));
    expect(tokenForms).toHaveLength(1);
    expect(Object.fromEntries(tokenForms[0]!)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'hive-router',
      client_secret: clientSecret,
      scope: 'iam:users:read iam:sa:read',
    });
    expect(new Set(await listActors())).toEqual(new Set(['synthetic-proxy-token-1']));
    expect(tokenForms).toHaveLength(1);
  });

  it('is replaced and the call retried once when Oathweave refuses it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000); // the refused token is not fresh
    refused.add('synthetic-proxy-token-1');
    const tokens = await listActors();
    expect(tokens.filter((token) => token === 'synthetic-proxy-token-1')).toHaveLength(3);
    expect(tokens.filter((token) => token === 'synthetic-proxy-token-2')).toHaveLength(3);
    expect(tokenForms).toHaveLength(2);
  });

  it('backs off instead of fetching per request when a fresh token is refused, then recovers', async () => {
    refused.add('synthetic-proxy-token-2');
    const tokens = await listActors();
    expect(new Set(tokens)).toEqual(new Set(['synthetic-proxy-token-2']));
    expect(tokenForms).toHaveLength(2);
    await listActors();
    expect(tokenForms).toHaveLength(2);
    vi.setSystemTime(Date.now() + 5_001);
    expect(new Set(await listActors())).toEqual(new Set(['synthetic-proxy-token-3']));
    expect(tokenForms).toHaveLength(3);
  });
});
