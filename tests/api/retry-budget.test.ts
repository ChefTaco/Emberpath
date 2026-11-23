import { describe, expect, it } from 'vitest';
import { retrySignalFor, sameProviderRetryDelay, retryTiming } from '../../src/api/retry-budget.js';
import { shouldRetry } from '../../src/api/provider-guards.js';
import type { RouteRequest } from '../../src/providers/types.js';

const route = (method: string, headers: Record<string, string> = {}) => ({ method, headers } as RouteRequest);

describe('retry budget', () => {
  it('signals exhausted only after a retry or failover that still ended in a retryable failure', () => {
    expect(retrySignalFor({ status: 503, upstreamAttempts: 2 })).toBe('exhausted');
    expect(retrySignalFor({ status: 429, upstreamAttempts: 3 })).toBe('exhausted');
    expect(retrySignalFor({ status: 408, upstreamAttempts: 2 })).toBe('exhausted');
    expect(retrySignalFor({ status: 503, upstreamAttempts: 1 })).toBe('none');
    expect(retrySignalFor({ status: 503, upstreamAttempts: 1, upstreamExhausted: true })).toBe('exhausted');
    expect(retrySignalFor({ status: 200, upstreamAttempts: 4 })).toBe('none');
    expect(retrySignalFor({ status: 400, upstreamAttempts: 2 })).toBe('none');
  });

  it('uses 250 ms doubling to a 2 s cap with full jitter, a 10 s Retry-After cap and the deadline', () => {
    const random = retryTiming.random;
    retryTiming.random = () => 1;
    try {
      const far = Date.now() + 60_000;
      expect([1, 2, 3, 4, 5].map((attempt) => sameProviderRetryDelay(attempt, 10, { deadlineMs: far }))).toEqual([250, 500, 1000, 2000, 2000]);
      expect(sameProviderRetryDelay(3, 3, { deadlineMs: far })).toBeNull();
      expect(sameProviderRetryDelay(1, 3, { retryAfterMs: 10_000, deadlineMs: far })).toBe(10_000);
      expect(sameProviderRetryDelay(1, 3, { retryAfterMs: 10_001, deadlineMs: far })).toBeNull();
      expect(sameProviderRetryDelay(1, 3, { deadlineMs: Date.now() + 100 })).toBeNull();
      retryTiming.random = () => 0;
      expect(sameProviderRetryDelay(1, 3, { deadlineMs: far })).toBe(0);
    } finally {
      retryTiming.random = random;
    }
  });

  it('retries safe methods and requests with either idempotency header', () => {
    expect(shouldRetry(route('GET'))).toBe(true);
    expect(shouldRetry(route('POST'))).toBe(false);
    expect(shouldRetry(route('POST', { 'idempotency-key': 'k' }))).toBe(true);
    expect(shouldRetry(route('POST', { 'x-idempotency-key': 'k' }))).toBe(true);
    expect(shouldRetry(route('POST', { 'idempotency-key': ' ' }))).toBe(false);
  });
});
