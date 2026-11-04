import { describe, it, expect } from 'vitest';
import {
  requiredPermissionForRequest,
  hasRecentOperatorAuthentication,
} from '../../src/admin/app.js';
import { UpgradeApplyRequest, UpgradePlanRequest } from '../../src/contracts/upgrades.js';

describe('upgrade control boundary', () => {
  it('requires a dedicated write permission for plan and apply', () => {
    expect(requiredPermissionForRequest('POST', '/api/hive/upgrades/plan')).toBe(
      'hive:upgrades:write',
    );
    expect(requiredPermissionForRequest('POST', '/api/hive/upgrades/apply')).toBe(
      'hive:upgrades:write',
    );
  });
  it('rejects stale authentication and arbitrary command/path payloads', () => {
    expect(hasRecentOperatorAuthentication(undefined)).toBe(false);
    expect(hasRecentOperatorAuthentication(Date.now() - 3600_000)).toBe(false);
    expect(
      UpgradePlanRequest.safeParse({ to: '1.2.0', from: '/tmp/another-package' }).success,
    ).toBe(false);
    expect(
      UpgradeApplyRequest.safeParse({ planHash: 'a'.repeat(64), command: 'arbitrary' }).success,
    ).toBe(false);
    expect(UpgradeApplyRequest.safeParse({ planHash: '../transaction' }).success).toBe(false);
    expect(UpgradeApplyRequest.safeParse({ planHash: 'a'.repeat(64) }).success).toBe(true);
  });
});
