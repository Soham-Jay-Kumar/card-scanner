/**
 * Drives the real app in-process through its HTTP API, with the fake OpenAI server
 * as baseURL and a real SQLite file. Never calls /copy, which writes the Mac clipboard.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { Resolver } from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG } from '../../src/shared/config.ts';
import type { Card, CardRow, Job, JobProgress, JobStatus, ReadRecord, Reconciliation, SourceFile } from '../../src/shared/contracts.ts';
import type { AppOptions, CardScannerApp } from '../../src/server/app.ts';

export const FULL_SYNTH = process.env.RUN_FULL_SYNTH === '1';
export const THOUSAND_CARDS = process.env.RUN_1000_CARDS === '1';

type CreateApp = (options: AppOptions) => CardScannerApp;

export interface LoadedApp {
  createApp: CreateApp | null;
  skipReason: string;
}

/**
 * The whole app, or the reason it can't be loaded yet. Only a missing module skips.
 * A module that exists and is broken fails loudly. REQUIRE_APP=1 turns a skip into a failure.
 */
export async function loadApp(): Promise<LoadedApp> {
  try {
    const module = (await import('../../src/server/app.ts')) as { createApp: CreateApp };
    return { createApp: module.createApp, skipReason: '' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND' || process.env.REQUIRE_APP === '1') throw error;
    const skipReason = `Skipped because a module is missing: ${(error as Error).message}`;
    console.warn(skipReason);
    return { createApp: null, skipReason };
  }
}

/** Short retries, so failure tests take seconds. Must run before createApp. */
export function tuneForTests(requestTimeoutMs = 30_000): void {
  Object.assign(CONFIG.retries as unknown as Record<string, number>, { baseDelayMs: 20, maxDelayMs: 200, requestTimeoutMs });
}

export interface FakeDns {
  setMissing(domains: Iterable<string>): void;
  restore(): void;
}

/**
 * createApp has no way to inject resolveDomain, so this patches the one class the
 * app's DNS check uses. No real lookup leaves this Mac during a test.
 */
export function installFakeDns(missing: Iterable<string> = []): FakeDns {
  let absent = new Set(missing);
  const proto = Resolver.prototype as unknown as Record<string, unknown>;
  const original = { resolve4: proto['resolve4'], resolve6: proto['resolve6'], resolveMx: proto['resolveMx'] };
  const answer = (value: unknown[]) =>
    async function (domain: string) {
      if (absent.has(domain.toLowerCase())) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
      return value;
    };
  proto['resolve4'] = answer(['192.0.2.1']);
  proto['resolve6'] = answer(['2001:db8::1']);
  proto['resolveMx'] = answer([{ exchange: 'mail.test', priority: 10 }]);
  return {
    setMissing(domains) {
      absent = new Set(domains);
    },
    restore() {
      Object.assign(proto, original);
    },
  };
}

export async function tempDataDir(): Promise<string> {
  return mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'card-scanner-test-'));
}

export type CardSummary = {
  id: string;
  status: Card['status'];
  row: CardRow | null;
  flaggedFields: string[];
  sourceName: string;
  sourceFileIds: string[];
  error: string | null;
};

export interface UploadItem {
  name: string;
  bytes: Buffer;
}

export interface TestApp {
  app: CardScannerApp;
  dataDir: string;
  raw(path: string, init?: RequestInit): Promise<Response>;
  api<T = unknown>(path: string, init?: RequestInit): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  newJob(options?: { name?: string; frontBackPairs?: boolean; defaultCountry?: string; costCapUsd?: number }): Promise<Job>;
  upload(jobId: string, item: UploadItem): Promise<SourceFile>;
  /** Creates a job, uploads the files, starts it and waits until it stops. */
  runJob(items: UploadItem[], options?: Parameters<TestApp['newJob']>[0], timeoutMs?: number): Promise<{ job: Job; progress: JobProgress }>;
  waitForStatus(jobId: string, statuses: JobStatus[], timeoutMs?: number): Promise<JobProgress>;
  files(jobId: string): Promise<SourceFile[]>;
  cards(jobId: string): Promise<CardSummary[]>;
  cardDetail(cardId: string): Promise<{ card: Card; reads: ReadRecord[] }>;
  reconciliation(jobId: string): Promise<Reconciliation>;
  /** Rows a person could copy, by the same query /copy uses, without touching the clipboard. */
  copyable(jobId: string): Array<{ cardId: string; row: CardRow }>;
  close(): Promise<void>;
}

export async function startTestApp(
  createApp: CreateApp,
  options: { baseURL?: string; apiKey?: string; dataDir?: string; keepData?: boolean; realRetries?: boolean; requestTimeoutMs?: number },
): Promise<TestApp> {
  if (!options.realRetries) tuneForTests(options.requestTimeoutMs);
  const dataDir = options.dataDir ?? (await tempDataDir());
  const app = createApp({ dataDir, apiKey: options.apiKey ?? 'test-key', ...(options.baseURL ? { baseURL: options.baseURL } : {}) });

  const raw = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('host', '127.0.0.1:4173');
    return Promise.resolve(app.http.request(`http://127.0.0.1:4173${path}`, { ...init, headers }));
  };

  const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await raw(path, init);
    if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} gave ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  };

  const post = <T,>(path: string, body?: unknown) =>
    api<T>(path, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });

  const service: TestApp = {
    app,
    dataDir,
    raw,
    api,
    post,
    newJob: (jobOptions = {}) => post<Job>('/api/jobs', { name: 'test job', ...jobOptions }),
    upload: (jobId, item) =>
      api<SourceFile>(`/api/jobs/${jobId}/files`, {
        method: 'POST',
        body: new Uint8Array(item.bytes),
        headers: { 'x-file-name': encodeURIComponent(item.name) },
      }),
    async runJob(items, jobOptions, timeoutMs = 60_000) {
      const job = await service.newJob(jobOptions);
      for (const item of items) await service.upload(job.id, item);
      await post(`/api/jobs/${job.id}/start`);
      const progress = await service.waitForStatus(job.id, ['done', 'paused', 'cancelled'], timeoutMs);
      return { job, progress };
    },
    async waitForStatus(jobId, statuses, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const progress = await api<JobProgress>(`/api/jobs/${jobId}/progress`);
        if (statuses.includes(progress.status)) return progress;
        if (Date.now() > deadline) {
          throw new Error(`Job ${jobId} stayed ${progress.status}, wanted ${statuses.join(' or ')}: ${JSON.stringify(progress.reconciliation)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    files: (jobId) => api<SourceFile[]>(`/api/jobs/${jobId}/files`),
    cards: (jobId) => api<CardSummary[]>(`/api/jobs/${jobId}/cards`),
    cardDetail: (cardId) => api<{ card: Card; reads: ReadRecord[] }>(`/api/cards/${cardId}`),
    reconciliation: async (jobId) => (await api<JobProgress>(`/api/jobs/${jobId}/progress`)).reconciliation,
    copyable: (jobId) => app.store.getCopyableRows(jobId),
    async close() {
      await app.shutdown();
      if (!options.keepData) await rm(dataDir, { recursive: true, force: true });
    },
  };
  return service;
}

const CHILD_SCRIPT = join(import.meta.dirname, '..', 'e2e', 'helpers', 'job-child.ts');

export interface ChildRun {
  process: import('node:child_process').ChildProcess;
  /** Resolves with how the process ended. */
  ended: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
}

/** Runs the real app in a separate process that a test can kill with SIGKILL. */
export function spawnJobChild(args: { dataDir: string; baseURL: string; jobId: string; flags: string[] }): ChildRun {
  const child = spawn(process.execPath, [CHILD_SCRIPT, '--data', args.dataDir, '--base-url', args.baseURL, '--job', args.jobId, ...args.flags], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => {
    // The ledger noise of one defect must not swamp a real crash report.
    if (output.length < 200_000) output += chunk.toString();
  });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });
  return { process: child, ended };
}
