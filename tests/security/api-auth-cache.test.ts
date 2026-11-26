import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const verifyCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/security/crypto.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/security/crypto.js')>();
  return {
    ...original,
    verifyHashAsync: async (value: string, stored: string) => {
      verifyCalls.count += 1;
      return original.verifyHashAsync(value, stored);
    },
  };
});

const { lastUsedWrites, requireApiKey, verifiedKeys } = await import('../../src/security/api-auth.js');
const { hashValue } = await import('../../src/security/crypto.js');
const { prisma } = await import('../../src/storage/client.js');
const { loadEnv } = await import('../../src/config/env.js');
type Variables = import('../../src/types/app.js').AppVariables;

const key = 'ep-cache-test-0000000000000000000000';
const storedHash = hashValue(key);
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'key-cache', keyHash: storedHash, keyPrefix: key.slice(0, 8), enabled: true, expiresAt: null, metadataJson: '{}', ...overrides,
});

const app = new Hono<{ Variables: Variables }>();
app.get('/v1/models', requireApiKey, (context) => context.json({ data: [] }));
const call = () => app.request('/v1/models', { headers: { authorization: `Bearer ${key}` } });

describe('client API key check cache', () => {
  let rows: unknown[] = [];
  beforeEach(() => {
    verifyCalls.count = 0;
    verifiedKeys.clear();
    lastUsedWrites.clear();
    rows = [row()];
    vi.spyOn(prisma.clientApiKey, 'findMany').mockImplementation((() => Promise.resolve(rows)) as never);
    vi.spyOn(prisma.clientApiKey, 'update').mockResolvedValue({} as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it('runs the slow hash check once for repeated requests with the same key', async () => {
    for (let index = 0; index < 3; index += 1) expect((await call()).status).toBe(200);
    expect(verifyCalls.count).toBe(1);
  });

  it('stops matching at once when the key is disabled, deleted or rotated', async () => {
    expect((await call()).status).toBe(200);
    rows = [];
    expect((await call()).status).toBe(401);
    rows = [row({ keyHash: hashValue('ep-cache-test-rotated-000000000000') })];
    expect((await call()).status).toBe(401);
  });

  it('can be turned off', async () => {
    const env = loadEnv();
    const saved = env.EMBERPATH_API_KEY_CACHE_TTL_MS;
    env.EMBERPATH_API_KEY_CACHE_TTL_MS = 0;
    try {
      await call();
      await call();
      expect(verifyCalls.count).toBe(2);
    } finally {
      env.EMBERPATH_API_KEY_CACHE_TTL_MS = saved;
    }
  });

  it('expires remembered keys after the TTL', () => {
    verifiedKeys.remember('digest', { id: 'a', keyHash: 'h' }, 1_000);
    expect(verifiedKeys.recall('digest', 1_000 + 59_999)).toBeDefined();
    expect(verifiedKeys.recall('digest', 1_000 + 60_000)).toBeUndefined();
  });

  it('writes lastUsedAt at most once a minute per key', async () => {
    await call();
    await call();
    expect(prisma.clientApiKey.update).toHaveBeenCalledTimes(1);
    expect(lastUsedWrites.due('key-cache', Date.now() + 60_000)).toBe(true);
  });

  it('writes lastUsedAt on every request when the interval is 0', async () => {
    const env = loadEnv();
    const saved = env.EMBERPATH_KEY_LAST_USED_INTERVAL_MS;
    env.EMBERPATH_KEY_LAST_USED_INTERVAL_MS = 0;
    try {
      await call();
      await call();
      expect(prisma.clientApiKey.update).toHaveBeenCalledTimes(2);
    } finally {
      env.EMBERPATH_KEY_LAST_USED_INTERVAL_MS = saved;
    }
  });
});
