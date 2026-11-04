export const JWKS_WARNING_REMAINING_FRACTION = 0.5;
export const JWKS_CRITICAL_REMAINING_FRACTION = 0.2;

export type SecurityExporterJwksLifetimeState =
  | 'uninitialized'
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'expired';

export interface SecurityExporterJwksStatus {
  state: SecurityExporterJwksLifetimeState;
  fetchedAt: string | null;
  ageMs: number | null;
  remainingMs: number;
  maxAgeMs: number;
  trustedKeyCount: number;
}

let lastRefresh: { fetchedAt: number; trustedKeyCount: number } | null = null;

export function recordSecurityExporterJwksRefresh(
  fetchedAt: number,
  trustedKeyCount: number,
): void {
  lastRefresh = { fetchedAt, trustedKeyCount };
}

export function getSecurityExporterJwksStatus(
  maxAgeMs: number,
  now = Date.now(),
): SecurityExporterJwksStatus {
  if (!lastRefresh) {
    return {
      state: 'uninitialized',
      fetchedAt: null,
      ageMs: null,
      remainingMs: 0,
      maxAgeMs,
      trustedKeyCount: 0,
    };
  }

  const ageMs = Math.max(0, now - lastRefresh.fetchedAt);
  const remainingMs = Math.max(0, maxAgeMs - ageMs);
  const remainingFraction = remainingMs / maxAgeMs;
  const state: SecurityExporterJwksLifetimeState = remainingMs === 0
    ? 'expired'
    : remainingFraction <= JWKS_CRITICAL_REMAINING_FRACTION
      ? 'critical'
      : remainingFraction <= JWKS_WARNING_REMAINING_FRACTION
        ? 'warning'
        : 'healthy';
  return {
    state,
    fetchedAt: new Date(lastRefresh.fetchedAt).toISOString(),
    ageMs,
    remainingMs,
    maxAgeMs,
    trustedKeyCount: lastRefresh.trustedKeyCount,
  };
}

export function resetSecurityExporterJwksStatusForTests(): void {
  lastRefresh = null;
}
