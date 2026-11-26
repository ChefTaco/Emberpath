// The admin sign-in throttle and the address forwarded to Oathweave follow the client behind
// a trusted proxy, and the socket peer otherwise.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('HIVE_ROUTER_AUTH_MODE', 'iam-oidc');
vi.stubEnv('HIVE_ROUTER_IAM_CLIENT_SECRET', 'fake-router-client-secret-0123456789');

const authenticateIamOidcUser = vi.fn();
vi.mock('../../src/security/iam-oidc.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/security/iam-oidc.js')>()),
  authenticateIamOidcUser,
}));

const { createAdminApp } = await import('../../src/admin/app.js');
const { loadEnv } = await import('../../src/config/env.js');
const app = createAdminApp();
const login = (peer: string, forwardedFor?: string, username = 'admin') => app.request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
  body: JSON.stringify({ username, password: 'wrong-password' }),
}, { incoming: { socket: { remoteAddress: peer } } });
const lastClientIp = () => (authenticateIamOidcUser.mock.lastCall?.[3] as { clientIp?: string } | undefined)?.clientIp;

describe('admin sign-in behind a proxy', () => {
  beforeEach(() => {
    authenticateIamOidcUser.mockReset();
    authenticateIamOidcUser.mockResolvedValue(null);
  });
  afterAll(() => vi.unstubAllEnvs());

  it('forwards the client named by a trusted proxy, not the caller-written part of the header', async () => {
    await login('127.0.0.1', '10.6.6.6, 203.0.113.10');
    expect(lastClientIp()).toBe('203.0.113.10');
  });

  it('forwards the socket peer when it is not trusted', async () => {
    await login('198.51.100.20', '203.0.113.11');
    expect(lastClientIp()).toBe('198.51.100.20');
  });

  it('throttles each client behind the proxy on its own', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) await login('127.0.0.1', '203.0.113.30', 'throttled');
    const locked = await login('127.0.0.1', '203.0.113.30', 'throttled');
    expect(locked.status).toBe(429);
    authenticateIamOidcUser.mockClear();
    const other = await login('127.0.0.1', '203.0.113.31', 'throttled');
    expect(other.status).toBe(401);
    expect(lastClientIp()).toBe('203.0.113.31');
  });

  it('ignores the header from every peer with none', async () => {
    const env = loadEnv();
    env.EMBERPATH_TRUSTED_PROXIES = 'none';
    try {
      await login('127.0.0.1', '203.0.113.12');
      expect(lastClientIp()).toBe('127.0.0.1');
    } finally {
      env.EMBERPATH_TRUSTED_PROXIES = 'loopback';
    }
  });
});
