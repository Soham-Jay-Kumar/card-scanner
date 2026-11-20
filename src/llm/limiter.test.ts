import { describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../shared/config.ts';
import { AdaptiveLimiter } from './limiter.ts';

const { initial, min, max } = CONFIG.concurrency;

/** Keeps demand queued so successes count towards growth. */
function holdQueue(limiter: AdaptiveLimiter, count: number): void {
  for (let i = 0; i < count; i += 1) void limiter.acquire();
}

describe('AdaptiveLimiter', () => {
  it('never exceeds its limit and serves waiters in order', async () => {
    const limiter = new AdaptiveLimiter();
    const order: number[] = [];
    const held = Array.from({ length: initial + 2 }, (_, i) => limiter.acquire().then(() => order.push(i)));
    await Promise.all(held.slice(0, initial));
    expect(limiter.inFlight).toBe(initial);
    expect(order).toEqual([0, 1, 2, 3]);

    limiter.release();
    limiter.release();
    await Promise.all(held);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('adds one slot per full window of successes', () => {
    const limiter = new AdaptiveLimiter();
    holdQueue(limiter, 100);
    for (let i = 0; i < initial - 1; i += 1) limiter.onSuccess();
    expect(limiter.limit).toBe(initial);
    limiter.onSuccess();
    expect(limiter.limit).toBe(initial + 1);
  });

  it('does not grow without demand', () => {
    const limiter = new AdaptiveLimiter();
    for (let i = 0; i < 1_000; i += 1) limiter.onSuccess();
    expect(limiter.limit).toBe(initial);
  });

  it('stops growing at the maximum', () => {
    const limiter = new AdaptiveLimiter();
    holdQueue(limiter, 100);
    for (let i = 0; i < 10_000; i += 1) limiter.onSuccess();
    expect(limiter.limit).toBe(max);
  });

  it('halves once per window and stops at the minimum', async () => {
    const limiter = new AdaptiveLimiter();
    limiter.limit = 32;
    const first = await limiter.acquire();
    const second = await limiter.acquire();

    limiter.onRateLimited(first);
    expect(limiter.limit).toBe(16);
    limiter.onRateLimited(second);
    expect(limiter.limit).toBe(16);

    limiter.release();
    limiter.release();
    for (let i = 0; i < 10; i += 1) {
      limiter.onRateLimited(await limiter.acquire());
      limiter.release();
    }
    expect(limiter.limit).toBe(min);
  });

  it('holds queued calls for the whole cooldown', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new AdaptiveLimiter();
      limiter.cooldown(5_000);
      let granted = false;
      void limiter.acquire().then(() => {
        granted = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(granted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(granted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an aborted waiter so it takes no slot', async () => {
    const limiter = new AdaptiveLimiter();
    limiter.limit = 1;
    await limiter.acquire();
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeDefined();
    limiter.release();
    expect(limiter.inFlight).toBe(0);
  });
});
