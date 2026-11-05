import {afterAll, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import {providerReadSchema, modelAliasReadSchema} from '../../src/contracts/model-admin.js';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-provider-atomicity-'));
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'fixture.db'));
vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(48).toString('hex'));
vi.stubEnv('HIVE_ROUTER_ADMIN_USERS', 'admin');
const {ensureSqliteSchema} = await import('../../src/storage/schema.js');
await ensureSqliteSchema();
const {prisma} = await import('../../src/storage/client.js');
const {createAdminApp} = await import('../../src/admin/app.js');
const {encryptText} = await import('../../src/security/crypto.js');
afterAll(async () => {await prisma.$disconnect(); globalThis.__hiveRouterPrisma = undefined; vi.unstubAllEnvs(); rmSync(directory, {recursive: true, force: true});});

it('provider updates retain all prior models and credentials after parent or nested-row failure', async () => {
  const user = await prisma.adminUser.create({data: {username: 'admin', passwordHash: '!externally-managed'}});
  await prisma.adminSession.create({data: {sessionId: 'fixture-session', userId: user.id, expiresAt: new Date(Date.now() + 60000)}});
  const cookie = 'hive_router_admin=' + await new SignJWT({sid: 'fixture-session', username: 'admin', roles: [],
    permissions: ['router:providers:write', 'router:routing:write', 'router:providers:read', 'router:routing:read'], authMode: 'iam-oidc'}).setProtectedHeader({alg: 'HS256'}).setSubject(user.id)
    .setIssuedAt().setExpirationTime('60s').sign(new TextEncoder().encode(process.env.HIVE_ROUTER_SECRET));
  const encrypted = encryptText('obviously-fake-provider-credential');
  const provider = await prisma.provider.create({data: {slug: 'fixture', name: 'Original fixture', kind: 'OPENAI_GENERIC',
    baseUrl: 'https://provider.example.com/v1', encryptedAuthSecret: encrypted,
    models: {create: [{model: 'original', enabled: false, displayName: 'Original model', maxContextWindow: 8192,
      capabilityJson: '{"streaming":true,"tools":false}'}]}}, include: {models: true}});
  await prisma.provider.create({data: {slug: 'occupied', name: 'Another fixture', kind: 'OPENAI_GENERIC', baseUrl: 'https://other.example.com/v1'}});
  const app = createAdminApp();
  const original = await prisma.provider.findUniqueOrThrow({where: {id: provider.id}, include: {models: true}});
  const body = {slug: 'fixture', name: 'Renamed fixture', kind: 'OPENAI_GENERIC', baseUrl: 'https://provider.example.com/v1',
    models: [{model: 'original', enabled: false, displayName: 'Original model', maxContextWindow: 8192, capabilityJson: {streaming: true, tools: false}}]};
  const put = (value: unknown) => app.request('/api/providers/' + provider.id, {method: 'PUT', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(value)});
  for (const invalid of [{...body, slug: 'occupied'}, {...body, models: [body.models[0], body.models[0]]}]) {
    const rejected = await put(invalid);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({error: 'A record with these unique fields already exists. Review the existing record before saving.'});
    expect(await prisma.provider.findUniqueOrThrow({where: {id: provider.id}, include: {models: true}})).toEqual(original);
  }
  const response = await put(body); expect(response.status).toBe(200);
  const saved = await prisma.provider.findUniqueOrThrow({where: {id: provider.id}, include: {models: true}});
  expect(saved.name).toBe('Renamed fixture'); expect(saved.encryptedAuthSecret).toBe(encrypted);
  expect(saved.models).toHaveLength(1);
  expect(saved.models[0]).toMatchObject({model: 'original', enabled: false, displayName: 'Original model', maxContextWindow: 8192});
  expect(JSON.parse(saved.models[0]!.capabilityJson ?? '{}')).toEqual({streaming: true, tools: false});
  await prisma.modelAlias.create({data: {alias: 'synthetic-existing', upstreamModel: 'original'}});
  const duplicate = await app.request('/api/model-aliases', {method: 'POST', headers: {cookie, 'content-type': 'application/json'},
    body: JSON.stringify({alias: 'synthetic-existing', upstreamModel: 'original'})});
  expect(duplicate.status).toBe(409);
  const duplicateBody = await duplicate.json();
  expect(duplicateBody).toEqual({error: 'A record with these unique fields already exists. Review the existing record before saving.'});
  expect(JSON.stringify(duplicateBody)).not.toContain('synthetic-existing');
  await prisma.modelAlias.create({data: {alias: 'bound-fixture', upstreamModel: 'original', providerId: provider.id}});
  const aliases = await app.request('/api/model-aliases', {headers: {cookie}});
  expect(aliases.status).toBe(200);
  const json = await aliases.json() as {data: Array<{alias: string; provider: unknown}>};
  for (const row of json.data) expect(() => modelAliasReadSchema.parse(row)).not.toThrow();
  expect(json.data.find(item => item.alias === 'bound-fixture')?.provider).toEqual({id: provider.id, slug: 'fixture', name: 'Renamed fixture', kind: 'OPENAI_GENERIC'});
  expect(JSON.stringify(json)).not.toContain(encrypted);
  expect(JSON.stringify(json)).not.toMatch(/encryptedAuthSecret|defaultHeadersJson|capabilityJson|obviously-fake-provider-credential/);
  const listed = await app.request('/api/providers', {headers: {cookie}});
  expect(listed.status).toBe(200);
  for (const row of (await listed.json() as {data: unknown[]}).data) expect(() => providerReadSchema.parse(row)).not.toThrow();
});
