import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
