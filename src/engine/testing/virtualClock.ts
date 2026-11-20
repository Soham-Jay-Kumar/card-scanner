/**
 * Simulated time for the benchmark. Replaces timers and clocks, so a job of many
 * simulated minutes runs in seconds with every delay in the same proportion.
 * Time only moves once all promises and file reads have settled.
 */
interface Timer {
  id: number;
  at: number;
  fn: (...args: unknown[]) => void;
  args: unknown[];
}

export interface VirtualClock {
  runUntil(done: () => boolean): Promise<void>;
}

export function installVirtualClock(): VirtualClock {
  const realSetImmediate = globalThis.setImmediate;
  let now = Date.now();
  const startedAt = now;
  let nextId = 1;
  const timers = new Map<number, Timer>();

  const fakeSetTimeout = (fn: (...args: unknown[]) => void, ms = 0, ...args: unknown[]): object => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { id, at: now + Math.max(0, ms), fn, args });
    const handle = {
      id,
      unref: () => handle,
      ref: () => handle,
      hasRef: () => true,
      [Symbol.toPrimitive]: () => id,
    };
    return handle;
  };
  const fakeClearTimeout = (handle: { id?: number } | undefined): void => {
    if (handle?.id !== undefined) timers.delete(handle.id);
  };
  globalThis.setTimeout = fakeSetTimeout as unknown as typeof setTimeout;
  globalThis.clearTimeout = fakeClearTimeout as unknown as typeof clearTimeout;
  Date.now = () => now;
  performance.now = () => now - startedAt;

  const fileWorkPending = (): boolean => process.getActiveResourcesInfo().some((name) => name.startsWith('FSReq'));
  const turn = (): Promise<void> => new Promise((resolve) => realSetImmediate(resolve));

  return {
    async runUntil(done) {
      for (;;) {
        do {
          await turn();
          await turn();
        } while (fileWorkPending());
        if (done()) return;

        let next: Timer | undefined;
        for (const timer of timers.values()) {
          if (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
        }
        if (!next) throw new Error('Nothing is scheduled, so the job has stalled.');
        timers.delete(next.id);
        now = Math.max(now, next.at);
        next.fn(...next.args);
      }
    },
  };
}
