import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The deprecated password sign-in, explicitly opted in (it is off by default).
vi.stubEnv('EMBERPATH_PASSWORD_RELAY', 'true');
vi.stubEnv('HIVE_ROUTER_AUTH_MODE', 'iam-oidc');
vi.stubEnv('HIVE_ROUTER_IAM_CLIENT_SECRET', 'fake-router-client-secret-0123456789');

const authenticateIamOidcUser = vi.fn();
vi.mock('../../src/security/iam-oidc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/security/iam-oidc.js')>()),
  authenticateIamOidcUser,
}));

const { createAdminApp } = await import('../../src/admin/app.js');
const app = createAdminApp();
const login = (body: Record<string, unknown>) => app.request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('admin sign-in with an Oathweave multi-factor account', () => {
  beforeEach(() => authenticateIamOidcUser.mockReset());
  afterAll(() => vi.unstubAllEnvs());

  it('answers MFA_REQUIRED instead of invalid credentials, and passes the code on', async () => {
    authenticateIamOidcUser.mockResolvedValue({ mfaRequired: true, methods: ['totp'] });

    const response = await login({ username: 'admin', password: 'correct-password' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'MFA_REQUIRED', code: 'MFA_REQUIRED', methods: ['totp'] });

    await login({ username: 'admin', password: 'correct-password', mfaCode: ' 123456 ' });
    expect(authenticateIamOidcUser).toHaveBeenLastCalledWith('admin', 'correct-password', expect.anything(), expect.objectContaining({ mfaCode: '123456' }));
  });

  it('does not count a correct password that awaits its second factor as a failed attempt', async () => {
    authenticateIamOidcUser.mockResolvedValue({ mfaRequired: true, methods: ['totp'] });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await login({ username: 'admin', password: 'correct-password' })).status).toBe(401);
    }
    authenticateIamOidcUser.mockResolvedValue(null);
    const response = await login({ username: 'admin', password: 'wrong-password' });
    expect(await response.json()).toEqual({ error: 'Invalid credentials' });
  });

  it('does not reveal the challenge for an account outside the admin allowlist', async () => {
    authenticateIamOidcUser.mockResolvedValue({ mfaRequired: true, methods: ['totp'] });
    const response = await login({ username: 'someone-else', password: 'correct-password' });
    expect(await response.json()).toEqual({ error: 'Invalid credentials' });
  });
});

describe('the deprecated password sign-in, opted in with EMBERPATH_PASSWORD_RELAY=true', () => {
  afterAll(() => vi.restoreAllMocks());

  it('still signs in and re-authenticates, and says it is deprecated', async () => {
    const { prisma } = await import('../../src/storage/client.js');
    const user = { id: 'existing-user', username: 'admin', displayName: 'Existing operator', passwordHash: '!externally-managed', createdAt: new Date(), updatedAt: new Date() };
    const sessions = new Map<string, { sessionId: string; userId: string; createdAt: Date }>();
    vi.spyOn(prisma.adminUser, 'upsert').mockResolvedValue(user);
    vi.spyOn(prisma.auditEvent, 'create').mockResolvedValue({} as never);
    vi.spyOn(prisma.adminSession, 'create').mockImplementation((async ({ data }: { data: { sessionId: string; userId: string } }) => {
      sessions.set(data.sessionId, { ...data, createdAt: new Date() });
      return data;
    }) as never);
    vi.spyOn(prisma.adminSession, 'findFirst').mockImplementation((async ({ where }: { where: { sessionId: string } }) => {
      const session = sessions.get(where.sessionId);
      return session ? { ...session, user } : null;
    }) as never);
    vi.spyOn(prisma.adminSession, 'updateMany').mockResolvedValue({ count: 1 } as never);
    authenticateIamOidcUser.mockResolvedValue({ username: 'admin', displayName: 'Existing operator', roles: ['admin'], permissions: ['*'], subject: 'person-subject' });

    const signIn = await login({ username: 'admin', password: 'correct-password' });
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get('deprecation')).toMatch(/^@\d+$/);
    expect(signIn.headers.get('sunset')).toMatch(/GMT$/);
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(cookie).toMatch(/^hive_router_admin=/);

    const again = await app.request('/api/auth/reauthenticate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ password: 'correct-password' }),
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
    expect(again.headers.get('deprecation')).toMatch(/^@\d+$/);
  });
});
