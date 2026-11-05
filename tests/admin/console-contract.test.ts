import {afterAll, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import {z} from 'zod';
import * as contracts from '../../src/contracts/model-admin.js';
import {consoleAdminOpenApi} from '../../src/openapi/console-admin.js';
import {RouteRuleKind} from '../../src/generated/prisma/client.js';
import * as native from '../../src/admin/schemas.js';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-console-contract-'));
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'fixture.db')); vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(48).toString('hex')); vi.stubEnv('HIVE_ROUTER_ADMIN_USERS', 'admin');
const {ensureSqliteSchema} = await import('../../src/storage/schema.js'); await ensureSqliteSchema();
const {prisma} = await import('../../src/storage/client.js');
const {createAdminApp} = await import('../../src/admin/app.js');
const {encryptText} = await import('../../src/security/crypto.js');
const app = createAdminApp();
afterAll(async () => {await prisma.$disconnect(); globalThis.__hiveRouterPrisma = undefined; vi.unstubAllEnvs(); rmSync(directory, {recursive: true, force: true});});

it('exports native request schemas and precise permission/response OpenAPI contracts', () => {
  for (const name of ['routeRuleSchema', 'heuristicSchema', 'routingObjectiveSchema', 'clientKeySchema', 'clientKeyUpdateSchema'] as const)
    expect(contracts[name]).toBe(native[name]);
  expect(contracts.routeRuleSchema.shape.kind.options).toEqual(Object.values(RouteRuleKind));
  const doc = consoleAdminOpenApi();
  expect(doc.schemas.RouteRuleWrite).toEqual(z.toJSONSchema(native.routeRuleSchema, {io: 'input'}));
  expect(doc.schemas.ClientKeyWrite).toEqual(z.toJSONSchema(native.clientKeySchema, {io: 'input'}));
  for (const path of ['/api/route-rules', '/api/heuristics', '/api/client-keys', '/api/client-keys/{id}/rotate', '/api/client-keys/{id}/usage',
    '/api/routing/objective', '/api/testing/run', '/api/testing/preview', '/api/routing/revisions', '/api/routing/revisions/{id}/rollback',
    '/api/telemetry', '/api/traces', '/api/audit', '/api/runtime-settings', '/api/providers/codex-oauth/status', '/api/providers/codex-oauth/start', '/api/providers/codex-oauth/check'])
    expect(doc.paths[path], path).toBeDefined();
  expect(doc.paths['/api/testing/preview']!.post).toMatchObject({'x-permission': 'router:testing:read'});
  expect(doc.paths['/api/testing/run']!.post).toMatchObject({'x-permission': 'router:testing:write'});
  expect(doc.paths['/api/client-keys']!.post).toMatchObject({responses: {'201': {content: {'application/json': {schema: {properties: {data: {$ref: '#/components/schemas/ClientKeyCreated'}}}}}}}});
});

it('validates real SQLite reads/writes, secret redaction, scoped authorization and revoked sessions', async () => {
  const user = await prisma.adminUser.create({data: {username: 'admin', passwordHash: 'obviously-fake-password-hash'}});
  await prisma.adminSession.create({data: {sessionId: 'fixture', userId: user.id, expiresAt: new Date(Date.now() + 600000)}});
  const cookie = async (permissions: string[], issuedAt = Math.floor(Date.now() / 1000)) => 'hive_router_admin=' + await new SignJWT({sid: 'fixture', username: 'admin', roles: [], permissions, authMode: 'iam-oidc'})
    .setProtectedHeader({alg: 'HS256'}).setSubject(user.id).setIssuedAt(issuedAt).setExpirationTime('10m').sign(new TextEncoder().encode(process.env.HIVE_ROUTER_SECRET));
  const all = await cookie(['*']), read = await cookie(['router:routing:read', 'router:keys:read', 'router:testing:read']);
  const req = (path: string, method = 'GET', body?: unknown, session = all) => app.request(path, {method, headers: {cookie: session, 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const parse = async <T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown) => {
    const response = await req(path, method, body); expect(response.status, path).toBe(method === 'POST' && ['/api/route-rules', '/api/heuristics', '/api/client-keys'].includes(path) ? 201 : 200);
    return {response, body: schema.parse(await response.json())};
  };
  const secret = encryptText('obviously-fake-provider-secret');
  const provider = await prisma.provider.create({data: {slug: 'fixture', name: 'Fixture', kind: 'OPENAI_GENERIC', baseUrl: 'https://provider.example.com/v1',
    enabled: false, encryptedAuthSecret: secret, defaultHeadersJson: '{"x-private-header":"obviously-fake-header-secret"}'}});
  const route = {name: 'Synthetic rule', kind: 'SAFETY', priority: 0, enabled: true, matchJson: {models: ['fixture']}, actionJson: {deny: true, denyReason: 'Synthetic denial'}};
  const created = await parse('/api/route-rules', contracts.modelConsoleSchemas.routeRule, 'POST', route);
  await parse('/api/route-rules/' + created.body.data.id, contracts.modelConsoleSchemas.routeRule, 'PUT', {...route, priority: 2});
  const heuristic = {name: 'Synthetic heuristic', category: 'fixture', pattern: 'fixture', score: 0, enabled: false, actionJson: {action: 'deny', reason: 'Synthetic'}};
  const h = await parse('/api/heuristics', contracts.modelConsoleSchemas.heuristic, 'POST', heuristic);
  await parse('/api/heuristics/' + h.body.data.id, contracts.modelConsoleSchemas.heuristic, 'PUT', {...heuristic, score: 3});
  await parse('/api/route-rules', contracts.modelConsoleSchemas.routeRules); await parse('/api/heuristics', contracts.modelConsoleSchemas.heuristics);
  expect((await req('/api/route-rules', 'POST', route, read)).status).toBe(403);
  const before = await prisma.routeRule.findMany();
  expect((await req('/api/route-rules/' + created.body.data.id, 'PUT', {...route, actionJson: {providerIds: 'invalid'}})).status).toBe(400);
  expect(await prisma.routeRule.findMany()).toEqual(before);
  await parse('/api/routing/objective', contracts.modelConsoleSchemas.routingObjective, 'PUT', {goal: 'balanced', costWeight: 0});
  await parse('/api/routing/objective', contracts.modelConsoleSchemas.routingObjective);
  const revisions = await parse('/api/routing/revisions', contracts.routingRevisionsSchema);
  const applied = await parse('/api/routing/revisions', contracts.routingAppliedSchema, 'POST', {baseRevision: revisions.body.revision, patch: {objective: {goal: 'cheapest'}}});
  expect((await req('/api/routing/revisions', 'POST', {baseRevision: revisions.body.revision, patch: {objective: {goal: 'fastest'}}})).status).toBe(409);
  await parse('/api/routing/revisions/' + applied.body.previousRevision + '/rollback', contracts.routingSnapshotSchema, 'POST', {baseRevision: applied.body.revision});
  const preview = await req('/api/testing/preview', 'POST', {cases: [{modelAlias: 'fixture', prompt: 'fixture'}]}, read);
  expect(preview.status).toBe(200); contracts.routingPreviewSchema.parse(await preview.json());
  await parse('/api/testing/run', contracts.modelConsoleSchemas.routingTest, 'POST', {modelAlias: 'fixture', prompt: 'fixture'});
  expect((await req('/api/testing/run', 'POST', {modelAlias: 'fixture', prompt: 'fixture'}, read)).status).toBe(403);
  const key = await parse('/api/client-keys', contracts.modelConsoleSchemas.createdClientKey, 'POST', {name: 'Synthetic key', metadata: {scopes: ['models:read'], quota: {dailyRequests: 2}}});
  expect(key.response.headers.get('cache-control')).toBe('no-store');
  const keyId = key.body.data.id, originalKey = key.body.data.apiKey;
  await parse('/api/client-keys/' + keyId, contracts.modelConsoleSchemas.clientKey, 'PUT', {enabled: false});
  const rotated = await parse('/api/client-keys/' + keyId + '/rotate', contracts.modelConsoleSchemas.rotatedClientKey, 'POST');
  expect(rotated.response.headers.get('cache-control')).toBe('no-store'); expect(rotated.body.data.apiKey).not.toBe(originalKey);
  const list = await parse('/api/client-keys', contracts.modelConsoleSchemas.clientKeys);
  expect(JSON.stringify(list.body)).not.toContain(originalKey); expect(JSON.stringify(list.body)).not.toContain(rotated.body.data.apiKey);
  expect(JSON.stringify(list.body)).not.toContain('keyHash');
  expect((await req('/api/client-keys', 'POST', {name: 'Forbidden key'}, read)).status).toBe(403);
  await prisma.adminSession.updateMany({where: {sessionId: 'fixture'}, data: {createdAt: new Date(Date.now() - 1000000)}});
  expect((await req('/api/client-keys', 'GET', undefined, read)).status).toBe(403);
  await prisma.adminSession.updateMany({where: {sessionId: 'fixture'}, data: {createdAt: new Date()}});
  await parse('/api/client-keys/' + keyId + '/usage', contracts.modelConsoleSchemas.clientKeyUsage);
  await prisma.trace.create({data: {requestId: 'fixture-request', method: 'POST', path: '/v1/responses', endpointKind: 'v1.responses', routeKey: 'fixture',
    decisionJson: '{}', outcome: 'FAILED', providerId: provider.id, clientApiKeyId: keyId, events: {create: {type: 'fixture', message: 'Synthetic event'}}}});
  const traces = await req('/api/traces'); const tracesJson = await traces.json(); contracts.modelConsoleSchemas.traces.parse(tracesJson);
  const serialized = JSON.stringify(tracesJson);
  expect(serialized).not.toMatch(/encryptedAuthSecret|defaultHeadersJson|keyHash|passwordHash|obviously-fake/); expect(serialized).not.toContain(secret);
  expect(tracesJson.data[0].provider).toEqual({id: provider.id, slug: 'fixture', name: 'Fixture', kind: 'OPENAI_GENERIC'});
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({events: []}));
  try {
    const incidents = await req('/api/hive/incidents'); expect(incidents.status).toBe(200);
    expect(JSON.stringify(await incidents.json())).not.toMatch(/encryptedAuthSecret|defaultHeadersJson|keyHash|passwordHash|obviously-fake/);
  } finally {fetch.mockRestore();}
  await parse('/api/telemetry', contracts.telemetrySchema);
  await parse('/api/docs/index', contracts.docsIndexSchema);
  const audit = await parse('/api/audit', contracts.modelConsoleSchemas.audit); expect(JSON.stringify(audit.body)).not.toContain('passwordHash');
  expect(JSON.stringify(audit.body)).not.toContain(originalKey); expect(JSON.stringify(audit.body)).not.toContain(rotated.body.data.apiKey);
  await parse('/api/runtime-settings', contracts.modelConsoleSchemas.runtimeSettings);
  await parse('/api/providers/codex-oauth/status', contracts.modelConsoleSchemas.codexOAuthStatus);
  await parse('/api/providers/codex-oauth/check', contracts.modelConsoleSchemas.codexOAuthCheck, 'POST', {loginId: 'unknown-fixture'});
  expect((await req('/api/providers/codex-oauth/start', 'POST', undefined, read)).status).toBe(403); // No hosted call on denied requests.
  await parse('/api/heuristics/' + h.body.data.id, contracts.okSchema, 'DELETE');
  await parse('/api/route-rules/' + (await prisma.routeRule.findFirstOrThrow({where: {name: route.name}})).id, contracts.okSchema, 'DELETE');
  await prisma.adminSession.updateMany({where: {sessionId: 'fixture'}, data: {revokedAt: new Date()}});
  for (const path of ['/api/client-keys', '/api/route-rules', '/api/traces', '/api/providers/codex-oauth/status']) expect((await req(path)).status).toBe(401);
}, 30000);
