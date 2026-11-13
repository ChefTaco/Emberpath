import type { ProviderRuntime, RouteRequest } from '../providers/types.js';

// Per-provider concurrency limits and circuit breakers shared by every API route.
class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.capacity) {
      this.current += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
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

export function shouldRetry(route: RouteRequest): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(route.method) || Boolean(route.headers['x-idempotency-key']);
}

export function shouldFailoverStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}
