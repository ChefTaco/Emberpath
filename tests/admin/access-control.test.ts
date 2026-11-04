import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { createAdminApp, createLoginThrottle, hiveMemProxyCookieHeader, normalizeAdminPath } from '../../src/admin/app.js';
import { prisma } from '../../src/storage/client.js';

async function sessionCookie(permissions: string[], roles: string[] = []): Promise<string> {
  const token = await new SignJWT({ sid: 'session-1', username: 'operator', roles, permissions, authMode: 'iam-oidc' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.HIVE_ROUTER_SECRET));
  return `hive_router_admin=${token}`;
}

function mockSession(): void {
  vi.spyOn(prisma.adminSession, 'findFirst').mockResolvedValue({
    id: 'row-1',
    sessionId: 'session-1',
    userId: 'user-1',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    ipAddress: null,
    userAgent: null,
    user: { id: 'user-1', username: 'operator', displayName: 'Operator', passwordHash: '!externally-managed', createdAt: new Date(), updatedAt: new Date() },
  } as never);
}

describe('admin path normalization', () => {
  it('decodes percent-encoded segments so permission matching sees the real path', () => {
    expect(normalizeAdminPath('/api/iam/%75sers')).toBe('/api/iam/users');
  });

  it('rejects encoded separators, dot segments, and malformed encodings', () => {
    expect(normalizeAdminPath('/api/iam/users%2f..%2froles')).toBeNull();
    expect(normalizeAdminPath('/api/iam/%2e%2e/config/export')).toBeNull();
    expect(normalizeAdminPath('/api/iam/%5cusers')).toBeNull();
    expect(normalizeAdminPath('/api//iam/users')).toBeNull();
    expect(normalizeAdminPath('/api/iam/%E0%A4%A')).toBeNull();
  });
});

describe('HiveMem proxy cookies', () => {
  it('drops the Router admin session cookie and keeps HiveMem dashboard cookies', () => {
    expect(hiveMemProxyCookieHeader('hive_router_admin=secret; hivemem_dash=abc; other=1')).toBe('hivemem_dash=abc');
    expect(hiveMemProxyCookieHeader('hive_router_admin=secret')).toBeUndefined();
    expect(hiveMemProxyCookieHeader(undefined)).toBeUndefined();
  });
});

describe('login throttle', () => {
  it('locks an account only for the failing client', () => {
    const throttle = createLoginThrottle({ accountLimit: 2, clientLimit: 100 });
    throttle.recordFailure('Admin', '198.51.100.1');
    throttle.recordFailure('admin', '198.51.100.1');
    expect(throttle.isLocked('admin', '198.51.100.1')).toBe(true);
    expect(throttle.isLocked('admin', '198.51.100.2')).toBe(false);
  });

  it('locks a client that sprays many usernames', () => {
    const throttle = createLoginThrottle({ accountLimit: 100, clientLimit: 3 });
    for (const user of ['a', 'b', 'c']) throttle.recordFailure(user, '198.51.100.9');
    expect(throttle.isLocked('d', '198.51.100.9')).toBe(true);
    expect(throttle.isLocked('d', '198.51.100.10')).toBe(false);
  });

  it('expires lockouts', () => {
    let now = 0;
    const throttle = createLoginThrottle({ accountLimit: 1, lockoutMs: 1_000, now: () => now });
    throttle.recordFailure('admin', '198.51.100.1');
    expect(throttle.isLocked('admin', '198.51.100.1')).toBe(true);
    now = 1_001;
    expect(throttle.isLocked('admin', '198.51.100.1')).toBe(false);
  });
});

describe('admin read access control', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forbids IAM reads without the matching read permission, including encoded paths', async () => {
    mockSession();
    const app = createAdminApp();
    const cookie = await sessionCookie(['router:providers:read']);
    for (const path of ['/api/iam/users', '/api/iam/%75sers']) {
      const response = await app.request(path, { headers: { cookie } });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ requiredPermission: 'iam:users:read' });
    }
    const encodedSeparator = await app.request('/api/iam/users%2f..%2fclients', { headers: { cookie } });
    expect(encodedSeparator.status).toBe(400);
  });

  it('requires settings write access for configuration export', async () => {
    mockSession();
    const app = createAdminApp();
    const response = await app.request('/api/config/export', { headers: { cookie: await sessionCookie(['router:settings:read']) } });
    expect(response.status).toBe(403);
  });

  it('never includes encrypted provider secrets in configuration export', async () => {
    mockSession();
    vi.spyOn(prisma.provider, 'findMany').mockResolvedValue([{ id: 'p1', slug: 'local', encryptedAuthSecret: 'ciphertext', models: [] }] as never);
    vi.spyOn(prisma.modelAlias, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.routeRule, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.heuristicRule, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.runtimeSetting, 'findMany').mockResolvedValue([]);
    const app = createAdminApp();
    const response = await app.request('/api/config/export', { headers: { cookie: await sessionCookie(['*']) } });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { providers: Array<Record<string, unknown>> } };
    expect(body.data.providers[0]).toMatchObject({ slug: 'local' });
    expect(body.data.providers[0]).not.toHaveProperty('encryptedAuthSecret');
    expect(JSON.stringify(body)).not.toContain('ciphertext');
  });
});
