import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import {configExportSchema, configImportResultSchema, modelAdminErrorSchema, providerReadSchema, providerRedactedValue,
  providerWriteErrorCodes} from '../../src/contracts/model-admin.js';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-credential-origin-'));
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'fixture.db'));
vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(48).toString('hex'));
vi.stubEnv('HIVE_ROUTER_ADMIN_USERS', 'admin');
const {ensureSqliteSchema} = await import('../../src/storage/schema.js');
await ensureSqliteSchema();
const {prisma} = await import('../../src/storage/client.js');
const {createAdminApp} = await import('../../src/admin/app.js');
const {encryptText, decryptText} = await import('../../src/security/crypto.js');
const {mapSecurityExportEvent} = await import('../../src/security/security-export.js');
afterAll(async () => {await prisma.$disconnect(); globalThis.__hiveRouterPrisma = undefined; vi.unstubAllEnvs(); rmSync(directory, {recursive: true, force: true});});

const SECRET = 'obviously-fake-provider-credential';
const HEADER_SECRET = 'obviously-fake-header-credential';
const ORIGIN = 'https://provider.example.com';
const OTHER = 'https://collector.example.net';
const user = await prisma.adminUser.create({data: {username: 'admin', passwordHash: '!externally-managed'}});
await prisma.adminSession.create({data: {sessionId: 'fixture-session', userId: user.id, expiresAt: new Date(Date.now() + 600000)}});
const cookie = 'hive_router_admin=' + await new SignJWT({sid: 'fixture-session', username: 'admin', roles: [],
  permissions: ['router:providers:write', 'router:providers:read', 'router:settings:write'], authMode: 'iam-oidc'}).setProtectedHeader({alg: 'HS256'})
  .setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(process.env.HIVE_ROUTER_SECRET));
const app = createAdminApp();
const send = (method: string, path: string, body?: unknown) => app.request(path, {method, headers: {cookie, 'content-type': 'application/json'},
  ...(body === undefined ? {} : {body: JSON.stringify(body)})});

let providerId = '';
const stored = () => prisma.provider.findUniqueOrThrow({where: {id: providerId}, include: {models: true}});
const audits = (action: string) => prisma.auditEvent.findMany({where: {action}, orderBy: {createdAt: 'asc'}});
const write = (changes: Record<string, unknown> = {}) => ({slug: 'fixture', name: 'Fixture', kind: 'OPENAI_GENERIC', baseUrl: ORIGIN + '/v1',
  authMode: 'HEADER', authHeaderName: 'x-provider-auth',
  defaultHeaders: {'x-api-token': providerRedactedValue, 'anthropic-version': '2023-06-01'},
  models: [{model: 'fixture-model'}], ...changes});

beforeEach(async () => {
  await prisma.auditEvent.deleteMany(); await prisma.provider.deleteMany();
  const created = await prisma.provider.create({data: {slug: 'fixture', name: 'Fixture', kind: 'OPENAI_GENERIC', baseUrl: ORIGIN + '/v1',
    authMode: 'HEADER', authHeaderName: 'x-provider-auth', encryptedAuthSecret: encryptText(SECRET),
    defaultHeadersJson: JSON.stringify({'x-api-token': HEADER_SECRET, 'anthropic-version': '2023-06-01'}),
    models: {create: [{model: 'fixture-model'}]}}});
  providerId = created.id;
});

async function expectRefused(response: Response, code: string, status = 422) {
  expect(response.status).toBe(status);
  const body = modelAdminErrorSchema.parse(await response.json());
  expect(body.code).toBe(code);
  expect(JSON.stringify(body)).not.toContain(SECRET); expect(JSON.stringify(body)).not.toContain(HEADER_SECRET);
  return body;
}

describe('provider reads', () => {
  it('return no credential header value, no URL user info and no secret, and mark what is stored', async () => {
    await prisma.provider.update({where: {id: providerId}, data: {baseUrl: 'https://operator:obviously-fake-url-password@provider.example.com/v1'}});
    const response = await send('GET', '/api/providers'); expect(response.status).toBe(200);
    const text = await response.text();
    for (const leaked of [SECRET, HEADER_SECRET, 'obviously-fake-url-password', 'operator']) expect(text).not.toContain(leaked);
    const [row] = (JSON.parse(text) as {data: unknown[]}).data;
    expect(providerReadSchema.parse(row)).toMatchObject({baseUrl: ORIGIN + '/v1', hasAuthSecret: true,
      defaultHeaders: {'x-api-token': providerRedactedValue, 'anthropic-version': '2023-06-01'}, redactedDefaultHeaders: ['x-api-token']});
    const docs = await send('GET', '/api/docs/index');
    expect(await docs.text()).not.toContain('obviously-fake-url-password');
  });

  it('export archives without credential header values or URL user info, and import them without storing the stand-in', async () => {
    await prisma.provider.update({where: {id: providerId}, data: {baseUrl: 'https://operator:obviously-fake-url-password@provider.example.com/v1'}});
    const exported = await send('GET', '/api/config/export'); expect(exported.status).toBe(200);
    const text = await exported.text();
    for (const leaked of [SECRET, HEADER_SECRET, 'obviously-fake-url-password', 'encryptedAuthSecret']) expect(text).not.toContain(leaked);
    const archive = configExportSchema.parse(JSON.parse(text));
    expect(archive.data.providers[0]).toMatchObject({baseUrl: ORIGIN + '/v1',
      defaultHeadersJson: JSON.stringify({'x-api-token': providerRedactedValue, 'anthropic-version': '2023-06-01'})});

    // Same installation: the stand-in keeps the stored header value and the stored secret.
    const before = await stored();
    const same = await send('POST', '/api/config/import', archive); expect(same.status).toBe(200);
    expect(configImportResultSchema.parse(await same.json())).toEqual({ok: true});
    const after = await stored();
    expect(after.defaultHeadersJson).toBe(before.defaultHeadersJson);
    expect(after.encryptedAuthSecret).toBe(before.encryptedAuthSecret);

    // No stored value at the destination: the header is left out and reported, never stored as the stand-in.
    await prisma.provider.deleteMany();
    const fresh = await send('POST', '/api/config/import', archive); expect(fresh.status).toBe(200);
    expect(configImportResultSchema.parse(await fresh.json())).toEqual({ok: true, redactedHeadersNotImported: [{provider: 'fixture', headers: ['x-api-token']}]});
    const imported = await prisma.provider.findUniqueOrThrow({where: {slug: 'fixture'}});
    expect(JSON.parse(imported.defaultHeadersJson ?? 'null')).toEqual({'anthropic-version': '2023-06-01'});
    expect(imported.encryptedAuthSecret).toBeNull();
  });
});

describe('PUT /api/providers/:id', () => {
  it('keeps the stored secret and credential headers for a path change on the same origin', async () => {
    const before = await stored();
    const response = await send('PUT', '/api/providers/' + providerId, write({baseUrl: ORIGIN + '/api/v2', name: 'Moved path'}));
    expect(response.status).toBe(200);
    const after = await stored();
    expect(after).toMatchObject({baseUrl: ORIGIN + '/api/v2', name: 'Moved path', encryptedAuthSecret: before.encryptedAuthSecret});
    expect(JSON.parse(after.defaultHeadersJson ?? '{}')).toEqual({'x-api-token': HEADER_SECRET, 'anthropic-version': '2023-06-01'});
    expect(JSON.stringify(await response.json())).not.toContain(HEADER_SECRET);
    expect(await audits('provider.update.denied')).toHaveLength(0);
  });

  it.each([
    ['another host', OTHER + '/v1'],
    ['another port', ORIGIN + ':8443/v1'],
    ['another scheme', 'http://provider.example.com/v1'],
  ])('refuses a move to %s without the secret, changes nothing and audits the attempt', async (_label, baseUrl) => {
    const before = await stored();
    const response = await send('PUT', '/api/providers/' + providerId, write({baseUrl, name: 'Must not apply', models: []}));
    const body = await expectRefused(response, providerWriteErrorCodes.originChangeRequiresSecret);
    expect(body.error).toMatch(/different server/); expect(body.error).toContain('the auth secret'); expect(body.error).toContain('x-api-token');
    expect(await stored()).toEqual(before);
    const denied = await audits('provider.update.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({entityId: providerId, adminUserId: user.id});
    expect(JSON.parse(denied[0]!.metadataJson ?? '{}')).toEqual({slug: 'fixture', kind: 'OPENAI_GENERIC', reason: providerWriteErrorCodes.originChangeRequiresSecret});
    expect(mapSecurityExportEvent(denied[0]!)).toMatchObject({outcome: 'failure', metadata: {slug: 'fixture', reason: providerWriteErrorCodes.originChangeRequiresSecret}});
    expect(await audits('provider.update')).toHaveLength(0);
  });

  it('refuses a move that supplies the secret but still relies on a stored credential header', async () => {
    const before = await stored();
    const response = await send('PUT', '/api/providers/' + providerId, write({baseUrl: OTHER + '/v1', authSecret: 'obviously-fake-new-credential'}));
    const body = await expectRefused(response, providerWriteErrorCodes.originChangeRequiresSecret);
    expect(body.error).toContain('x-api-token'); expect(body.error).not.toContain('the auth secret');
    expect(await stored()).toEqual(before);
  });

  it('refuses a move that supplies the header but not the secret', async () => {
    const before = await stored();
    const response = await send('PUT', '/api/providers/' + providerId, write({baseUrl: OTHER + '/v1', defaultHeaders: {'x-api-token': 'obviously-fake-new-header'}}));
    await expectRefused(response, providerWriteErrorCodes.originChangeRequiresSecret);
    expect(await stored()).toEqual(before);
  });

  it('applies a move when the secret and every credential header are supplied again', async () => {
    const response = await send('PUT', '/api/providers/' + providerId, write({baseUrl: OTHER + '/v1', authSecret: 'obviously-fake-new-credential',
      defaultHeaders: {'x-api-token': 'obviously-fake-new-header', 'anthropic-version': '2023-06-01'}}));
    expect(response.status).toBe(200);
    const after = await stored();
    expect(after.baseUrl).toBe(OTHER + '/v1');
    expect(decryptText(after.encryptedAuthSecret!)).toBe('obviously-fake-new-credential');
    expect(JSON.parse(after.defaultHeadersJson ?? '{}')).toEqual({'x-api-token': 'obviously-fake-new-header', 'anthropic-version': '2023-06-01'});
    const [event] = await audits('provider.update');
    expect(JSON.parse(event!.metadataJson ?? '{}')).toEqual({slug: 'fixture', kind: 'OPENAI_GENERIC', originChanged: true});
  });

  it('applies a move that drops the credential header and discards the secret with auth mode NONE', async () => {
    const response = await send('PUT', '/api/providers/' + providerId, write({baseUrl: OTHER + '/v1', authMode: 'NONE', defaultHeaders: {'anthropic-version': '2023-06-01'}}));
    expect(response.status).toBe(200);
    const after = await stored();
    expect(after).toMatchObject({baseUrl: OTHER + '/v1', encryptedAuthSecret: null, defaultHeadersJson: '{"anthropic-version":"2023-06-01"}'});
    expect(providerReadSchema.parse(((await response.json()) as {data: unknown}).data)).toMatchObject({hasAuthSecret: false, authSecretMasked: null, redactedDefaultHeaders: []});
    const [event] = await audits('provider.update');
    expect(JSON.parse(event!.metadataJson ?? '{}')).toMatchObject({originChanged: true, secretCleared: true});
  });

  it('keeps the stored secret when auth mode NONE is set without a move', async () => {
    const before = await stored();
    expect((await send('PUT', '/api/providers/' + providerId, write({authMode: 'NONE'}))).status).toBe(200);
    expect((await stored()).encryptedAuthSecret).toBe(before.encryptedAuthSecret);
  });

  it('never stores the stand-in: an unknown header sent as the stand-in is refused, on update and on create', async () => {
    const before = await stored();
    const update = await send('PUT', '/api/providers/' + providerId, write({defaultHeaders: {'x-unknown': providerRedactedValue}}));
    await expectRefused(update, providerWriteErrorCodes.redactedValueNotStored, 400);
    expect(await stored()).toEqual(before);
    const create = await send('POST', '/api/providers', write({slug: 'second', defaultHeaders: {'x-api-token': providerRedactedValue}}));
    await expectRefused(create, providerWriteErrorCodes.redactedValueNotStored, 400);
    expect(await prisma.provider.count()).toBe(1);
    expect(JSON.stringify(await prisma.provider.findMany())).not.toContain(providerRedactedValue);
  });

  it('matches a stand-in to its stored header whatever the letter case', async () => {
    expect((await send('PUT', '/api/providers/' + providerId, write({defaultHeaders: {'X-API-Token': providerRedactedValue}}))).status).toBe(200);
    expect(JSON.parse((await stored()).defaultHeadersJson ?? '{}')).toEqual({'X-API-Token': HEADER_SECRET});
  });

  it('refuses a base URL with a user name or password', async () => {
    const before = await stored();
    for (const send_ of [send('PUT', '/api/providers/' + providerId, write({baseUrl: 'https://operator:obviously-fake-url-password@provider.example.com/v1'})),
      send('POST', '/api/providers', write({slug: 'second', defaultHeaders: {}, baseUrl: 'https://operator@provider.example.com/v1'}))]) {
      const response = await send_; expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain('must not contain a user name or password');
    }
    expect(await stored()).toEqual(before);
  });

  it('requires an OAuth-authorized Codex provider to be authorized again instead of moved', async () => {
    const bundle = JSON.stringify({accessToken: 'obviously-fake-access-token', refreshToken: 'obviously-fake-refresh-token'});
    const codex = await prisma.provider.create({data: {slug: 'openai-codex', name: 'OpenAI Codex', kind: 'CODEX', baseUrl: 'https://chatgpt.com/backend-api/codex',
      encryptedAuthSecret: encryptText(bundle), defaultHeadersJson: '{"version":"hive-router"}'}, include: {models: true}});
    const body = {slug: 'openai-codex', name: 'OpenAI Codex', kind: 'CODEX', defaultHeaders: {version: 'hive-router'}, models: []};
    const moved = await send('PUT', '/api/providers/' + codex.id, {...body, baseUrl: OTHER + '/backend-api/codex'});
    const refusal = await expectRefused(moved, providerWriteErrorCodes.originChangeRequiresReauthorization);
    expect(refusal.error).toMatch(/authorize Codex again/); expect(refusal.error).not.toContain('obviously-fake');
    expect(await prisma.provider.findUniqueOrThrow({where: {id: codex.id}, include: {models: true}})).toEqual(codex);
    expect((await send('PUT', '/api/providers/' + codex.id, {...body, baseUrl: 'https://chatgpt.com/backend-api/codex/v2'})).status).toBe(200);
  });

  it('does not apply a check made against a record that another request changed meanwhile', async () => {
    // The request checks the record as it was (same origin, so the secret may stay) while another
    // write has already stored a different address and secret.
    const stale = await stored();
    const concurrent = await prisma.provider.update({where: {id: providerId}, data: {baseUrl: OTHER + '/v1', encryptedAuthSecret: encryptText('obviously-fake-concurrent-credential')}, include: {models: true}});
    const read = vi.spyOn(prisma.provider, 'findUnique').mockResolvedValueOnce(stale as never);
    try {
      const response = await send('PUT', '/api/providers/' + providerId, write({name: 'Stale write'}));
      await expectRefused(response, providerWriteErrorCodes.changedConcurrently, 409);
    } finally {read.mockRestore();}
    expect(await stored()).toEqual(concurrent);
  });

  it('edits a provider without stored credentials freely, including its origin', async () => {
    const open = await prisma.provider.create({data: {slug: 'open', name: 'Open', kind: 'LLAMACPP', baseUrl: 'http://127.0.0.1:8000', authMode: 'NONE'}});
    const response = await send('PUT', '/api/providers/' + open.id, {slug: 'open', name: 'Open', kind: 'LLAMACPP', baseUrl: 'http://127.0.0.1:9000', authMode: 'NONE'});
    expect(response.status).toBe(200);
    expect((await prisma.provider.findUniqueOrThrow({where: {id: open.id}})).baseUrl).toBe('http://127.0.0.1:9000');
    expect(await audits('provider.update.denied')).toHaveLength(0);
  });

  it('answers 404 for a provider that does not exist', async () => {
    expect((await send('PUT', '/api/providers/missing', write())).status).toBe(404);
  });
});

describe('POST /api/config/import', () => {
  const entry = (changes: Record<string, unknown> = {}) => ({slug: 'fixture', name: 'Fixture', kind: 'OPENAI_GENERIC', baseUrl: OTHER + '/v1', ...changes});

  it('refuses to move an existing provider with stored credentials, rolls back the whole archive and audits the attempt', async () => {
    const before = await stored();
    for (const provider of [entry(), entry({encryptedAuthSecret: before.encryptedAuthSecret}),
      entry({encryptedAuthSecret: null}), // discards the secret but still relies on the stored credential header
      entry({encryptedAuthSecret: null, defaultHeadersJson: JSON.stringify({'x-api-token': providerRedactedValue})})]) {
      await prisma.auditEvent.deleteMany();
      const response = await send('POST', '/api/config/import', {data: {providers: [{slug: 'unrelated', name: 'Unrelated', kind: 'OLLAMA', baseUrl: 'http://127.0.0.1:11434'}, provider],
        runtimeSettings: [{key: 'must.rollback', valueJson: '{}'}]}});
      await expectRefused(response, providerWriteErrorCodes.originChangeRequiresSecret);
      expect(await stored()).toEqual(before);
      expect(await prisma.provider.count()).toBe(1); expect(await prisma.runtimeSetting.count()).toBe(0);
      const denied = await audits('provider.update.denied');
      expect(denied).toHaveLength(1);
      expect(JSON.parse(denied[0]!.metadataJson ?? '{}')).toEqual({slug: 'fixture', kind: 'OPENAI_GENERIC', reason: providerWriteErrorCodes.originChangeRequiresSecret, via: 'config.import'});
      expect(await audits('config.import')).toHaveLength(0);
    }
  });

  it('moves an existing provider when the archive discards its secret and its credential headers', async () => {
    const response = await send('POST', '/api/config/import', {data: {providers: [entry({encryptedAuthSecret: null, defaultHeadersJson: '{"anthropic-version":"2023-06-01"}'})]}});
    expect(response.status).toBe(200);
    expect(await stored()).toMatchObject({baseUrl: OTHER + '/v1', encryptedAuthSecret: null, defaultHeadersJson: '{"anthropic-version":"2023-06-01"}'});
  });

  it('keeps stored credentials when an archive changes only the path', async () => {
    const before = await stored();
    expect((await send('POST', '/api/config/import', {data: {providers: [entry({baseUrl: ORIGIN + '/api/v2'})]}})).status).toBe(200);
    expect(await stored()).toMatchObject({baseUrl: ORIGIN + '/api/v2', encryptedAuthSecret: before.encryptedAuthSecret, defaultHeadersJson: before.defaultHeadersJson});
  });

  it('refuses an archive base URL with a user name or password', async () => {
    const response = await send('POST', '/api/config/import', {data: {providers: [entry({slug: 'second', baseUrl: 'https://operator:obviously-fake-url-password@provider.example.com/v1'})]}});
    expect(response.status).toBe(400);
  });
});
