import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireApiKey } from '../../src/security/api-auth.js';
import { hashValue } from '../../src/security/crypto.js';
import { prisma } from '../../src/storage/client.js';
import type { AppVariables } from '../../src/types/app.js';

const key = 'dummy-api-key';
const now = Date.parse('2026-01-01T12:00:00Z');

describe('client API key metadata expiry', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(prisma.clientApiKey, 'update').mockResolvedValue({} as never);
  });
  afterEach(() => vi.restoreAllMocks());

  async function request(metadata: object) {
    vi.spyOn(prisma.clientApiKey, 'findMany').mockResolvedValue([{
      id: 'key-1', keyHash: hashValue(key), keyPrefix: key.slice(0, 8), enabled: true,
      expiresAt: null, metadataJson: JSON.stringify(metadata),
    }] as never);
    const app = new Hono<{ Variables: AppVariables }>();
    app.get('/v1/models', requireApiKey, (context) => context.json({ data: [] }));
    return app.request('/v1/models', { headers: { authorization: `Bearer ${key}` } });
  }

  it.each([
    ['2026-01-01T11:59:59Z'],
    ['2026-01-01T12:00:00Z'],
    ['invalid'],
    [0],
    [null],
  ])('rejects expired or malformed metadata expiry %s even when the database column is empty', async (expiresAt) => {
    expect((await request({ expiresAt })).status).toBe(401);
    expect(prisma.clientApiKey.update).not.toHaveBeenCalled();
  });

  it.each([{}, { expiresAt: '2026-01-01T12:00:01Z' }])('accepts an unexpired key %j', async (metadata) => {
    expect((await request(metadata)).status).toBe(200);
  });

  it('preserves scope restrictions for unexpired keys', async () => {
    expect((await request({ expiresAt: '2026-01-01T12:00:01Z', scopes: ['inference:write'] })).status).toBe(403);
  });
});
