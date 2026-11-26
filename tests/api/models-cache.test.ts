// GET /v1/models keeps each provider's live model list for a few seconds.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'emberpath-models-cache-'));
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
const { clearLiveModelCache, createApiApp } = await import('../../src/api/app.js');
const { ProviderKind } = await import('../../src/generated/prisma/client.js');
const { loadEnv } = await import('../../src/config/env.js');

const MODELS = 'https://live.example/v1/models';
const clientKey = 'ep-models-0000000000000000000000001';
let providerId = '';
let liveCalls = 0;
const app = createApiApp();
const listModels = async () => {
  const response = await app.request('/v1/models', { headers: { authorization: `Bearer ${clientKey}` } });
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: Array<{ id: string; owned_by: string }> }).data.filter((entry) => entry.owned_by === 'live').map((entry) => entry.id);
};

beforeAll(async () => {
  await bootstrapStorage();
  await prisma.provider.updateMany({ data: { enabled: false } });
  providerId = (await prisma.provider.create({ data: buildProviderCreateData({
    slug: 'live', name: 'live', kind: ProviderKind.OPENAI_GENERIC, baseUrl: 'https://live.example/v1', maxRetries: 0, priority: 10,
  }) })).id;
  await prisma.clientApiKey.create({ data: { name: 'models', keyPrefix: clientKey.slice(0, 8), keyHash: hashValue(clientKey), metadataJson: '{}' } });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== MODELS) return realFetch(input, init);
    liveCalls += 1;
    return Response.json({ data: [{ id: `live-model-${liveCalls}` }] });
  });
});
beforeEach(() => {
  liveCalls = 0;
  clearLiveModelCache();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await prisma.$disconnect();
  globalThis.__hiveRouterPrisma = undefined;
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('GET /v1/models live model cache', () => {
  it('asks a provider once for calls within the TTL, including concurrent ones', async () => {
    const lists = await Promise.all([listModels(), listModels(), listModels()]);
    expect(await listModels()).toEqual(['live-model-1']);
    expect(lists.every((ids) => ids.join() === 'live-model-1')).toBe(true);
    expect(liveCalls).toBe(1);
  });

  it('asks again once the provider changed', async () => {
    await listModels();
    await prisma.provider.update({ where: { id: providerId }, data: { name: 'live renamed' } });
    expect(await listModels()).toEqual(['live-model-2']);
    expect(liveCalls).toBe(2);
  });

  it('asks every time when the TTL is 0', async () => {
    const env = loadEnv();
    const saved = env.EMBERPATH_MODELS_CACHE_TTL_MS;
    env.EMBERPATH_MODELS_CACHE_TTL_MS = 0;
    try {
      await listModels();
      await listModels();
      expect(liveCalls).toBe(2);
    } finally {
      env.EMBERPATH_MODELS_CACHE_TTL_MS = saved;
    }
  });
});
