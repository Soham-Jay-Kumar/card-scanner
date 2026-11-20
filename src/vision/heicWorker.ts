/** Runs heic-convert off the main thread. See heic.ts for why. */
import { parentPort, workerData } from 'node:worker_threads';
import convert from 'heic-convert';

const { buffer } = workerData as { buffer: Uint8Array };
// PNG, not JPEG: lossless, and heic-convert's JavaScript PNG encoder is the faster of the two.
const png = await convert({ buffer, format: 'PNG' });
parentPort?.postMessage(new Uint8Array(png));
