// The optional exact-match response cache, against a real SQLite fixture and the real API app.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-response-cache-'));
vi.stubEnv('DATABASE_URL', 'file:' + join(directory, 'router.db'));
vi.stubEnv('HIVE_HOME', directory);
vi.stubEnv('DATA_DIR', directory);
vi.stubEnv('TRACE_DIR', join(directory, 'traces'));
vi.stubEnv('HIVE_ROUTER_SECRET', randomBytes(48).toString('hex'));

const { ensureSqliteSchema } = await import('../../src/storage/schema.js');
await ensureSqliteSchema();
const { prisma } = await import('../../src/storage/client.js');
const { bootstrapStorage } = await import('../../src/storage/bootstrap.js');
const { buildProviderCreateData } = await import('../../src/providers/runtime.js');
const { hashValue } = await import('../../src/security/crypto.js');
const { createApiApp } = await import('../../src/api/app.js');
const { ProviderKind } = await import('../../src/generated/prisma/client.js');
const { resetProviderCircuit } = await import('../../src/api/provider-guards.js');
const { loadEnv } = await import('../../src/config/env.js');
const { quotaLedger } = await import('../../src/security/quota.js');
const { clearResponseCache, lookupCachedResponse, responseCacheStats, storeCachedResponse } = await import('../../src/api/response-cache.js');

const CHAT = 'https://cache.example/v1/chat/completions';
const EMBEDDINGS = 'https://cache.example/v1/embeddings';
const keys = { a: 'ep-cache-a-0000000000000000000000001', b: 'ep-cache-b-0000000000000000000000001' };
const keyIds: Record<string, string> = {};
let providerId = '';
let upstreamCalls = 0;
let upstreamStatus = 200;

const app = createApiApp();
const post = (path: string, payload: Record<string, unknown>, key = keys.a, headers: Record<string, string> = {}) => app.request(path, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
  body: JSON.stringify(payload),
});
const chat = (payload: Record<string, unknown> = {}, key = keys.a, headers: Record<string, string> = {}) => post('/v1/chat/completions', { model: 'synthetic-model', temperature: 0, max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], ...payload }, key, headers);

beforeAll(async () => {
  await bootstrapStorage();
  await prisma.provider.updateMany({ data: { enabled: false } });
  providerId = (await prisma.provider.create({ data: buildProviderCreateData({
    slug: 'cache', name: 'cache', kind: ProviderKind.OPENAI_GENERIC, baseUrl: 'https://cache.example/v1', maxRetries: 0, priority: 10,
  }) })).id;
  for (const [name, key] of Object.entries(keys)) {
    keyIds[name] = (await prisma.clientApiKey.create({ data: { name, keyPrefix: key.slice(0, 8), keyHash: hashValue(key), metadataJson: JSON.stringify({ quota: { dailyTokens: 1_000_000 } }) } })).id;
  }
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== CHAT && url !== EMBEDDINGS) return realFetch(input, init);
    upstreamCalls += 1;
    if (upstreamStatus !== 200) return new Response('{"error":"bad"}', { status: upstreamStatus, headers: { 'content-type': 'application/json' } });
    return url === EMBEDDINGS
      ? Response.json({ object: 'list', data: [{ embedding: [upstreamCalls] }], usage: { prompt_tokens: 3, total_tokens: 3 } })
      : Response.json({ id: `chatcmpl-${upstreamCalls}`, choices: [{ message: { role: 'assistant', content: `answer ${upstreamCalls}` } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
  });
});
beforeEach(() => {
  loadEnv().EMBERPATH_RESPONSE_CACHE_TTL_MS = 60_000;
  clearResponseCache();
  upstreamCalls = 0;
  upstreamStatus = 200;
});
afterEach(() => {
  loadEnv().EMBERPATH_RESPONSE_CACHE_TTL_MS = 0;
  resetProviderCircuit(providerId);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.$disconnect();
  globalThis.__hiveRouterPrisma = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('response cache', () => {
  it('answers a repeated temperature-0 request from the cache, attributed on the trace and not charged', async () => {
    const first = await chat();
    expect(first.headers.get('x-emberpath-cache')).toBe('miss');
    const firstBody = await first.text();
    const firstTrace = await prisma.trace.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
    const before = quotaLedger().usage(keyIds.a!);

    const second = await chat();
    expect(second.status).toBe(200);
    expect(second.headers.get('x-emberpath-cache')).toBe('hit');
    expect(second.headers.get('x-hive-retry')).toBe('none');
    expect(await second.text()).toBe(firstBody);
    expect(upstreamCalls).toBe(1);

    const hitTrace = await prisma.trace.findFirstOrThrow({ orderBy: { startedAt: 'desc' }, include: { events: true } });
    expect(hitTrace.id).not.toBe(firstTrace.id);
    expect(hitTrace).toMatchObject({ outcome: 'SUCCEEDED', providerId: null, statusCode: 200 });
    expect(JSON.parse(hitTrace.responseMetaJson ?? '{}')).toMatchObject({ cache: { hit: true, sourceTraceId: firstTrace.id, providerId } });
    expect(hitTrace.events.map((event) => event.type)).toContain('cache.hit');
    const after = quotaLedger().usage(keyIds.a!);
    expect(after.dayRequests).toBe(before.dayRequests + 1);
    expect(after.dayTokens).toBe(before.dayTokens);
  });

  it('keeps each client key apart', async () => {
    await chat();
    expect((await chat({}, keys.b)).headers.get('x-emberpath-cache')).toBe('miss');
    expect(upstreamCalls).toBe(2);
  });

  it('leaves non-deterministic, streaming and differently worded requests alone', async () => {
    await chat();
    const warm = await chat({ temperature: 0.7 });
    expect(warm.headers.get('x-emberpath-cache')).toBeNull();
    await chat({ messages: [{ role: 'user', content: 'something else' }] });
    await chat({ n: 2 });
    expect(upstreamCalls).toBe(4);
  });

  it('honours no-cache and no-store from the client', async () => {
    await chat();
    expect((await chat({}, keys.a, { 'cache-control': 'no-cache' })).headers.get('x-emberpath-cache')).toBe('miss');
    clearResponseCache();
    expect((await chat({}, keys.a, { 'cache-control': 'no-store' })).headers.get('x-emberpath-cache')).toBeNull();
    // Nothing was stored for the no-store request.
    expect((await chat()).headers.get('x-emberpath-cache')).toBe('miss');
    expect(upstreamCalls).toBe(4);
  });

  it('does not keep failed answers', async () => {
    upstreamStatus = 400;
    expect((await chat()).status).toBe(400);
    upstreamStatus = 200;
    expect((await chat()).headers.get('x-emberpath-cache')).toBe('miss');
    expect(upstreamCalls).toBe(2);
  });

  it('caches embeddings', async () => {
    const payload = { model: 'synthetic-embed', input: 'hello' };
    await post('/v1/embeddings', payload);
    expect((await post('/v1/embeddings', payload)).headers.get('x-emberpath-cache')).toBe('hit');
    expect(upstreamCalls).toBe(1);
  });

  it('is off by default', async () => {
    loadEnv().EMBERPATH_RESPONSE_CACHE_TTL_MS = 0;
    expect((await chat()).headers.get('x-emberpath-cache')).toBeNull();
    await chat();
    expect(upstreamCalls).toBe(2);
  });

  it('expires entries and evicts the least recently used beyond the entry limit', () => {
    const env = loadEnv();
    const saved = env.EMBERPATH_RESPONSE_CACHE_MAX_ENTRIES;
    env.EMBERPATH_RESPONSE_CACHE_MAX_ENTRIES = 2;
    try {
      const entry = { status: 200, headers: [['content-type', 'application/json']] as Array<[string, string]>, body: '{}', estimatedUsage: false, providerId: 'p', providerKind: 'OPENAI_GENERIC', sourceTraceId: 't' };
      storeCachedResponse('one', entry, 0);
      storeCachedResponse('two', entry, 0);
      expect(lookupCachedResponse('one', 1)).toBeDefined();
      storeCachedResponse('three', entry, 2);
      expect(lookupCachedResponse('two', 3)).toBeUndefined();
      expect(lookupCachedResponse('one', 3)).toBeDefined();
      expect(responseCacheStats().entries).toBe(2);
      expect(lookupCachedResponse('three', 60_002)).toBeUndefined();
      expect(storeCachedResponse('html', { ...entry, headers: [['content-type', 'text/html']] }, 0)).toBe(false);
    } finally {
      env.EMBERPATH_RESPONSE_CACHE_MAX_ENTRIES = saved;
    }
  });
});
