/** Entry point for `npm start`. Listens on this Mac only. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';

import { CONFIG } from '../shared/config.ts';
import { createApp } from './app.ts';

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const dataDir = resolve(CONFIG.paths.dataDir);
mkdirSync(dataDir, { recursive: true });

const webDir = 'dist/web';
const app = createApp({
  dataDir,
  ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
  ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
  ...(existsSync(webDir) ? { staticDir: webDir } : {}),
});

const { host } = CONFIG.server;
const port = Number(process.env.PORT ?? CONFIG.server.port);

const server = serve({ fetch: app.http.fetch, hostname: host, port }, () => {
  const url = `http://${host}:${port}`;
  console.log(`Card Scanner is running at ${url}`);
  if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL) {
    console.log('No OpenAI API key found. Add OPENAI_API_KEY to .env.local, then restart.');
  }
  app.engine.recover();
  if (process.env.NO_OPEN !== '1') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await app.shutdown();
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
