import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scrypt = vi.hoisted(() => ({ sync: 0, async: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    scryptSync: (...args: Parameters<typeof actual.scryptSync>) => { scrypt.sync += 1; return actual.scryptSync(...args); },
    scrypt: (...args: Parameters<typeof actual.scrypt>) => { scrypt.async += 1; return actual.scrypt(...args); },
  };
});

import { requireApiKey } from '../../src/security/api-auth.js';
import { decryptText, encryptText, hashValue, verifyHash, verifyHashAsync } from '../../src/security/crypto.js';
import { prisma } from '../../src/storage/client.js';
import type { AppVariables } from '../../src/types/app.js';

const key = 'ep-synth-first-key-000000000000000000';
const sibling = 'ep-synth-other-key-000000000000000000';

describe('client API key verification', () => {
  let rows: Array<Record<string, unknown>>;
  const row = (raw: string, overrides: Record<string, unknown> = {}) => ({
    id: 'key-1', keyHash: hashValue(raw), keyPrefix: raw.slice(0, 8), enabled: true, expiresAt: null, metadataJson: '{}', ...overrides,
  });
  const request = (raw: string) => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.get('/v1/models', requireApiKey, (context) => context.json({ key: context.get('clientApiKey')?.id }));
    return app.request('/v1/models', { headers: { authorization: `Bearer ${raw}` } });
  };

  beforeEach(() => {
    rows = [row(key)];
    vi.spyOn(prisma.clientApiKey, 'findMany').mockImplementation((async () => rows) as never);
    vi.spyOn(prisma.clientApiKey, 'update').mockResolvedValue({} as never);
    scrypt.sync = 0;
    scrypt.async = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  it('never derives the stored hash on the event loop', async () => {
    expect((await request(key)).status).toBe(200);
    expect((await request(sibling)).status).toBe(401);
    expect(scrypt.sync).toBe(0);
    expect(scrypt.async).toBe(2);
  });

  it('accepts the matching key among several that share a prefix, and only that one', async () => {
    rows = [row(sibling, { id: 'key-other' }), row(key)];
    expect(await (await request(key)).json()).toEqual({ key: 'key-1' });
    expect(await (await request(sibling)).json()).toEqual({ key: 'key-other' });
    expect((await request(`${key}x`)).status).toBe(401);
  });

  it('applies rotation, disabling and scope changes on the next request', async () => {
    expect((await request(key)).status).toBe(200);

    rows = [row(sibling)];
    expect((await request(key)).status).toBe(401);
    expect((await request(sibling)).status).toBe(200);

    rows = [];
    expect((await request(sibling)).status).toBe(401);

    rows = [row(sibling, { metadataJson: JSON.stringify({ scopes: ['inference:write'] }) })];
    expect((await request(sibling)).status).toBe(403);
  });

  it('agrees with the synchronous verifier, including on malformed stored hashes', async () => {
    const stored = hashValue(key);
    for (const [value, hash] of [[key, stored], [sibling, stored], [key, 'no-separator'], [key, ':'], [key, `${stored.split(':')[0]}:abcd`]] as const) {
      expect(await verifyHashAsync(value, hash)).toBe(verifyHash(value, hash));
    }
    expect(await verifyHashAsync(key, stored)).toBe(true);
  });
});

describe('provider secret encryption cost', () => {
  it('derives the envelope key once for many secrets', () => {
    const first = encryptText('synthetic-provider-secret');
    scrypt.sync = 0;
    for (let index = 0; index < 5; index += 1) expect(decryptText(encryptText(`synthetic-${index}`))).toBe(`synthetic-${index}`);
    expect(decryptText(first)).toBe('synthetic-provider-secret');
    expect(scrypt.sync).toBe(0);
  });
});
