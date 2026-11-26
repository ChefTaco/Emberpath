import { describe, expect, it } from 'vitest';
import { abandonProviderTrial, enterProviderCircuit, getSemaphore, holdUntilBodyDone, isCircuitOpen, markProviderFailure, ProviderSlotUnavailable, resetProviderCircuit } from '../../src/api/provider-guards.js';
import { loadEnv } from '../../src/config/env.js';

describe('api/provider-guards', () => {
  it('drops a queued caller that aborts, so it never takes a slot', async () => {
    const slots = getSemaphore({ id: 'guards-abort', concurrency: 1 } as never);
    await slots.acquire();
    const caller = new AbortController();
    const waiting = slots.acquire(caller.signal);
    expect(slots.stats).toEqual({ active: 1, waiting: 1 });

    caller.abort(new Error('client went away'));
    await expect(waiting).rejects.toThrow('client went away');
    expect(slots.stats).toEqual({ active: 1, waiting: 0 });

    slots.release();
    expect(slots.stats).toEqual({ active: 0, waiting: 0 });
  });

  it('refuses an already aborted caller without queueing it', async () => {
    const slots = getSemaphore({ id: 'guards-aborted', concurrency: 1 } as never);
    await expect(slots.acquire(AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone');
    expect(slots.stats).toEqual({ active: 0, waiting: 0 });
  });

  it('releases once a held body is read, and at once when there is no body', async () => {
    let releases = 0;
    const held = holdUntilBodyDone(new Response('hello'), () => { releases += 1; });
    expect(releases).toBe(0);
    expect(await held.text()).toBe('hello');
    expect(releases).toBe(1);

    holdUntilBodyDone(new Response(null, { status: 204 }), () => { releases += 1; });
    expect(releases).toBe(2);
  });

  it('turns a caller away when the wait queue is full, without queueing it', async () => {
    const env = loadEnv();
    const saved = env.EMBERPATH_PROVIDER_QUEUE_MAX;
    env.EMBERPATH_PROVIDER_QUEUE_MAX = 1;
    try {
      const slots = getSemaphore({ id: 'guards-queue-full', concurrency: 1 } as never);
      await slots.acquire();
      const waiting = slots.acquire();
      const refused = slots.acquire();
      await expect(refused).rejects.toBeInstanceOf(ProviderSlotUnavailable);
      await expect(refused).rejects.toMatchObject({ reason: 'queue_full' });
      expect(slots.stats).toEqual({ active: 1, waiting: 1 });
      slots.release();
      await waiting;
      expect(slots.stats).toEqual({ active: 1, waiting: 0 });
      slots.release();
    } finally {
      env.EMBERPATH_PROVIDER_QUEUE_MAX = saved;
    }
  });

  it('gives up a wait that outlasts the queue timeout and never takes the slot', async () => {
    const env = loadEnv();
    const saved = env.EMBERPATH_PROVIDER_QUEUE_TIMEOUT_MS;
    env.EMBERPATH_PROVIDER_QUEUE_TIMEOUT_MS = 20;
    try {
      const slots = getSemaphore({ id: 'guards-queue-timeout', concurrency: 1 } as never);
      await slots.acquire();
      await expect(slots.acquire()).rejects.toMatchObject({ reason: 'queue_timeout' });
      expect(slots.stats).toEqual({ active: 1, waiting: 0 });
      slots.release();
      expect(slots.stats).toEqual({ active: 0, waiting: 0 });
    } finally {
      env.EMBERPATH_PROVIDER_QUEUE_TIMEOUT_MS = saved;
    }
  });

  it('keeps an unlimited queue by default', async () => {
    const slots = getSemaphore({ id: 'guards-unlimited', concurrency: 1 } as never);
    await slots.acquire();
    const waiters = Array.from({ length: 50 }, () => slots.acquire());
    expect(slots.stats).toEqual({ active: 1, waiting: 50 });
    for (let index = 0; index <= 50; index += 1) slots.release();
    await Promise.all(waiters);
  });

  it('gives a provider whose concurrency changed a pool of the new size', async () => {
    const first = getSemaphore({ id: 'guards-resized', concurrency: 1 } as never);
    expect(getSemaphore({ id: 'guards-resized', concurrency: 1 } as never)).toBe(first);
    const resized = getSemaphore({ id: 'guards-resized', concurrency: 2 } as never);
    expect(resized).not.toBe(first);
    await resized.acquire();
    await resized.acquire();
    expect(resized.stats).toEqual({ active: 2, waiting: 0 });
  });
});

describe('api/provider-guards circuit breaker', () => {
  const t0 = 1_000_000_000_000;

  it('forgets failures older than the window', () => {
    const id = 'circuit-decay';
    resetProviderCircuit(id);
    markProviderFailure(id, t0);
    markProviderFailure(id, t0 + 30_000);
    // The first failure has left the 60 s window, so two count and the circuit stays closed.
    markProviderFailure(id, t0 + 61_000);
    expect(isCircuitOpen(id, t0 + 61_000)).toBe(false);
    markProviderFailure(id, t0 + 62_000);
    expect(isCircuitOpen(id, t0 + 62_000)).toBe(true);
    expect(isCircuitOpen(id, t0 + 62_000 + 29_000)).toBe(true);
  });

  it('lets one trial through once the open period ends; its success closes the circuit', () => {
    const id = 'circuit-trial-success';
    resetProviderCircuit(id);
    for (let index = 0; index < 3; index += 1) markProviderFailure(id, t0);
    expect(enterProviderCircuit(id, t0 + 1_000)).toBe(false);
    const after = t0 + 30_000;
    expect(enterProviderCircuit(id, after)).toBe(true);
    // Another request while the trial runs skips the provider.
    expect(enterProviderCircuit(id, after + 10)).toBe(false);
    resetProviderCircuit(id);
    expect(enterProviderCircuit(id, after + 20)).toBe(true);
    // A single new failure does not trip a closed circuit again.
    markProviderFailure(id, after + 30);
    expect(isCircuitOpen(id, after + 30)).toBe(false);
  });

  it('opens again for a full period when the trial fails', () => {
    const id = 'circuit-trial-failure';
    resetProviderCircuit(id);
    for (let index = 0; index < 3; index += 1) markProviderFailure(id, t0);
    const after = t0 + 30_000;
    expect(enterProviderCircuit(id, after)).toBe(true);
    markProviderFailure(id, after + 5);
    expect(isCircuitOpen(id, after + 5 + 29_000)).toBe(true);
    expect(isCircuitOpen(id, after + 5 + 30_000)).toBe(false);
  });

  it('frees the trial when the request never reached the provider', () => {
    const id = 'circuit-trial-abandoned';
    resetProviderCircuit(id);
    for (let index = 0; index < 3; index += 1) markProviderFailure(id, t0);
    const after = t0 + 30_000;
    expect(enterProviderCircuit(id, after)).toBe(true);
    abandonProviderTrial(id);
    expect(enterProviderCircuit(id, after + 1)).toBe(true);
  });

  it('ignores failures of requests that were running when the circuit opened', () => {
    const id = 'circuit-late-failure';
    resetProviderCircuit(id);
    for (let index = 0; index < 3; index += 1) markProviderFailure(id, t0);
    markProviderFailure(id, t0 + 29_000);
    expect(isCircuitOpen(id, t0 + 30_000)).toBe(false);
  });

  it('reads its thresholds from the settings', () => {
    const env = loadEnv();
    const saved = env.EMBERPATH_CIRCUIT_FAILURE_THRESHOLD;
    env.EMBERPATH_CIRCUIT_FAILURE_THRESHOLD = 1;
    try {
      const id = 'circuit-threshold';
      resetProviderCircuit(id);
      markProviderFailure(id, t0);
      expect(isCircuitOpen(id, t0)).toBe(true);
    } finally {
      env.EMBERPATH_CIRCUIT_FAILURE_THRESHOLD = saved;
      resetProviderCircuit('circuit-threshold');
    }
  });
});
