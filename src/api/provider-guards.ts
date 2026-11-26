import { HIVE_HEADERS } from '@hivemagnus/hive-common/contracts';
import type { ProviderRuntime, RouteRequest } from '../providers/types.js';

// Per-provider concurrency limits and circuit breakers shared by every API route.
class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  /** Wait for a slot. A caller that aborts while queued leaves the queue and never takes one. */
  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.current < this.capacity) {
      this.current += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        this.current += 1;
        resolve();
      };
      const onAbort = () => {
        const index = this.queue.indexOf(grant);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Request aborted while waiting for a provider slot'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(grant);
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

const semaphores = new Map<string, Semaphore>();
const circuitBreakers = new Map<string, { failures: number; openUntil?: number }>();

export function getSemaphore(provider: ProviderRuntime): Semaphore {
  const existing = semaphores.get(provider.id);
  if (existing) {
    return existing;
  }

  const semaphore = new Semaphore(Math.max(1, provider.concurrency));
  semaphores.set(provider.id, semaphore);
  return semaphore;
}

export function isCircuitOpen(providerId: string): boolean {
  const state = circuitBreakers.get(providerId);
  return state?.openUntil !== undefined && state.openUntil > Date.now();
}

export function markProviderFailure(providerId: string): void {
  const state = circuitBreakers.get(providerId) ?? { failures: 0 };
  state.failures += 1;
  if (state.failures >= 3) {
    state.openUntil = Date.now() + 30_000;
  }
  circuitBreakers.set(providerId, state);
}

export function resetProviderCircuit(providerId: string): void {
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
