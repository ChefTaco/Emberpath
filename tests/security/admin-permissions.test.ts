import { describe, expect, it } from 'vitest';
import { expandAdminPermissions } from '../../src/security/admin-permissions.js';

describe('expandAdminPermissions', () => {
  it('gives OS-mode operators full access', () => {
    expect(expandAdminPermissions('os', [], [])).toEqual(['*']);
  });

  it('treats the built-in IAM SUPER_ADMIN role as full access', () => {
    // Hive IAM seeds its first administrator with the SUPER_ADMIN role.
    expect(expandAdminPermissions('iam-oidc', ['SUPER_ADMIN'], ['iam:users:read'])).toEqual(['*']);
    expect(expandAdminPermissions('iam-oidc', ['super_admin'], [])).toEqual(['*']);
    expect(expandAdminPermissions('iam-oidc', ['admin'], [])).toEqual(['*']);
  });

  it('does not grant full access to user-defined roles that only look like admin roles', () => {
    // IAM accepts any ^[A-Z0-9_]+$ role name, so anyone with iam:roles:write can create these.
    for (const role of ['ADMIN', 'Admin', 'Super_Admin', 'SUPERADMIN', 'SUPER_ADMIN ']) {
      expect(expandAdminPermissions('iam-oidc', [role], ['memory:read'])).toEqual(['memory:read']);
    }
  });

  it('keeps other IAM roles to the permissions IAM granted', () => {
    expect(expandAdminPermissions('iam-oidc', ['IAM_ADMIN', 'VIEWER'], ['memory:read', 'iam:users:read', 'memory:read'])).toEqual(['iam:users:read', 'memory:read']);
    expect(expandAdminPermissions('iam-oidc', ['SUPER_ADMINISTRATOR'], [])).toEqual([]);
  });
});
