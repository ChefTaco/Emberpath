import { describe, expect, it } from 'vitest';
import { getSemaphore, holdUntilBodyDone } from '../../src/api/provider-guards.js';

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
});
