/** Two small concurrency tools the pipeline is built from. */

/** A fixed number of slots, served first come, first served. */
export class Gate {
  active = 0;
  private readonly size: number;
  private readonly waiting: Array<() => void> = [];

  constructor(size: number) {
    this.size = size;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.size) this.active += 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/**
 * Cards waiting for workers. The backlog counts cards, not files, because one
 * file can add 36 cards at once and the file stage must hold back until they drain.
 */
export class WorkQueue<T> {
  private readonly items: T[] = [];
  private active = 0;
  private closed = false;
  private stopped = false;
  private waiters: Array<() => void> = [];

  get backlog(): number {
    return this.items.length + this.active;
  }

  push(items: T[]): void {
    this.items.push(...items);
    this.wakeAll();
  }

  /** No more items are coming. Workers finish what is queued, then stop. */
  close(): void {
    this.closed = true;
    this.wakeAll();
  }

  /** Stop now. Queued items stay unprocessed and wake on the next run. */
  stop(): void {
    this.stopped = true;
    this.wakeAll();
  }

  /** Returns undefined when a worker should exit. Pair each item with finishOne. */
  async take(): Promise<T | undefined> {
    for (;;) {
      if (this.stopped) return undefined;
      const item = this.items.shift();
      if (item !== undefined) {
        this.active += 1;
        return item;
      }
      if (this.closed) return undefined;
      await this.nextChange();
    }
  }

  finishOne(): void {
    this.active -= 1;
    this.wakeAll();
  }

  async waitForRoom(limit: number): Promise<void> {
    while (!this.stopped && this.backlog >= limit) await this.nextChange();
  }

  private nextChange(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wakeAll(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}
