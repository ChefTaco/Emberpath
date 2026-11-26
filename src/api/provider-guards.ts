import { HIVE_HEADERS } from '@hivemagnus/hive-common/contracts';
import type { ProviderRuntime, RouteRequest } from '../providers/types.js';
import { loadEnv } from '../config/env.js';

// Per-provider concurrency limits and circuit breakers shared by every API route.

/** A provider slot could not be had in time: the wait queue is full, or the wait timed out. */
export class ProviderSlotUnavailable extends Error {
  constructor(readonly reason: 'queue_full' | 'queue_timeout') {
    super(reason === 'queue_full' ? 'Provider wait queue is full' : 'Timed out waiting for a provider slot');
    this.name = 'ProviderSlotUnavailable';
  }
}

export interface SemaphoreLimits {
  /** Most callers that may wait for a slot; 0 means no limit. */
  maxWaiting?: number;
  /** Longest wait for a slot in milliseconds; 0 means no limit. */
  waitTimeoutMs?: number;
}

class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly capacity: number, private readonly limits: SemaphoreLimits = {}) {}

  /**
   * Wait for a slot. A caller that aborts while queued leaves the queue and never takes one.
   * When the queue is full, or the wait outlasts the timeout, the caller gets
   * `ProviderSlotUnavailable` and never takes a slot either.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.current < this.capacity) {
      this.current += 1;
      return;
    }
    const maxWaiting = this.limits.maxWaiting ?? 0;
    if (maxWaiting > 0 && this.queue.length >= maxWaiting) throw new ProviderSlotUnavailable('queue_full');
    const waitMs = this.limits.waitTimeoutMs ? this.limits.waitTimeoutMs : undefined;

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const leave = (): void => {
        const index = this.queue.indexOf(grant);
        if (index >= 0) this.queue.splice(index, 1);
        signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };
      const grant = () => {
        leave();
        this.current += 1;
        resolve();
      };
      const onAbort = () => {
        leave();
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Request aborted while waiting for a provider slot'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(grant);
      if (waitMs !== undefined) {
        timer = setTimeout(() => {
          leave();
          reject(new ProviderSlotUnavailable('queue_timeout'));
        }, waitMs);
        timer.unref?.();
      }
    });
  }

  release(): void {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }

  /** Slots in use and callers waiting, for tests and diagnostics. */
  get stats(): { active: number; waiting: number } {
    return { active: this.current, waiting: this.queue.length };
  }
}

/**
 * Keep a provider slot until the response body has been fully read, has failed or has been
 * cancelled, so `concurrency` bounds running generations and not just header waits. A
 * response without a body gives the slot back at once. `release` must be idempotent.
 */
export function holdUntilBodyDone(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const semaphores = new Map<string, { semaphore: Semaphore; key: string }>();

/** The provider's slot pool. A changed `concurrency` or queue setting gets a fresh pool. */
export function getSemaphore(provider: ProviderRuntime): Semaphore {
  const env = loadEnv();
  const capacity = Math.max(1, provider.concurrency);
  const limits = { maxWaiting: env.EMBERPATH_PROVIDER_QUEUE_MAX, waitTimeoutMs: env.EMBERPATH_PROVIDER_QUEUE_TIMEOUT_MS };
  const key = `${capacity}:${limits.maxWaiting}:${limits.waitTimeoutMs}`;
  const existing = semaphores.get(provider.id);
  if (existing?.key === key) {
    return existing.semaphore;
  }
  // Callers holding the old pool release into it; only new callers use the new one.
  const semaphore = new Semaphore(capacity, limits);
  semaphores.set(provider.id, { semaphore, key });
  return semaphore;
}

/**
 * Circuit breaker per provider. Failures count within a rolling window; reaching the
 * threshold opens the circuit for the open period. After that the circuit is half-open:
 * one trial request may go through (others skip the provider), a success closes it and a
 * failure opens it again.
 */
interface CircuitState {
  failures: number[];
  openUntil?: number;
  /** When the half-open trial request started; another trial may start after the open period. */
  trialStartedAt?: number;
}
const circuitBreakers = new Map<string, CircuitState>();

function circuitSettings(): { threshold: number; windowMs: number; openMs: number } {
  const env = loadEnv();
  return { threshold: env.EMBERPATH_CIRCUIT_FAILURE_THRESHOLD, windowMs: env.EMBERPATH_CIRCUIT_WINDOW_MS, openMs: env.EMBERPATH_CIRCUIT_OPEN_MS };
}

/** Whether requests skip the provider: the circuit is open, or half-open with a trial running. */
export function isCircuitOpen(providerId: string, now = Date.now()): boolean {
  const state = circuitBreakers.get(providerId);
  if (state?.openUntil === undefined) return false;
  if (state.openUntil > now) return true;
  return state.trialStartedAt !== undefined && now - state.trialStartedAt < circuitSettings().openMs;
}

/**
 * How many times each provider's circuit has opened. An attempt carries the generation it
 * entered under, so a late result from a request that started before the circuit opened
 * cannot reopen or close the circuit during a later half-open trial.
 */
const circuitGenerations = new Map<string, number>();

/** A provider attempt's circuit ticket: the generation it entered under. */
export type CircuitTicket = number;

/**
 * Claim the provider for an attempt. Returns undefined when its circuit is open (or another
 * half-open trial is running); when the circuit is half-open, this request becomes the trial.
 * Pass the returned ticket to `markProviderFailure` and `resetProviderCircuit`.
 */
export function enterProviderCircuit(providerId: string, now = Date.now()): CircuitTicket | undefined {
  if (isCircuitOpen(providerId, now)) return undefined;
  const state = circuitBreakers.get(providerId);
  if (state?.openUntil !== undefined) state.trialStartedAt = now;
  return circuitGenerations.get(providerId) ?? 0;
}

function stale(providerId: string, ticket: CircuitTicket | undefined): boolean {
  return ticket !== undefined && ticket !== (circuitGenerations.get(providerId) ?? 0);
}

/** Give back a half-open trial that never reached the provider, so another request may try. */
export function abandonProviderTrial(providerId: string, ticket?: CircuitTicket): void {
  if (stale(providerId, ticket)) return;
  const state = circuitBreakers.get(providerId);
  if (state) delete state.trialStartedAt;
}

function openCircuit(providerId: string, now: number, openMs: number): void {
  circuitGenerations.set(providerId, (circuitGenerations.get(providerId) ?? 0) + 1);
  circuitBreakers.set(providerId, { failures: [], openUntil: now + openMs });
}

export function markProviderFailure(providerId: string, now = Date.now(), ticket?: CircuitTicket): void {
  // A request that entered before the circuit last opened changes nothing.
  if (stale(providerId, ticket)) return;
  const { threshold, windowMs, openMs } = circuitSettings();
  const state = circuitBreakers.get(providerId) ?? { failures: [] };
  // A request that was already running when the circuit opened changes nothing.
  if (state.openUntil !== undefined && state.openUntil > now) return;
  if (state.openUntil !== undefined) {
    // The half-open trial failed: open again for a full period.
    openCircuit(providerId, now, openMs);
    return;
  }
  state.failures = [...state.failures.filter((at) => now - at < windowMs), now];
  if (state.failures.length >= threshold) {
    openCircuit(providerId, now, openMs);
    return;
  }
  circuitBreakers.set(providerId, state);
}

/** Close the provider's circuit after a success (ignored for an attempt from before it last opened). */
export function resetProviderCircuit(providerId: string, ticket?: CircuitTicket): void {
  if (stale(providerId, ticket)) return;
  circuitBreakers.delete(providerId);
}

/**
 * Whether the same provider may be asked again: safe methods, or a request that carries an
 * idempotency key (the standard `Idempotency-Key`, or the legacy `X-Idempotency-Key`).
 */
export function shouldRetry(route: RouteRequest): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(route.method)
    || [HIVE_HEADERS.idempotencyKey, ...HIVE_HEADERS.idempotencyKeyAliases].some((name) => Boolean(route.headers[name]?.trim()));
}

export function shouldFailoverStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}
