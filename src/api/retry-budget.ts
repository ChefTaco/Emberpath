import { backoffDelay, readRetrySignal, retryAfterFromHeaders, RETRY_HEADER, sleepAbortable, type RetrySignal } from '@hivemagnus/hive-common/retry';

export { RETRY_HEADER };

/**
 * Backoff between attempts on the same provider. Full jitter keeps synchronized clients from
 * retrying in lockstep; an upstream `Retry-After` longer than `maxRetryAfterMs` sends the
 * request to the next candidate provider immediately instead of waiting.
 */
export const PROVIDER_RETRY_BACKOFF = { baseMs: 250, maxMs: 2000, jitter: 'full', maxRetryAfterMs: 10_000 } as const;

/** Clock, randomness and sleep used by the retry loop. Tests replace them. */
export const retryTiming: {
  now: () => number;
  random: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: (ms, signal) => sleepAbortable(ms, signal),
};

/**
 * The wait before attempt `attempt + 1` on the same provider, or null when the gateway should
 * move on: attempts used up, a `Retry-After` beyond the cap, or the wait would reach the
 * deadline.
 */
export function sameProviderRetryDelay(
  attempt: number,
  maxAttempts: number,
  options: { retryAfterMs?: number | undefined; deadlineMs: number },
): number | null {
  return backoffDelay(attempt, { ...PROVIDER_RETRY_BACKOFF, maxAttempts }, {
    retryAfterMs: options.retryAfterMs,
    deadlineMs: options.deadlineMs,
    now: retryTiming.now,
    random: retryTiming.random,
  });
}

/** An upstream `Retry-After` (seconds or HTTP date) in milliseconds. */
export function upstreamRetryAfterMs(headers: Headers): number | undefined {
  return retryAfterFromHeaders(headers, retryTiming.now);
}

/** Whether the upstream said it already retried (a nested Hive layer); the gateway then does not retry it again. */
export function upstreamExhausted(headers: Headers): boolean {
  return readRetrySignal(headers) === 'exhausted';
}

export function deadlineReached(deadlineMs: number): boolean {
  return retryTiming.now() >= deadlineMs;
}

/** 5xx, 429 and 408: the statuses a caller would otherwise retry. */
export function isRetryableFailureStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * `exhausted` when the gateway already made more than one upstream attempt (a retry or a
 * failover), or the upstream itself reported `exhausted`, and the answer is still a retryable
 * failure. Callers must not retry an exhausted answer; `none` leaves that decision to them.
 */
export function retrySignalFor(input: { status: number; upstreamAttempts: number; upstreamExhausted?: boolean }): RetrySignal {
  return isRetryableFailureStatus(input.status) && (input.upstreamAttempts > 1 || input.upstreamExhausted === true)
    ? 'exhausted'
    : 'none';
}
