import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminApp } from '../../src/admin/app.js';
import { prisma } from '../../src/storage/client.js';

describe('Security exporter exporter route authentication failures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an indistinguishable 401 for invalid credentials', async () => {
    const app = createAdminApp({
      authorizeSecurityExporterToken: async () => ({ status: 'invalid' }),
    });
    const response = await app.request('/api/security/events', {
      headers: { authorization: 'Bearer invalid.jwt.value' },
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(response.headers.get('retry-after')).toBeNull();
  });

  it('returns a bounded 503 with Retry-After for IAM/JWKS outages', async () => {
    const app = createAdminApp({
      authorizeSecurityExporterToken: async () => ({ status: 'unavailable' }),
    });
    const response = await app.request('/api/security/events', {
      headers: { authorization: 'Bearer valid.jwt.shape' },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      error: 'IAM authorization temporarily unavailable',
    });
  });

  it('reports explicitly enabled static migration fallback use', async () => {
    vi.spyOn(prisma.auditEvent, 'findMany').mockResolvedValue([]);
    const authorizeIam = vi.fn(async () => ({ status: 'invalid' as const }));
    const app = createAdminApp({
      authorizeSecurityExporterToken: authorizeIam,
      authorizeStaticSecurityExporterToken: () => true,
    });
    const response = await app.request('/api/security/events', {
      headers: { authorization: 'Bearer migration-token' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('warning')).toContain('deprecated');
    expect(authorizeIam).not.toHaveBeenCalled();
  });

  it('queries eligible actions before pagination and returns a dense page', async () => {
    const createdAt = new Date('2026-07-28T00:00:00.000Z');
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: `event-${index + 1}`,
      actorType: 'admin-user',
      adminUserId: null,
      action: 'auth.login',
      entityType: 'admin-session',
      entityId: null,
      metadataJson: JSON.stringify({ request: { password: 'secret' } }),
      createdAt,
    }));
    const findMany = vi.spyOn(prisma.auditEvent, 'findMany').mockResolvedValue(rows);
    const app = createAdminApp({
      authorizeSecurityExporterToken: async () => ({
        status: 'authorized',
        payload: {},
      }),
    });
    const response = await app.request('/api/security/events?limit=2&cursor=event-0', {
      headers: { authorization: 'Bearer valid.jwt.shape' },
    });
    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        action: { in: expect.arrayContaining(['auth.login', 'provider.update']) },
        id: { gt: 'event-0' },
      },
      take: 3,
    }));
    await expect(response.json()).resolves.toMatchObject({
      events: [{ id: 'event-1', metadata: null }, { id: 'event-2', metadata: null }],
      nextCursor: 'event-2',
    });
  });
});
