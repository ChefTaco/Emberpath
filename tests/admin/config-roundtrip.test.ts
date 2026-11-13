import {configExportSchema} from '../../src/contracts/model-admin.js';
import {afterAll, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import type {PrismaClient} from '../../src/generated/prisma/client.js';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-config-test-'));
const clients: PrismaClient[] = [];
afterAll(async () => {for (const client of clients) await client.$disconnect(); globalThis.__hiveRouterPrisma = undefined; vi.unstubAllEnvs(); rmSync(directory, {recursive: true, force: true});});

async function installation(name: string) {
  await globalThis.__hiveRouterPrisma?.$disconnect(); globalThis.__hiveRouterPrisma = undefined; vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'file:' + join(directory, name, 'router.db'));
  vi.stubEnv('HIVE_HOME', join(directory, name)); vi.stubEnv('HIVE_ROUTER_ADMIN_USERS', 'admin');
  vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(48).toString('hex'));
  const {ensureSqliteSchema} = await import('../../src/storage/schema.js'); await ensureSqliteSchema();
  const {prisma} = await import('../../src/storage/client.js'); clients.push(prisma);
  const {createAdminApp} = await import('../../src/admin/app.js');
  const {encryptText} = await import('../../src/security/crypto.js');
  const user = await prisma.adminUser.create({data: {username: 'admin', passwordHash: '!externally-managed'}});
  await prisma.adminSession.create({data: {sessionId: 'fixture-session', userId: user.id, expiresAt: new Date(Date.now() + 600000)}});
  const jwt = await new SignJWT({sid: 'fixture-session', username: 'admin', roles: [], permissions: ['router:settings:write'], authMode: 'iam-oidc'})
    .setProtectedHeader({alg: 'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(process.env.HIVE_ROUTER_SECRET));
  const app = createAdminApp(), cookie = 'hive_router_admin=' + jwt;
  const request = (path: string, body?: unknown) => app.request(path, {method: body === undefined ? 'GET' : 'POST', headers: {cookie, 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const snapshot = async () => ({providers: await prisma.provider.findMany({include: {models: true}, orderBy: {slug: 'asc'}}),
    aliases: await prisma.modelAlias.findMany({orderBy: {alias: 'asc'}}), rules: await prisma.routeRule.findMany({orderBy: {name: 'asc'}}),
    heuristics: await prisma.heuristicRule.findMany({orderBy: {name: 'asc'}}), settings: await prisma.runtimeSetting.findMany({orderBy: {key: 'asc'}}),
    audits: await prisma.auditEvent.findMany({orderBy: {id: 'asc'}})});
  return {prisma, request, snapshot, encryptText};
}

it('round-trips exact version-1 exports into the same and fresh SQLite installations without copying credentials or foreign IDs', async () => {
  const source = await installation('source');
  const encrypted = source.encryptText('obviously-fake-source-credential');
  const provider = await source.prisma.provider.create({data: {slug: 'fixture-provider', name: 'Fixture provider', kind: 'OPENAI_GENERIC',
    baseUrl: 'https://provider.example.com/v1', encryptedAuthSecret: encrypted, authMode: 'HEADER', authHeaderName: 'x-provider-auth',
    defaultHeadersJson: '{ "x-title": "synthetic" }', capabilityJson: '{"streaming":true,"tools":false}', passthroughJson: '["/fixture"]',
    timeoutMs: 9000, maxRetries: 0, concurrency: 2, priority: 0, weight: 3, failoverGroup: 'fixture-group', enabled: false,
    lastHealthStatus: 'ok', lastHealthError: 'Synthetic historical status', lastHealthAt: new Date(),
    models: {create: [{model: 'fixture-model', displayName: null, enabled: false, maxContextWindow: null, capabilityJson: null},
      {model: 'named-model', displayName: 'Named model', maxContextWindow: 8192, capabilityJson: '{"tools":false}'}]}}, include: {models: true}});
  await source.prisma.modelAlias.create({data: {alias: 'fixture-alias', upstreamModel: 'fixture-model', providerId: provider.id, enabled: false, description: 'Synthetic alias'}});
  await source.prisma.routeRule.create({data: {name: 'Fixture routing', kind: 'PROVIDER_PREFERENCE', priority: 0, enabled: false,
    matchJson: '{"models":["fixture-alias"]}', actionJson: JSON.stringify({providerIds: [provider.id]})}});
  await source.prisma.heuristicRule.create({data: {name: 'Fixture heuristic', category: 'synthetic', pattern: 'fixture', score: 0, enabled: false,
    actionJson: '{"action":"deny","reason":"Synthetic rule"}'}});
  const opaque = '{ "synthetic": true, "note": "Historical records remain byte stable" }';
  await source.prisma.runtimeSetting.create({data: {key: 'fixture.settings', valueJson: opaque}});
  const exported = await source.request('/api/config/export'); expect(exported.status).toBe(200);
  const archive = await exported.json();
  expect(archive).toMatchObject({version: 1, data: {providers: [{id: provider.id}]}});
  expect(JSON.stringify(archive)).not.toMatch(/encryptedAuthSecret|obviously-fake-source-credential/);
  expect(JSON.stringify(archive)).not.toContain(encrypted);
  expect((await source.request('/api/config/import', archive)).status).toBe(200);
  const same = await source.prisma.provider.findUniqueOrThrow({where: {slug: provider.slug}, include: {models: true}});
  expect(same.id).toBe(provider.id); expect(same.encryptedAuthSecret).toBe(encrypted);
  expect(same).toMatchObject({priority: 0, maxRetries: 0, enabled: false, passthroughJson: '["/fixture"]', lastHealthStatus: 'ok'});
  expect(same.models.map(({id: _id, createdAt: _created, updatedAt: _updated, ...model}) => model).sort((a, b) => a.model.localeCompare(b.model)))
    .toEqual(provider.models.map(({id: _id, createdAt: _created, updatedAt: _updated, ...model}) => model).sort((a, b) => a.model.localeCompare(b.model)));

  const target = await installation('fresh');
  expect((await target.request('/api/config/import', archive)).status).toBe(200);
  const fresh = await target.prisma.provider.findUniqueOrThrow({where: {slug: provider.slug}, include: {models: true}});
  expect(fresh.id).not.toBe(provider.id); expect(fresh.encryptedAuthSecret).toBeNull(); expect(fresh.lastHealthStatus).toBeNull();
  expect(fresh).toMatchObject({priority: 0, maxRetries: 0, enabled: false, passthroughJson: '["/fixture"]', defaultHeadersJson: provider.defaultHeadersJson});
  expect((await target.prisma.modelAlias.findUniqueOrThrow({where: {alias: 'fixture-alias'}})).providerId).toBe(fresh.id);
  expect(JSON.parse((await target.prisma.routeRule.findUniqueOrThrow({where: {name: 'Fixture routing'}})).actionJson).providerIds).toEqual([fresh.id]);
  expect(await target.prisma.heuristicRule.findUniqueOrThrow({where: {name: 'Fixture heuristic'}})).toMatchObject({score: 0, enabled: false, actionJson: '{"action":"deny","reason":"Synthetic rule"}'});
  expect((await target.prisma.runtimeSetting.findUniqueOrThrow({where: {key: 'fixture.settings'}})).valueJson).toBe(opaque);

  const destinationCredential = target.encryptText('obviously-fake-destination-credential');
  await target.prisma.provider.update({where: {id: fresh.id}, data: {encryptedAuthSecret: destinationCredential}});
  expect((await target.request('/api/config/import', archive)).status).toBe(200);
  expect((await target.prisma.provider.findUniqueOrThrow({where: {id: fresh.id}})).encryptedAuthSecret).toBe(destinationCredential);
  const before = await target.snapshot();
  const aliasRef = structuredClone(archive); aliasRef.data.aliases[0].providerId = 'unknown-source-provider';
  const routeRef = structuredClone(archive); routeRef.data.routeRules[0].actionJson = '{"providerIds":["unknown-source-provider"]}';
  const extra = structuredClone(archive); extra.data.providers[0].unexpectedOption = true;
  const version = {...archive, version: 2};
  const malformed = structuredClone(archive); malformed.data.providers[0].capabilityJson = '{';
  const duplicate = structuredClone(archive); duplicate.data.providers.push({...duplicate.data.providers[0], slug: 'different-slug'});
  const modelRef = structuredClone(archive); modelRef.data.providers[0].models[0].providerId = 'unknown-source-provider';
  for (const invalid of [aliasRef, routeRef, extra, version, malformed, duplicate, modelRef]) {
    expect((await target.request('/api/config/import', invalid)).status).toBe(400);
    expect(await target.snapshot()).toEqual(before);
  }
  await target.prisma.$executeRawUnsafe(`CREATE TRIGGER fixture_import_audit_failure BEFORE INSERT ON "AuditEvent" WHEN NEW.action='config.import' BEGIN SELECT RAISE(ABORT, 'Synthetic late import failure'); END`);
  try {
    const failed = structuredClone(archive); failed.data.providers[0].name = 'Must roll back'; failed.data.runtimeSettings.push({key: 'must.rollback', valueJson: '{}'});
    const response = await target.request('/api/config/import', failed); expect(response.status).toBe(500);
    expect(await response.json()).toEqual({error: 'Internal server error'});
    expect(await target.snapshot()).toEqual(before);
  } finally {await target.prisma.$executeRawUnsafe('DROP TRIGGER fixture_import_audit_failure');}
  expect((await target.request('/api/config/import', {data: {providers: [{slug: 'fixture-provider', name: 'Bare compatible import', kind: 'OPENAI_GENERIC', baseUrl: provider.baseUrl}]}})).status).toBe(200);
  const partial = await target.prisma.provider.findUniqueOrThrow({where: {id: fresh.id}, include: {models: true}});
  expect(partial.encryptedAuthSecret).toBe(destinationCredential); expect(partial.models).toEqual(before.providers[0]!.models);
  expect(partial.authMode).toBe('HEADER'); expect(partial.passthroughJson).toBe('["/fixture"]');
  const auditText = JSON.stringify(await target.prisma.auditEvent.findMany());
  expect(auditText).not.toContain(destinationCredential); expect(auditText).not.toMatch(/obviously-fake-(source|destination)-credential/);
}, 30000);

it('keeps recovery exports downloadable when historical records need explicit repair before import', async () => {
  const source = await installation('historical-download');
  await source.prisma.provider.create({data: {slug: 'p', name: 'P', kind: 'OPENAI_GENERIC', baseUrl: 'historical-address',
    capabilityJson: '{invalid historical JSON', defaultHeadersJson: 'historical header text', passthroughJson: 'historical route text',
    models: {create: {model: '', capabilityJson: 'historical model text'}}}});
  await source.prisma.routeRule.create({data: {name: 'R', kind: 'SAFETY', matchJson: 'historical rule text', actionJson: '{'}});
  await source.prisma.heuristicRule.create({data: {name: 'H', category: 'C', pattern: 'P', actionJson: 'historical heuristic text'}});
  await source.prisma.runtimeSetting.create({data: {key: 'historical', valueJson: 'historical runtime text'}});
  const response = await source.request('/api/config/export'); expect(response.status).toBe(200);
  const raw = await response.json(); expect(configExportSchema.parse(raw)).toEqual(raw);
  expect(raw.data.providers[0]).toMatchObject({slug: 'p', capabilityJson: '{invalid historical JSON'});
  const before = await source.snapshot();
  expect((await source.request('/api/config/import', raw)).status).toBe(400);
  expect(await source.snapshot()).toEqual(before);
}, 30000);
