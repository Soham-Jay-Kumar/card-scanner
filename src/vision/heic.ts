import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

/**
 * heic-convert is synchronous JavaScript and WebAssembly, taking several seconds
 * for a 12MP photo. On the main thread that would freeze the server and stall
 * every in-flight model call, so each conversion gets a worker. Workers are
 * capped because each holds a full decoded photo in memory, whatever concurrency
 * the job engine runs at.
 */
const MAX_HEIC_WORKERS = Math.max(1, Math.floor(availableParallelism() / 2));

let running = 0;
const waiting: Array<() => void> = [];

async function withWorkerSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running < MAX_HEIC_WORKERS) running += 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}

function convertInWorker(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./heicWorker.ts', import.meta.url), { workerData: { buffer: bytes } });
    worker.once('message', (png: Uint8Array) => resolve(Buffer.from(png)));
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`HEIC worker stopped early with code ${code}`)));
  });
}

/** Decodes the main image, already upright: libheif applies the container's rotation. */
export function heicToPng(bytes: Buffer): Promise<Buffer> {
  return withWorkerSlot(() => convertInWorker(bytes));
}
