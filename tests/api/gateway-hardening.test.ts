// Routing denials, provider wait queues, upstream response headers and Ollama output
// limits, against a real SQLite fixture and the real API app with upstreams mocked at fetch.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-hardening-'));
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
const { getSemaphore, resetProviderCircuit } = await import('../../src/api/provider-guards.js');
const { loadEnv } = await import('../../src/config/env.js');

const PRIMARY = 'https://primary.example/v1/chat/completions';
const SECONDARY = 'https://secondary.example/v1/chat/completions';
const OLLAMA_CHAT = 'http://ollama.example:11434/api/chat';
const OLLAMA_TAGS = 'http://ollama.example:11434/api/tags';
const clientKey = 'ep-harden-000000000000000000000001';
const cappedKey = 'ep-capped-000000000000000000000001';

type Upstream = (init: RequestInit) => Response | Promise<Response>;
const upstreams = new Map<string, Upstream>();
const calls: string[] = [];
const providerIds: Record<'primary' | 'secondary' | 'ollama', string> = { primary: '', secondary: '', ollama: '' };

const app = createApiApp();
const post = (path: string, payload: Record<string, unknown>, key = clientKey) => app.request(path, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
const chat = (payload: Record<string, unknown> = {}) => post('/v1/chat/completions', { model: 'synthetic-model', messages: [{ role: 'user', content: 'hello' }], ...payload });
const completion = (text: string, headers: Record<string, string> = {}) => Response.json(
  { id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  { headers },
);

beforeAll(async () => {
  await bootstrapStorage();
  await prisma.provider.updateMany({ data: { enabled: false } });
  for (const [name, priority] of [['primary', 10], ['secondary', 20]] as const) {
    const provider = await prisma.provider.create({ data: buildProviderCreateData({
      slug: name, name, kind: ProviderKind.OPENAI_GENERIC, baseUrl: `https://${name}.example/v1`, maxRetries: 0, priority, concurrency: 1,
    }) });
    providerIds[name] = provider.id;
  }
  providerIds.ollama = (await prisma.provider.create({ data: buildProviderCreateData({
    slug: 'ollama', name: 'ollama', kind: ProviderKind.OLLAMA, baseUrl: 'http://ollama.example:11434', maxRetries: 0, priority: 30,
  }) })).id;
  await prisma.clientApiKey.create({ data: { name: 'hardening', keyPrefix: clientKey.slice(0, 8), keyHash: hashValue(clientKey), metadataJson: '{}' } });
  await prisma.clientApiKey.create({ data: { name: 'capped', keyPrefix: cappedKey.slice(0, 8), keyHash: hashValue(cappedKey), metadataJson: JSON.stringify({ quota: { dailyTokens: 1_000_000 } }) } });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const handler = upstreams.get(url);
    if (!handler) return realFetch(input, init);
    calls.push(url);
    return handler(init);
  });
});
afterEach(() => {
  upstreams.clear();
  calls.length = 0;
  for (const id of Object.values(providerIds)) resetProviderCircuit(id);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.$disconnect();
  globalThis.__hiveRouterPrisma = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('routing denials', () => {
  it('tell the client why, but keep the routing decision in the trace', async () => {
    const response = await post('/v1/traits/no-such-trait/chat/completions', { model: 'synthetic-model', messages: [] });
    expect(response.status).toBe(403);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ error: 'Routing trait "no-such-trait" was not found or is disabled.' });
    const trace = await prisma.trace.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
    expect(trace.outcome).toBe('DENIED');
    expect(trace.decisionJson).toContain('candidateProviderIds');
  });
});

describe('provider wait queue', () => {
  it('sends a request past a provider whose queue is full to the next candidate', async () => {
    const env = loadEnv();
    const saved = env.EMBERPATH_PROVIDER_QUEUE_MAX;
    env.EMBERPATH_PROVIDER_QUEUE_MAX = 1;
    const primary = await prisma.provider.findUniqueOrThrow({ where: { id: providerIds.primary } });
    const slots = getSemaphore({ id: primary.id, concurrency: primary.concurrency } as never);
    await slots.acquire();
    const queued = slots.acquire();
    try {
      upstreams.set(SECONDARY, () => completion('from secondary'));
      const response = await chat();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'from secondary' } }] });
      expect(calls).toEqual([SECONDARY]);
      const trace = await prisma.trace.findFirstOrThrow({ orderBy: { startedAt: 'desc' }, include: { events: true } });
      expect(trace.events.map((event) => event.type)).toContain('provider.skipped');
    } finally {
      slots.release();
      await queued;
      slots.release();
      env.EMBERPATH_PROVIDER_QUEUE_MAX = saved;
    }
  });
});

describe('upstream response headers', () => {
  const upstreamHeaders = {
    server: 'upstream-server/1.0',
    'cf-ray': 'ray-1',
    'openai-organization': 'org-synthetic',
    'x-request-id': 'upstream-req-1',
    'x-ratelimit-remaining-requests': '42',
    'retry-after': '3',
    'set-cookie': 'session=synthetic',
  };

  it('relay only allowed headers, with the upstream request ID and rate limits renamed', async () => {
    upstreams.set(PRIMARY, () => completion('ok', upstreamHeaders));
    const response = await chat();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('retry-after')).toBe('3');
    expect(response.headers.get('x-emberpath-upstream-request-id')).toBe('upstream-req-1');
    expect(response.headers.get('x-emberpath-upstream-ratelimit-remaining-requests')).toBe('42');
    for (const name of ['server', 'cf-ray', 'openai-organization', 'x-ratelimit-remaining-requests', 'set-cookie']) {
      expect(response.headers.get(name), name).toBeNull();
    }
    // The request ID the client sees is Emberpath's own.
    expect(response.headers.get('x-request-id')).not.toBe('upstream-req-1');
    const trace = await prisma.trace.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
    expect(JSON.parse(trace.responseHeadersJson ?? '{}')).toMatchObject({ server: 'upstream-server/1.0', 'cf-ray': 'ray-1', 'set-cookie': '[redacted]' });
  });

  it('relay every header but cookies in passthrough mode', async () => {
    const env = loadEnv();
    env.EMBERPATH_UPSTREAM_RESPONSE_HEADERS = 'passthrough';
    try {
      upstreams.set(PRIMARY, () => completion('ok', upstreamHeaders));
      const response = await chat();
      expect(response.headers.get('server')).toBe('upstream-server/1.0');
      expect(response.headers.get('openai-organization')).toBe('org-synthetic');
      expect(response.headers.get('set-cookie')).toBeNull();
    } finally {
      env.EMBERPATH_UPSTREAM_RESPONSE_HEADERS = 'allowlist';
    }
  });

  it('relay extra allowed headers as they are', async () => {
    const env = loadEnv();
    env.EMBERPATH_UPSTREAM_RESPONSE_HEADER_ALLOW = 'CF-Ray, bad header';
    try {
      upstreams.set(PRIMARY, () => completion('ok', upstreamHeaders));
      const response = await chat();
      expect(response.headers.get('cf-ray')).toBe('ray-1');
      expect(response.headers.get('server')).toBeNull();
    } finally {
      env.EMBERPATH_UPSTREAM_RESPONSE_HEADER_ALLOW = '';
    }
  });
});

describe('Ollama native output limits under token budgets', () => {
  const ollamaAnswer = () => Response.json({ model: 'llama', message: { role: 'assistant', content: 'hi' }, done: true, prompt_eval_count: 3, eval_count: 2 });

  it('accept options.num_predict as the explicit maximum', async () => {
    upstreams.set(OLLAMA_CHAT, ollamaAnswer);
    const response = await post('/api/chat', { model: 'llama', messages: [{ role: 'user', content: 'hi' }], stream: false, options: { num_predict: 64 } }, cappedKey);
    expect(response.status).toBe(200);
    expect(calls).toEqual([OLLAMA_CHAT]);
  });

  it('still refuse a generation without a bounded maximum', async () => {
    for (const options of [undefined, { num_predict: -1 }, { num_predict: 0 }]) {
      const response = await post('/api/chat', { model: 'llama', messages: [{ role: 'user', content: 'hi' }], stream: false, ...(options ? { options } : {}) }, cappedKey);
      expect(response.status, JSON.stringify(options)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('let routes that generate nothing through without a maximum', async () => {
    upstreams.set(OLLAMA_TAGS, () => Response.json({ models: [] }));
    const response = await app.request('/api/tags', { headers: { authorization: `Bearer ${cappedKey}` } });
    expect(response.status).toBe(200);
    expect(calls).toEqual([OLLAMA_TAGS]);
  });
});
