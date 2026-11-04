import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import type { Service } from './manifest.js';

const protectedColumns: Partial<Record<Service, Record<string, string[]>>> = {
  iam: {
    users: [
      'id',
      'active',
      'passwordHash',
      'mfaEnabled',
      'mfaSecret',
      'mfaBackupCodes',
      'allowedIps',
      'lockedUntil',
      'passwordChangedAt',
      'passwordPolicyId',
    ],
    clients: [
      'id',
      'active',
      'secretHash',
      'allowedIps',
      'grantTypes',
      'redirectUris',
      'clientType',
    ],
    service_accounts: ['id', 'active', 'apiKeyHash', 'expiresAt', 'allowedIps'],
    sessions: ['id', 'revokedAt', 'revokedBy', 'expiresAt'],
    refresh_tokens: ['id', 'tokenHash', 'revokedAt', 'rotatedToId', 'expiresAt'],
    roles: ['id', 'permissions'],
    user_role_assignments: ['userId', 'roleId'],
    service_account_role_assignments: ['serviceAccountId', 'roleId'],
    group_members: ['groupId', 'userId'],
    group_role_assignments: ['groupId', 'roleId'],
    webauthn_credentials: ['id', 'publicKey', 'counter'],
    trusted_devices: ['id', 'userId', 'fingerprint', 'trusted'],
    authorization_codes: ['id', 'code', 'clientId', 'userId', 'scope', 'usedAt', 'expiresAt'],
    password_reset_tokens: ['id', 'tokenHash', 'usedAt', 'expiresAt'],
  },
  router: {
    ClientApiKey: ['id', 'enabled', 'keyHash', 'expiresAt', 'metadataJson'],
    AdminUser: ['id', 'passwordHash'],
    AdminSession: ['id', 'sessionId', 'revokedAt', 'expiresAt'],
  },
  skills: {
    sessions: ['id', 'username', 'expires_at'],
    target_policies: ['target', 'token_hash', 'skills_json'],
    deployment_targets: ['name', 'host', 'username', 'enabled'],
  },
};

/** A generic restore approval cannot undo subsequent containment. Unknown changes
 * require an operator to reconcile the preserved failed state before retrying. */
export function assertContainmentUnchanged(
  current: string,
  backup: string,
  service: Service,
): void {
  if (!existsSync(current) || !protectedColumns[service]) return;
  const live = new DatabaseSync(current, { readOnly: true });
  const saved = new DatabaseSync(backup, { readOnly: true });
  try {
    for (const [table, columns] of Object.entries(protectedColumns[service]!)) {
      const projection = (db: DatabaseSync): string[] =>
        db
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .map((row) => String(row.name));
      const a = projection(live),
        b = projection(saved);
      const selected = columns.filter((c) => a.includes(c) || b.includes(c));
      const rows = (db: DatabaseSync, available: string[]): string[] => {
        if (!available.length) return [];
        const existing = selected.filter((c) => available.includes(c));
        if (!existing.length)
          throw new Error('Unknown containment schema; reconcile recovery manually');
        return db
          .prepare(`SELECT ${existing.map((c) => `"${c}"`).join(',')} FROM "${table}"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort();
      };
      if (JSON.stringify(rows(live, a)) !== JSON.stringify(rows(saved, b)))
        throw new Error(
          `${service} containment changed in ${table}; reconcile the preserved failed state before restoring credentials, permissions or sessions`,
        );
    }
  } finally {
    live.close();
    saved.close();
  }
}
