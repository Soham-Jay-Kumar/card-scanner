import { describe, expect, it } from 'vitest';
import { Gate, WorkQueue } from './queue.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Gate', () => {
  it('runs no more than its size and serves in order', async () => {
    const gate = new Gate(2);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        gate.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          order.push(i);
          await tick();
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(gate.active).toBe(0);
  });

  it('frees the slot when a task throws', async () => {
    const gate = new Gate(1);
    await expect(gate.run(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(gate.run(() => Promise.resolve(1))).resolves.toBe(1);
  });
});

describe('WorkQueue', () => {
  it('hands out items in order, then ends once closed and empty', async () => {
    const queue = new WorkQueue<number>();
    queue.push([1, 2]);
    queue.close();
    expect(await queue.take()).toBe(1);
    expect(await queue.take()).toBe(2);
    expect(await queue.take()).toBeUndefined();
  });

  it('makes a worker wait for an item', async () => {
    const queue = new WorkQueue<number>();
    const taken = queue.take();
    await tick();
    queue.push([7]);
    expect(await taken).toBe(7);
  });

  it('counts cards being worked on in the backlog', async () => {
    const queue = new WorkQueue<number>();
    queue.push([1, 2]);
    await queue.take();
    expect(queue.backlog).toBe(2);
    queue.finishOne();
    expect(queue.backlog).toBe(1);
  });

  it('holds a producer until there is room', async () => {
    const queue = new WorkQueue<number>();
    queue.push([1, 2, 3]);
    let released = false;
    const waiting = queue.waitForRoom(3).then(() => {
      released = true;
    });
    await tick();
    expect(released).toBe(false);
    await queue.take();
    await tick();
    expect(released).toBe(false);
    queue.finishOne();
    await waiting;
    expect(released).toBe(true);
  });

  it('releases everyone at once on stop, leaving items unprocessed', async () => {
    const queue = new WorkQueue<number>();
    const idleWorker = queue.take();
    queue.push([1, 2, 3, 4]);
    await idleWorker;
    const producer = queue.waitForRoom(1);
    queue.stop();
    await producer;
    expect(await queue.take()).toBeUndefined();
  });
});
