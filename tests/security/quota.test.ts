import { describe, expect, it } from 'vitest';
import { evaluateQuota, readClientKeyQuota, type QuotaUsage } from '../../src/security/quota.js';

const zeroUsage: QuotaUsage = { dayRequests: 0, monthRequests: 0, dayTokens: 0, monthTokens: 0 };

describe('security/quota evaluateQuota', () => {
  it('allows traffic when no limits are configured', () => {
    const result = evaluateQuota({}, { dayRequests: 1000, monthRequests: 9999, dayTokens: 1, monthTokens: 1 });
    expect(result.allowed).toBe(true);
    expect(result.exceeded).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('hard-stops when a request limit is reached', () => {
    const result = evaluateQuota({ dailyRequests: 100 }, { ...zeroUsage, dayRequests: 100 });
    expect(result.allowed).toBe(false);
    expect(result.exceeded).toContain('dailyRequests');
  });

  it('hard-stops when a token limit is exceeded', () => {
    const result = evaluateQuota({ monthlyTokens: 1_000_000 }, { ...zeroUsage, monthTokens: 1_500_000 });
    expect(result.allowed).toBe(false);
    expect(result.exceeded).toContain('monthlyTokens');
  });

  it('emits a soft warning at the default 80% threshold', () => {
    const result = evaluateQuota({ dailyRequests: 100 }, { ...zeroUsage, dayRequests: 85 });
    expect(result.allowed).toBe(true);
    expect(result.warnings).toContain('dailyRequests');
    expect(result.exceeded).toEqual([]);
  });

  it('honors a custom warn threshold', () => {
    const below = evaluateQuota({ dailyTokens: 1000, warnAtPercent: 50 }, { ...zeroUsage, dayTokens: 400 });
    expect(below.warnings).toEqual([]);
    const above = evaluateQuota({ dailyTokens: 1000, warnAtPercent: 50 }, { ...zeroUsage, dayTokens: 600 });
    expect(above.warnings).toContain('dailyTokens');
  });

  it('reports multiple exceeded dimensions at once', () => {
    const result = evaluateQuota(
      { dailyRequests: 10, monthlyRequests: 100 },
      { dayRequests: 10, monthRequests: 100, dayTokens: 0, monthTokens: 0 },
    );
    expect(result.exceeded).toEqual(['dailyRequests', 'monthlyRequests']);
  });

  it('ignores non-positive limits', () => {
    const result = evaluateQuota({ dailyRequests: 0 }, { ...zeroUsage, dayRequests: 50 });
    expect(result.allowed).toBe(true);
  });
});

describe('security/quota readClientKeyQuota', () => {
  it('returns empty limits for missing or invalid metadata', () => {
    expect(readClientKeyQuota(null)).toEqual({});
    expect(readClientKeyQuota('not-json')).toEqual({});
    expect(readClientKeyQuota('{}')).toEqual({});
  });

  it('parses a quota block from key metadata', () => {
    const metadata = JSON.stringify({ owner: 'team', quota: { dailyRequests: 500, monthlyTokens: 2_000_000 } });
    expect(readClientKeyQuota(metadata)).toEqual({ dailyRequests: 500, monthlyTokens: 2_000_000 });
  });
});
