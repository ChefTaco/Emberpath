import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scrypt = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, scryptSync: (...args: Parameters<typeof actual.scryptSync>) => { scrypt.calls += 1; return actual.scryptSync(...args); } };
});

import { clearVerifiedClientKeys, requireApiKey } from '../../src/security/api-auth.js';
import { decryptText, encryptText, hashValue } from '../../src/security/crypto.js';
import { prisma } from '../../src/storage/client.js';
import type { AppVariables } from '../../src/types/app.js';

const key = 'ep-synth-first-key-000000000000000000';
const sibling = 'ep-synth-other-key-000000000000000000';

describe('client API key verification cost', () => {
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
    clearVerifiedClientKeys();
    rows = [row(key)];
    vi.spyOn(prisma.clientApiKey, 'findMany').mockImplementation((async () => rows) as never);
    vi.spyOn(prisma.clientApiKey, 'update').mockResolvedValue({} as never);
    scrypt.calls = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  it('derives the stored hash once per key, not once per request', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await request(key)).status).toBe(200);
    expect(scrypt.calls).toBe(1);
  });

  it('still rejects a different key that shares the prefix, before and after the first success', async () => {
    expect((await request(sibling)).status).toBe(401);
    expect((await request(key)).status).toBe(200);
    expect((await request(sibling)).status).toBe(401);
    expect((await request(`${key}x`)).status).toBe(401);
  });

  it('does not remember a failed verification as a success', async () => {
    expect((await request(sibling)).status).toBe(401);
    expect((await request(sibling)).status).toBe(401);
    expect(scrypt.calls).toBe(2);
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
});

describe('provider secret encryption cost', () => {
  it('derives the envelope key once for many secrets', () => {
    const first = encryptText('synthetic-provider-secret');
    scrypt.calls = 0;
    for (let index = 0; index < 5; index += 1) expect(decryptText(encryptText(`synthetic-${index}`))).toBe(`synthetic-${index}`);
    expect(decryptText(first)).toBe('synthetic-provider-secret');
    expect(scrypt.calls).toBe(0);
  });
});
