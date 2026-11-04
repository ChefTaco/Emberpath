import { beforeEach, describe, expect, it } from 'vitest';
import {
  getSecurityExporterJwksStatus,
  recordSecurityExporterJwksRefresh,
  resetSecurityExporterJwksStatusForTests,
} from '../../src/security/security-exporter-jwks-status.js';

describe('Security exporter JWKS lifetime status', () => {
  beforeEach(() => resetSecurityExporterJwksStatusForTests());

  it('reports uninitialized state before the first trusted refresh', () => {
    expect(getSecurityExporterJwksStatus(1_000, 5_000)).toMatchObject({
      state: 'uninitialized',
      remainingMs: 0,
      trustedKeyCount: 0,
    });
  });

  it.each([
    [100, 'healthy'],
    [500, 'warning'],
    [800, 'critical'],
    [1_000, 'expired'],
  ] as const)('alerts at %dms age with %s state', (age, state) => {
    recordSecurityExporterJwksRefresh(10_000, 2);
    expect(getSecurityExporterJwksStatus(1_000, 10_000 + age)).toMatchObject({
      state,
      remainingMs: 1_000 - age,
      trustedKeyCount: 2,
    });
  });
});
