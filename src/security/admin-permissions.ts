/**
 * IAM roles that grant every Router permission. Matching is exact: IAM role names are
 * user-defined, so a case-insensitive match would let anyone who can create roles mint an
 * `ADMIN` role for themselves. `SUPER_ADMIN` is IAM's built-in top role, which IAM does
 * not let anyone create, rename or delete. The lowercase names are kept for compatibility.
 */
const FULL_ACCESS_ROLES = new Set(['SUPER_ADMIN', 'admin', 'super_admin']);

/**
 * Permissions an admin session carries. OS-mode operators and holders of a full-access
 * IAM role get `*`; everyone else gets exactly the permissions IAM granted.
 */
export function expandAdminPermissions(authMode: 'os' | 'iam-oidc', roles: readonly string[], permissions: readonly string[]): string[] {
  if (authMode === 'os' || roles.some((role) => FULL_ACCESS_ROLES.has(role))) return ['*'];
  return [...new Set(permissions)].sort();
}
