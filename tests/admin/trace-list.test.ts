import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {SignJWT} from 'jose';
import * as contracts from '../../src/contracts/model-admin.js';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-trace-list-'));
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'fixture.db')); vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(48).toString('hex')); vi.stubEnv('HIVE_ROUTER_ADMIN_USERS', 'admin');
const {ensureSqliteSchema} = await import('../../src/storage/schema.js'); await ensureSqliteSchema();
const {prisma} = await import('../../src/storage/client.js');
const {createAdminApp, decodeTraceCursor, encodeTraceCursor} = await import('../../src/admin/app.js');
const app = createAdminApp();
afterAll(async () => {await prisma.$disconnect(); globalThis.__hiveRouterPrisma = undefined; vi.unstubAllEnvs(); rmSync(directory, {recursive: true, force: true});});

let cookie = '';
let keyA = '', keyB = '';
const base = Date.parse('2026-01-01T00:00:00.000Z');
const ids: string[] = [];

beforeAll(async () => {
  const user = await prisma.adminUser.create({data: {username: 'admin', passwordHash: 'obviously-fake-password-hash'}});
  await prisma.adminSession.create({data: {sessionId: 'fixture', userId: user.id, expiresAt: new Date(Date.now() + 600000)}});
  cookie = 'hive_router_admin=' + await new SignJWT({sid: 'fixture', username: 'admin', roles: [], permissions: ['router:admin:read'], authMode: 'iam-oidc'})
    .setProtectedHeader({alg: 'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode(process.env.HIVE_ROUTER_SECRET));
  keyA = (await prisma.clientApiKey.create({data: {name: 'Agent A key', keyPrefix: 'agentaaa', keyHash: 'synthetic-hash', metadataJson: '{"actorId":"agent-a"}'}})).id;
  keyB = (await prisma.clientApiKey.create({data: {name: 'Agent B key', keyPrefix: 'agentbbb', keyHash: 'synthetic-hash', metadataJson: '{"actorId":"agent-b"}'}})).id;
  // 130 traces: agent-a every other trace, agent-b on multiples of 3 (others), several sharing one timestamp.
  for (let index = 0; index < 130; index++) {
    const actor = index % 2 === 0 ? 'agent-a' : index % 3 === 0 ? 'agent-b' : null;
    const createdAt = new Date(base + Math.floor(index / 4) * 1000);
    const trace = await prisma.trace.create({data: {requestId: 'list-' + index, method: 'POST', path: '/v1/responses', endpointKind: 'v1.responses',
      routeKey: 'fixture', decisionJson: '{}', createdAt, startedAt: createdAt, actorId: actor,
      clientApiKeyId: actor === 'agent-a' ? keyA : actor === 'agent-b' ? keyB : null}});
    ids.push(trace.id);
  }
});

const get = (query = '') => app.request('/api/traces' + query, {headers: {cookie}});
type Row = {id: string; requestId: string; actorId?: string | null; createdAt: string; clientApiKeyId: string | null};

async function collect(query: string): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 50; pages++) {
    const response = await get(query + (cursor ? '&cursor=' + cursor : ''));
    expect(response.status).toBe(200);
    const body = contracts.tracePageSchema.parse(await response.json());
    rows.push(...(body.data as Row[]));
    cursor = body.nextCursor;
    if (!cursor) return rows;
  }
  throw new Error('pagination did not terminate');
}

function newestFirst(rows: Row[]): void {
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1]!, current = rows[index]!;
    expect(previous.createdAt > current.createdAt || (previous.createdAt === current.createdAt && previous.id > current.id)).toBe(true);
  }
}

describe('GET /api/traces', () => {
  it('keeps the original latest-100 {data} response when no new parameter is passed', async () => {
    for (const query of ['', '?unrelated=1']) {
      const response = await get(query);
      expect(response.status).toBe(200);
      const body = await response.json() as {data: Row[]};
      expect(Object.keys(body)).toEqual(['data']);
      contracts.modelConsoleSchemas.traces.parse(body);
      expect(body.data).toHaveLength(100);
      expect(body.data[0]!.createdAt).toBe(new Date(base + 32 * 1000).toISOString());
      expect(body.data[0]).toHaveProperty('events');
      expect(body.data[0]).toHaveProperty('provider');
      expect(body.data[0]).toHaveProperty('clientApiKey');
    }
  });

  it('pages newest-first through every trace with a stable opaque cursor', async () => {
    const rows = await collect('?limit=7');
    expect(rows.map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(new Set(rows.map((row) => row.id)).size).toBe(130);
    newestFirst(rows);
    const first = contracts.tracePageSchema.parse(await (await get('?limit=7')).json());
    expect(first.data).toHaveLength(7);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const again = contracts.tracePageSchema.parse(await (await get('?limit=7')).json());
    expect(again.nextCursor).toBe(first.nextCursor);
    const last = first.data.at(-1)! as Row;
    expect(decodeTraceCursor(first.nextCursor!)).toEqual({createdAt: new Date(last.createdAt), id: last.id});
  });

  it('defaults to 50 per page and caps limit at 200', async () => {
    const page = contracts.tracePageSchema.parse(await (await get('?since=2025-01-01T00:00:00Z')).json());
    expect(page.data).toHaveLength(contracts.traceListDefaultLimit);
    expect(page.nextCursor).not.toBeNull();
    const all = contracts.tracePageSchema.parse(await (await get('?limit=200')).json());
    expect(all.data).toHaveLength(130);
    expect(all.nextCursor).toBeNull();
    expect((await get('?limit=201')).status).toBe(400);
  });

  it('filters by actorId, clientKeyId and since, and includes actorId on rows', async () => {
    const agentA = await collect('?actorId=agent-a&limit=10');
    expect(agentA).toHaveLength(65);
    expect(agentA.every((row) => row.actorId === 'agent-a' && row.clientApiKeyId === keyA)).toBe(true);
    newestFirst(agentA);
    const byKey = await collect('?clientKeyId=' + keyB + '&limit=4');
    expect(byKey.length).toBeGreaterThan(0);
    expect(byKey.every((row) => row.actorId === 'agent-b')).toBe(true);
    expect(await collect('?actorId=agent-a&clientKeyId=' + keyB)).toEqual([]);
    expect(await collect('?actorId=unknown-agent')).toEqual([]);
    const since = new Date(base + 30 * 1000).toISOString();
    const recent = await collect('?since=' + since + '&limit=3');
    expect(recent).toHaveLength(10);
    expect(recent.every((row) => row.createdAt >= since)).toBe(true);
    const recentA = await collect('?actorId=agent-a&since=' + encodeURIComponent('2026-01-01T00:00:30+00:00'));
    expect(recentA.map((row) => row.requestId).sort()).toEqual(['list-120', 'list-122', 'list-124', 'list-126', 'list-128']);
  });

  it('rejects invalid parameters with the admin validation error format', async () => {
    const invalid = ['?actorId=', '?actorId=Bad%20Agent', '?actorId=' + 'x'.repeat(33), '?clientKeyId=', '?since=yesterday', '?since=2026-01-01',
      '?limit=0', '?limit=abc', '?limit=1.5', '?limit=', '?cursor=', '?cursor=not*base64', '?cursor=' + Buffer.from('garbage').toString('base64url'),
      '?cursor=' + Buffer.from(JSON.stringify(['not-a-date', 'id'])).toString('base64url'),
      '?cursor=' + Buffer.from(JSON.stringify(['2026-01-01T00:00:00.000Z', ''])).toString('base64url')];
    for (const query of invalid) {
      const response = await get(query);
      expect(response.status, query).toBe(400);
      const body = await response.json() as {error: string; issues: unknown[]};
      expect(body.error, query).toBe('Validation error');
      expect(Array.isArray(body.issues), query).toBe(true);
    }
    expect(encodeTraceCursor(new Date(base), 'id-1')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('still requires admin authentication', async () => {
    expect((await app.request('/api/traces?actorId=agent-a')).status).toBe(401);
  });
});
