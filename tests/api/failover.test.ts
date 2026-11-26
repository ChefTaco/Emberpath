// Failover behaviour of the inference routes against a real SQLite fixture and
// the real API app, with both upstream providers mocked at fetch.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-failover-'));
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
const { getSemaphore, isCircuitOpen, resetProviderCircuit } = await import('../../src/api/provider-guards.js');
const { quotaLedger } = await import('../../src/security/quota.js');

const PRIMARY = 'https://primary.example/v1/chat/completions';
const SECONDARY = 'https://secondary.example/v1/chat/completions';
const clientKey = 'ep-failover-00000000000000000000001';
const budgetKey = 'ep-budget-0000000000000000000000001';
let budgetKeyId = '';

type Upstream = (init: RequestInit) => Response | Promise<Response>;
const upstreams = new Map<string, Upstream>();
const calls: string[] = [];
const providerIds: Record<'primary' | 'secondary', string> = { primary: '', secondary: '' };

const app = createApiApp();
const chat = (payload: Record<string, unknown> = {}, signal?: AbortSignal) => app.request('/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'synthetic-model', messages: [{ role: 'user', content: 'hello' }], ...payload }),
  ...(signal ? { signal } : {}),
});
const completion = (text: string) => Response.json({ id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

/** A response body that records whether the router released it. */
function trackedBody(text: string): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(text)); },
    cancel() { cancelled = true; },
  });
  return { stream, cancelled: () => cancelled };
}

beforeAll(async () => {
  await bootstrapStorage();
  await prisma.provider.updateMany({ data: { enabled: false } });
  for (const [name, priority] of [['primary', 10], ['secondary', 20]] as const) {
    const provider = await prisma.provider.create({ data: buildProviderCreateData({
      slug: name, name, kind: ProviderKind.OPENAI_GENERIC, baseUrl: `https://${name}.example/v1`, maxRetries: 0, priority,
    }) });
    providerIds[name] = provider.id;
  }
  await prisma.clientApiKey.create({ data: { name: 'failover', keyPrefix: clientKey.slice(0, 8), keyHash: hashValue(clientKey), metadataJson: '{}' } });
  budgetKeyId = (await prisma.clientApiKey.create({ data: { name: 'budget', keyPrefix: budgetKey.slice(0, 8), keyHash: hashValue(budgetKey), metadataJson: JSON.stringify({ quota: { dailyTokens: 1_000_000 } }) } })).id;
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

describe('failover', () => {
  it('fails over on a retryable status and releases the abandoned upstream response', async () => {
    const failed = trackedBody('{"error":"overloaded"}');
    upstreams.set(PRIMARY, () => new Response(failed.stream, { status: 503, headers: { 'content-type': 'text/plain' } }));
    upstreams.set(SECONDARY, () => completion('from secondary'));

    const response = await chat();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'from secondary' } }] });
    expect(calls).toEqual([PRIMARY, SECONDARY]);
    expect(failed.cancelled()).toBe(true);
  });

  it('answers with the last upstream failure when every provider fails', async () => {
    const first = trackedBody('first failure');
    upstreams.set(PRIMARY, () => new Response(first.stream, { status: 500 }));
    upstreams.set(SECONDARY, () => new Response('second failure', { status: 429 }));

    const response = await chat();

    expect(response.status).toBe(429);
    expect(first.cancelled()).toBe(true);
    const trace = await prisma.trace.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
    expect(trace).toMatchObject({ outcome: 'FAILED', statusCode: 429 });
  });

  it('releases a stream that failed before its first token when it fails over', async () => {
    const failed = trackedBody('event: error\ndata: {"error":{"message":"overloaded"}}\n\n');
    upstreams.set(PRIMARY, () => new Response(failed.stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    upstreams.set(SECONDARY, () => new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const response = await chat({ stream: true });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"content":"ok"');
    expect(calls).toEqual([PRIMARY, SECONDARY]);
    expect(failed.cancelled()).toBe(true);
  });
});

describe('client disconnects', () => {
  const untilAborted: Upstream = (init) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!;
    const fail = () => reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });

  it('do not count against a provider or spill over to the next one', async () => {
    upstreams.set(PRIMARY, untilAborted);
    upstreams.set(SECONDARY, () => completion('from secondary'));

    // Three provider failures open a circuit; three impatient callers must not.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const pending = chat({}, controller.signal);
      await vi.waitFor(() => expect(calls.length).toBe(attempt + 1));
      controller.abort();
      const response = await pending;
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Client disconnected before a provider responded' });
    }

    expect(calls).toEqual([PRIMARY, PRIMARY, PRIMARY]);
    expect(isCircuitOpen(providerIds.primary)).toBe(false);
    expect(isCircuitOpen(providerIds.secondary)).toBe(false);

    upstreams.set(PRIMARY, () => completion('from primary'));
    const response = await chat();
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'from primary' } }] });
  });

  it('still open the circuit for genuine provider failures', async () => {
    upstreams.set(PRIMARY, () => { throw new TypeError('fetch failed'); });
    upstreams.set(SECONDARY, () => completion('from secondary'));

    for (let attempt = 0; attempt < 3; attempt += 1) expect((await chat()).status).toBe(200);

    expect(isCircuitOpen(providerIds.primary)).toBe(true);
  });
});

describe('provider slots and budgets', () => {
  it('holds the provider slot until a stream has been fully relayed', async () => {
    const encoder = new TextEncoder();
    let push!: (text: string | null) => void;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (text) => (text === null ? controller.close() : controller.enqueue(encoder.encode(text)));
      },
    });
    upstreams.set(PRIMARY, () => new Response(upstream, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const slots = getSemaphore({ id: providerIds.primary, concurrency: 1 } as never);

    push('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    const response = await chat({ stream: true });
    const reader = response.body!.getReader();
    await reader.read();
    expect(slots.stats.active).toBe(1);

    push('data: [DONE]\n\n');
    push(null);
    while (!(await reader.read()).done) { /* drain */ }
    expect(slots.stats.active).toBe(0);
  });

  it('gives the slot back when the client abandons a stream', async () => {
    upstreams.set(PRIMARY, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const slots = getSemaphore({ id: providerIds.primary, concurrency: 1 } as never);

    const response = await chat({ stream: true });
    const reader = response.body!.getReader();
    await reader.read();
    expect(slots.stats.active).toBe(1);
    await reader.cancel();
    expect(slots.stats.active).toBe(0);
  });

  it('does not charge the token budget when every provider fails', async () => {
    upstreams.set(PRIMARY, () => new Response('overloaded', { status: 503 }));
    upstreams.set(SECONDARY, () => new Response('overloaded', { status: 503 }));

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${budgetKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'synthetic-model', max_tokens: 500, messages: [{ role: 'user', content: 'hello' }] }),
    });

    expect(response.status).toBe(503);
    expect(quotaLedger().usage(budgetKeyId)).toMatchObject({ dayRequests: 1, dayTokens: 0 });
  });
});
