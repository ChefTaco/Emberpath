import { describe, expect, it } from 'vitest';
import { hasAdminPermission, hasRecentOperatorAuthentication, requiredPermissionForRequest } from '../../src/admin/app.js';

describe('admin permission mapping', () => {
  it('allows wildcard and scoped wildcard grants', () => {
    expect(hasAdminPermission(['*'], 'router:keys:write')).toBe(true);
    expect(hasAdminPermission(['router:*'], 'router:providers:write')).toBe(true);
    expect(hasAdminPermission(['router:keys:*'], 'router:keys:write')).toBe(true);
    expect(hasAdminPermission(['iam:users:read'], 'iam:users:write')).toBe(false);
  });

  it('lets a write grant satisfy the matching read permission only', () => {
    expect(hasAdminPermission(['router:keys:write'], 'router:keys:read')).toBe(true);
    expect(hasAdminPermission(['router:keys:read'], 'router:keys:write')).toBe(false);
    expect(hasAdminPermission(['router:keys:write'], 'router:providers:read')).toBe(false);
  });

  it('maps read requests to read permissions', () => {
    expect(requiredPermissionForRequest('GET', '/api/client-keys')).toBe('router:keys:read');
    expect(requiredPermissionForRequest('HEAD', '/api/memory/search')).toBe('memory:read');
    expect(requiredPermissionForRequest('GET', '/api/iam/users')).toBe('iam:users:read');
    expect(requiredPermissionForRequest('GET', '/api/iam/roles/1')).toBe('iam:roles:read');
    expect(requiredPermissionForRequest('GET', '/api/iam/audit')).toBe('iam:audit:read');
    expect(requiredPermissionForRequest('GET', '/api/traces')).toBe('router:admin:read');
    expect(requiredPermissionForRequest('GET', '/api/auth/me')).toBeNull();
    expect(requiredPermissionForRequest('OPTIONS', '/api/client-keys')).toBeNull();
  });

  it('requires settings write access to export configuration', () => {
    expect(requiredPermissionForRequest('GET', '/api/config/export')).toBe('router:settings:write');
  });

  it('maps mutating Router, IAM, Memory, and actor routes to write permissions', () => {
    expect(requiredPermissionForRequest('POST', '/api/client-keys')).toBe('router:keys:write');
    expect(requiredPermissionForRequest('POST', '/api/providers')).toBe('router:providers:write');
    expect(requiredPermissionForRequest('POST', '/api/route-rules')).toBe('router:routing:write');
    expect(requiredPermissionForRequest('PATCH', '/api/iam/users/123')).toBe('iam:users:write');
    expect(requiredPermissionForRequest('DELETE', '/api/iam/service-accounts/123')).toBe('iam:sa:delete');
    expect(requiredPermissionForRequest('POST', '/api/memory/memories')).toBe('memory:write');
    expect(requiredPermissionForRequest('POST', '/api/hive/actors/user:abc/disable')).toBe('hive:actors:write');
  });

  it('accepts only a recent, plausible operator authentication time for sensitive writes', () => {
    const now = Date.parse('2026-09-07T12:00:00Z');
    expect(hasRecentOperatorAuthentication(now - 14 * 60_000, now)).toBe(true);
    expect(hasRecentOperatorAuthentication(now - 16 * 60_000, now)).toBe(false);
    expect(hasRecentOperatorAuthentication(now + 31_000, now)).toBe(false);
    expect(hasRecentOperatorAuthentication(undefined, now)).toBe(false);
  });
});
