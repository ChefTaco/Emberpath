import { describe, expect, it } from 'vitest';
import { hasAdminPermission, hasRecentOperatorAuthentication, requiredPermissionForRequest, requiresRecentAuthentication } from '../../src/admin/app.js';

describe('admin permission mapping', () => {
  it('separates execution of inference requests from read-only routing previews', () => {
    expect(requiredPermissionForRequest('POST', '/api/testing/run')).toBe('router:testing:write');
    expect(requiredPermissionForRequest('POST', '/api/testing/run/')).toBe('router:testing:write');
    expect(requiredPermissionForRequest('POST', '/api/testing/preview')).toBe('router:testing:read');
  });
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

  it('maps IAM group, enrollment, token and other IAM writes to IAM permissions, never a Router one', () => {
    expect(requiredPermissionForRequest('GET', '/api/iam/groups')).toBe('iam:groups:read');
    for (const [method, path] of [['POST', '/api/iam/groups'], ['PATCH', '/api/iam/groups/g1'], ['DELETE', '/api/iam/groups/g1'], ['POST', '/api/iam/groups/g1/members'], ['DELETE', '/api/iam/groups/g1/roles/r1']] as const) {
      expect(requiredPermissionForRequest(method, path), `${method} ${path}`).toBe('iam:groups:write');
    }
    expect(requiredPermissionForRequest('GET', '/api/iam/enrollments')).toBe('iam:sa:read');
    expect(requiredPermissionForRequest('POST', '/api/iam/enrollments')).toBe('iam:sa:write');
    expect(requiredPermissionForRequest('POST', '/api/iam/tokens/introspect')).toBe('iam:tokens:introspect');
    expect(requiredPermissionForRequest('POST', '/api/iam/tokens/revoke')).toBe('iam:sessions:revoke');
    expect(requiredPermissionForRequest('POST', '/api/iam/oauth/clients')).toBe('iam:admin:write');
    expect(hasAdminPermission(['router:admin:write'], requiredPermissionForRequest('POST', '/api/iam/groups')!)).toBe(false);
    expect(hasAdminPermission(['router:admin:write'], requiredPermissionForRequest('POST', '/api/iam/oauth/x')!)).toBe(false);
    expect(hasAdminPermission(['iam:*'], requiredPermissionForRequest('POST', '/api/iam/groups')!)).toBe(true);
  });

  it('accepts only a recent, plausible operator authentication time for sensitive writes', () => {
    const now = Date.parse('2026-09-07T12:00:00Z');
    expect(hasRecentOperatorAuthentication(now - 14 * 60_000, now)).toBe(true);
    expect(hasRecentOperatorAuthentication(now - 16 * 60_000, now)).toBe(false);
    expect(hasRecentOperatorAuthentication(now + 31_000, now)).toBe(false);
    expect(hasRecentOperatorAuthentication(undefined, now)).toBe(false);
  });
});

describe('requiresRecentAuthentication', () => {
  it('asks for a recent sign-in on credential and policy writes only', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      for (const path of ['/api/client-keys', '/api/client-keys/k/usage', '/api/iam/clients', '/api/iam/roles', '/api/iam/password-policy', '/api/hive/actors', '/api/hive/upgrades/status']) {
        expect(requiresRecentAuthentication(method, path)).toBe(false);
      }
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      for (const path of ['/api/client-keys', '/api/client-keys/k/rotate', '/api/iam/clients/c/rotate-secret', '/api/iam/roles/r', '/api/iam/password-policy', '/api/hive/actors/a/rotate', '/api/hive/upgrades/apply']) {
        expect(requiresRecentAuthentication(method, path)).toBe(true);
      }
    }
    expect(requiresRecentAuthentication('POST', '/api/route-rules')).toBe(false);
  });

  it('uses the configured window', () => {
    const now = Date.parse('2026-09-07T12:00:00Z');
    expect(hasRecentOperatorAuthentication(now - 20 * 60_000, now, 30 * 60_000)).toBe(true);
    expect(hasRecentOperatorAuthentication(now - 2 * 60_000, now, 60_000)).toBe(false);
  });
});
