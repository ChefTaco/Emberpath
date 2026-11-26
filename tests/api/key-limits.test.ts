// Per-key in-flight, per-minute and spend limits and model/provider allowlists, against a real
// SQLite fixture and the real API app with upstream providers mocked at fetch.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-key-limits-'));
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
const { keySlotsInUse } = await import('../../src/security/key-access.js');

const PRIMARY = 'https://primary.example/v1/chat/completions';
const SECONDARY = 'https://secondary.example/v1/chat/completions';
type Upstream = (init: RequestInit) => Response | Promise<Response>;
const upstreams = new Map<string, Upstream>();
const calls: string[] = [];
const providerIds: Record<'primary' | 'secondary', string> = { primary: '', secondary: '' };
const keyIds: Record<string, string> = {};

const app = createApiApp();
const keyFor = (name: string) => `ep-${name.padEnd(8, '-')}-limits-0000000000000000`;
const chat = (name: string, payload: Record<string, unknown> = {}) => app.request('/v1/chat/completions', {
  method: 'POST',
  headers: { authorization: `Bearer ${keyFor(name)}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'synthetic-model', messages: [{ role: 'user', content: 'hello' }], ...payload }),
});
const completion = (text: string) => Response.json({ id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } });

async function createKey(name: string, metadata: Record<string, unknown>): Promise<void> {
  const key = keyFor(name);
  keyIds[name] = (await prisma.clientApiKey.create({ data: { name, keyPrefix: key.slice(0, 8), keyHash: hashValue(key), metadataJson: JSON.stringify(metadata) } })).id;
}

beforeAll(async () => {
  await bootstrapStorage();
  await prisma.provider.updateMany({ data: { enabled: false } });
  for (const [name, priority] of [['primary', 10], ['secondary', 20]] as const) {
    providerIds[name] = (await prisma.provider.create({ data: {
      ...buildProviderCreateData({ slug: name, name, kind: ProviderKind.OPENAI_GENERIC, baseUrl: `https://${name}.example/v1`, maxRetries: 0, priority }),
      // $1 per million tokens in and out: one answer above costs $0.002.
      capabilityJson: JSON.stringify({ inputCostPerMillionTokens: 1, outputCostPerMillionTokens: 1 }),
    } })).id;
  }
  await createKey('inflight', { quota: { maxInFlight: 1 } });
  await createKey('rpm', { quota: { requestsPerMinute: 2 } });
  await createKey('budget', { quota: { dailyCostUsd: 0.003 } });
  await createKey('models', { allowedModels: ['synthetic-*'] });
  await createKey('provider', { allowedProviders: ['secondary'] });
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

describe('per-key in-flight limit', () => {
  it('refuses a second concurrent request until the first stream has ended', async () => {
    let close!: () => void;
    upstreams.set(PRIMARY, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
        close = () => controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const first = await chat('inflight', { stream: true });
    const reader = first.body!.getReader();
    await reader.read();
    expect(keySlotsInUse(keyIds.inflight!)).toBe(1);

    const refused = await chat('inflight');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('x-hive-quota-exceeded')).toBe('maxInFlight');

    close();
    while (!(await reader.read()).done) { /* drain */ }
    expect(keySlotsInUse(keyIds.inflight!)).toBe(0);
    upstreams.set(PRIMARY, () => completion('again'));
    expect((await chat('inflight')).status).toBe(200);
  });
});

describe('per-key rate limit', () => {
  it('answers 429 with a one-minute retry once the requests per minute are used', async () => {
    upstreams.set(PRIMARY, () => completion('ok'));
    expect((await chat('rpm')).status).toBe(200);
    expect((await chat('rpm')).status).toBe(200);
    const limited = await chat('rpm');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-hive-quota-exceeded')).toBe('requestsPerMinute');
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(calls).toHaveLength(2);
  });
});

describe('per-key USD budget', () => {
  it('stops the key once its declared-price spend reaches the daily budget', async () => {
    upstreams.set(PRIMARY, () => completion('ok'));
    expect((await chat('budget')).status).toBe(200);
    expect((await chat('budget')).status).toBe(200);
    // $0.004 spent of $0.003.
    const stopped = await chat('budget');
    expect(stopped.status).toBe(429);
    expect(stopped.headers.get('x-hive-quota-exceeded')).toBe('dailyCostUsd');
    const usage = await prisma.$queryRawUnsafe<Array<{ cost: number }>>('SELECT SUM(costUsd) AS cost FROM QuotaReservation WHERE clientApiKeyId=?', keyIds.budget);
    expect(usage[0]!.cost).toBeCloseTo(0.004);
  });
});

describe('per-key allowlists', () => {
  it('deny a model outside the key\'s list and allow a matching prefix', async () => {
    upstreams.set(PRIMARY, () => completion('ok'));
    expect((await chat('models')).status).toBe(200);
    const denied = await chat('models', { model: 'other-model' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'This client key may not use model "other-model"' });
    expect(calls).toEqual([PRIMARY]);
  });

  it('route only to allowed providers', async () => {
    upstreams.set(PRIMARY, () => completion('primary'));
    upstreams.set(SECONDARY, () => completion('secondary'));
    const response = await chat('provider');
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'secondary' } }] });
    expect(calls).toEqual([SECONDARY]);
  });

  it('filter /v1/models', async () => {
    await prisma.providerModel.createMany({ data: [
      { providerId: providerIds.primary, model: 'synthetic-model', capabilityJson: '{}' },
      { providerId: providerIds.primary, model: 'other-model', capabilityJson: '{}' },
      { providerId: providerIds.secondary, model: 'synthetic-second', capabilityJson: '{}' },
    ] });
    const list = async (name: string) => {
      const response = await app.request('/v1/models', { headers: { authorization: `Bearer ${keyFor(name)}` } });
      return ((await response.json()) as { data: Array<{ id: string; owned_by: string }> }).data.filter((entry) => entry.owned_by !== 'alias').map((entry) => `${entry.owned_by}/${entry.id}`).sort();
    };
    expect(await list('models')).toEqual(['primary/synthetic-model', 'secondary/synthetic-second']);
    expect(await list('provider')).toEqual(['secondary/synthetic-second']);
    expect(await list('rpm')).toEqual(['primary/other-model', 'primary/synthetic-model', 'secondary/synthetic-second']);
  });
});
