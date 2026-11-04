import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables } from '../../src/types/app.js';
const identity = vi.hoisted(() => ({
  issuer: 'https://identity.example.com',
  subject: 'fake-user',
  sessionId: 'fake-session',
  displayName: 'Synthetic person',
  roles: ['SUPER_ADMIN'],
  permissions: ['router:providers:read'],
}));
vi.mock('../../src/security/oathweave.js', () => ({
  configuredOathweaveVerifier: () => async () => identity,
}));
import { requireAdminAuth } from '../../src/security/admin-auth.js';
import { prisma } from '../../src/storage/client.js';
const user = {
  id: 'existing-user',
  username: 'existing-operator',
  displayName: 'Existing operator',
  passwordHash: '!externally-managed',
  createdAt: new Date(),
  updatedAt: new Date(),
};
function app() {
  const result = new Hono<{ Variables: AppVariables }>();
  result.get('/api/test', requireAdminAuth, (c) =>
    c.json({
      id: c.get('adminUser')?.id,
      permissions: c.get('adminPermissions'),
    }),
  );
  return result;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('direct resource account binding', () => {
  it('retains the explicitly linked product ID and exact permissions without writes', async () => {
    vi.stubEnv(
      'EMBERPATH_OATHWEAVE_IDENTITIES_JSON',
      JSON.stringify([
        {
          issuer: identity.issuer,
          subject: identity.subject,
          localId: user.id,
        },
      ]),
    );
    vi.spyOn(prisma.adminUser, 'findUnique').mockResolvedValue(user);
    const create = vi.spyOn(prisma.adminUser, 'upsert');
    const response = await app().request('/api/test', {
      headers: { Authorization: 'Bearer obviously-fake-fixture' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: user.id,
      permissions: ['router:providers:read'],
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects unlinked and deleted accounts without falling back to legacy cookies', async () => {
    const lookup = vi
      .spyOn(prisma.adminUser, 'findUnique')
      .mockResolvedValue(null);
    vi.stubEnv('EMBERPATH_OATHWEAVE_IDENTITIES_JSON', '[]');
    const request = {
      headers: {
        Authorization: 'Bearer obviously-fake-fixture',
        Cookie: 'hive_router_admin=obviously-fake-cookie',
      },
    };
    expect((await app().request('/api/test', request)).status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
    vi.stubEnv(
      'EMBERPATH_OATHWEAVE_IDENTITIES_JSON',
      JSON.stringify([
        {
          issuer: identity.issuer,
          subject: identity.subject,
          localId: 'deleted-user',
        },
      ]),
    );
    expect((await app().request('/api/test', request)).status).toBe(401);
  });
});
