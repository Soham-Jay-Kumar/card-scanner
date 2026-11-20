/**
 * Adaptive concurrency for OpenAI calls, shared by every job on one client.
 *
 * OpenAI returns slow_down when traffic rises too fast even within limits, so
 * this starts low, adds one slot per full window of successes, and halves on a
 * 429. A burst of 429s from one window halves once: requests that started before
 * the last halving say nothing about the new, lower limit.
 */
import { CONFIG } from '../shared/config.ts';

interface Waiter {
  grant(epoch: number): void;
}

export class AdaptiveLimiter {
  limit: number = CONFIG.concurrency.initial;
  inFlight = 0;

  private epoch = 0;
  private successes = 0;
  private cooldownUntil = 0;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private readonly waiters: Waiter[] = [];

  /** Resolves with the window this call runs in. Pass it to onRateLimited. */
  acquire(signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(signal?.reason);
      };
      const waiter: Waiter = {
        grant: (epoch) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(epoch);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  release(): void {
    this.inFlight -= 1;
    this.pump();
  }

  /** Only grows under real demand, so a quiet stretch can't bank a sudden burst. */
  onSuccess(): void {
    if (this.waiters.length === 0) return;
    this.successes += 1;
    if (this.successes < this.limit) return;
    this.successes = 0;
    this.limit = Math.min(CONFIG.concurrency.max, this.limit + 1);
    this.pump();
  }

  onRateLimited(epochAtStart: number): void {
    if (epochAtStart !== this.epoch) return;
    this.epoch += 1;
    this.successes = 0;
    this.limit = Math.max(CONFIG.concurrency.min, Math.floor(this.limit / 2));
  }

  /** Retry-After applies to the whole client, so queued calls wait as well. */
  cooldown(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
    this.pump();
  }

  private pump(): void {
    const waitMs = this.cooldownUntil - Date.now();
    if (waitMs > 0) {
      if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
      this.cooldownTimer = setTimeout(() => this.pump(), waitMs);
      this.cooldownTimer.unref();
      return;
    }
    while (this.inFlight < this.limit) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      this.inFlight += 1;
      waiter.grant(this.epoch);
    }
  }
}
