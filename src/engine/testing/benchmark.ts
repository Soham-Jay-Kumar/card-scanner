/**
 * SIMULATED throughput benchmark. Not part of `vitest run`.
 *
 *   node src/engine/testing/benchmark.ts <scenario> [--real-clock]
 *
 * Runs the real engine, LLM client, limiter and SQLite store with fake vision and
 * extraction and a simulated API, so every figure is simulated, never a real API
 * result. Run one scenario per process, so peak memory stays comparable.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createStore } from '../../data/index.ts';
import { CONFIG } from '../../shared/config.ts';
import type { DecisionService, ExtractionService, LlmClient, ReadOutcome, VisionService } from '../../shared/contracts.ts';
import { createLlmClient } from '../../llm/index.ts';
import { createJobEngine } from '../engine.ts';
import { IMAGE_SLOTS } from '../pipeline.ts';
import { SAMPLE_READ, fakeDecision, fakeExtraction } from './fakes.ts';
import { simulatedApi, type ApiModel } from './simulatedApi.ts';
import { installVirtualClock } from './virtualClock.ts';

/** Assumed. Build-tier limits are from the brief; Luna's latency is unknown until a real run. */
const BASE_API: ApiModel = {
  readLatencyMs: 8_000,
  locateLatencyMs: 5_000,
  tokensPerMinute: 2_000_000,
  requestsPerMinute: 5_000,
  reserveMaxOutput: false,
  rampRule: false,
  errorRate: 0.005,
};

const SINGLES = Array.from({ length: 1_000 }, () => 1);
/** 720 cards on 20 sheets, 280 on their own, spread through the job. */
const MIXED = Array.from({ length: 300 }, (_, i) => (i % 15 === 0 ? 36 : 1));
const SHEETS = Array.from({ length: 28 }, () => 36);

const SCENARIOS: Record<string, { cardsPerFile: number[]; api: ApiModel }> = {
  single: { cardsPerFile: SINGLES, api: BASE_API },
  mixed: { cardsPerFile: MIXED, api: BASE_API },
  sheets: { cardsPerFile: SHEETS, api: BASE_API },
  'single-fast-reads': { cardsPerFile: SINGLES, api: { ...BASE_API, readLatencyMs: 4_000, locateLatencyMs: 3_000 } },
  'single-slow-reads': { cardsPerFile: SINGLES, api: { ...BASE_API, readLatencyMs: 20_000, locateLatencyMs: 10_000 } },
  'single-ramp-rule': { cardsPerFile: SINGLES, api: { ...BASE_API, rampRule: true } },
  'mixed-ramp-rule': { cardsPerFile: MIXED, api: { ...BASE_API, rampRule: true } },
  'single-reserved-output': { cardsPerFile: SINGLES, api: { ...BASE_API, reserveMaxOutput: true } },
  'mixed-reserved-output': { cardsPerFile: MIXED, api: { ...BASE_API, reserveMaxOutput: true } },
};

/** Full-size image bytes in these, because they report memory. Others only report speed. */
const MEMORY_SCENARIOS = new Set(['single', 'mixed', 'sheets']);

const CPU_MS = { normalize: 300, quality: 50, locateImages: 200, cropBase: 150, cropPerCard: 40, prepare: 350 };
const FIXTURE_BYTES = { read: 1_500_000, locate: 3_000_000 };
const answerSchema = z.object({ ok: z.boolean() });

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function benchVision(llm: LlmClient, locateImage: string, readImage: string, cardsByName: Map<string, number>): VisionService {
  let peak = 0;
  let active = 0;
  const cpu = async (ms: number): Promise<void> => {
    active += 1;
    peak = Math.max(peak, active);
    await wait(ms);
    active -= 1;
  };
  const report = { ok: true, width: 1_600, height: 900, blurScore: 500, meanLuminance: 120, issues: [] };
  const pass = (ctx: Parameters<VisionService['locate']>[1], cards: number) =>
    llm.parse(
      {
        instructions: 'Find the cards.',
        userText: `sheet-cards=${cards}`,
        imagePaths: [locateImage],
        schema: answerSchema,
        schemaName: 'card_locations',
        reasoningEffort: CONFIG.reasoningEffort.locate,
        maxOutputTokens: CONFIG.maxOutputTokens.locate,
      },
      ctx,
    );

  return {
    async normalize({ originalName }) {
      await cpu(CPU_MS.normalize);
      return { path: originalName, width: 4_000, height: 3_000, sourceFormat: 'jpeg' };
    },
    async assessQuality() {
      await cpu(CPU_MS.quality);
      return report;
    },
    async locate(image, ctx) {
      const cards = cardsByName.get(image.path) ?? 1;
      await wait(CPU_MS.locateImages);
      // Two passes in parallel, as the real locate does.
      await Promise.all([pass(ctx, cards), pass(ctx, cards)]);
      const box = { x: 0, y: 0, width: 10, height: 10 };
      return {
        noCard: false,
        locations: Array.from({ length: cards }, () => ({ box, rotation: 0 as const })),
        fellBackToFullImage: false,
        countConfirmed: true,
        note: null,
      };
    },
    async crop(_image, locate) {
      await cpu(CPU_MS.cropBase + CPU_MS.cropPerCard * locate.locations.length);
      return locate.locations.map(() => ({ path: readImage, width: 1_600, height: 900, side: 'single' as const, quality: report }));
    },
    async prepareReadImages() {
      await cpu(CPU_MS.prepare);
      return { A: readImage, B: readImage, C: readImage };
    },
  };
}

function benchExtraction(llm: LlmClient): ExtractionService {
  const base = fakeExtraction();
  return {
    ...base,
    async readCard({ imagePaths }, ctx): Promise<ReadOutcome> {
      const result = await llm.parse(
        {
          instructions: 'Read the card.',
          userText: 'Read this.',
          imagePaths,
          schema: answerSchema,
          schemaName: 'card_read',
          reasoningEffort: CONFIG.reasoningEffort.read,
          maxOutputTokens: CONFIG.maxOutputTokens.read,
        },
        ctx,
      );
      return result.ok ? { ok: true, data: SAMPLE_READ } : { ok: false, failure: result.failure, detail: result.detail };
    },
  };
}

async function main(): Promise<void> {
  const name = process.argv[2] ?? '';
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Choose a scenario: ${Object.keys(SCENARIOS).join(', ')}`);
  const realClock = process.argv.includes('--real-clock');

  const root = mkdtempSync(join(process.env.BENCH_DIR ?? tmpdir(), 'bench-'));
  mkdirSync(join(root, 'jobs'));
  const locateImage = join(root, 'locate.jpg');
  const readImage = join(root, 'read.jpg');
  const imageScale = MEMORY_SCENARIOS.has(name) ? 1 : 0.001;
  writeFileSync(locateImage, randomBytes(FIXTURE_BYTES.locate * imageScale));
  writeFileSync(readImage, randomBytes(FIXTURE_BYTES.read * imageScale));

  const clock = realClock ? null : installVirtualClock();
  const startedAt = Date.now();
  const api = simulatedApi(scenario.api);
  const store = createStore(join(root, 'bench.sqlite'));
  const job = store.createJob({
    name,
    options: { frontBackPairs: false, defaultCountry: null, costCapUsd: 1_000 },
  });
  const cardsByName = new Map<string, number>();
  scenario.cardsPerFile.forEach((cards, index) => {
    const originalName = `file-${index}.jpg`;
    cardsByName.set(originalName, cards);
    store.addFile({ jobId: job.id, originalName, sha256: randomUUID(), byteSize: 1, storedPath: originalName });
  });
  const totalCards = scenario.cardsPerFile.reduce((sum, cards) => sum + cards, 0);

  const llm = createLlmClient({
    apiKey: 'simulated',
    fetch: api.fetch,
    onCall: (entry) => store.recordLlmCall(entry),
    getSpendUsd: (jobId) => store.getJobSpendUsd(jobId),
    getCostCapUsd: (jobId) => store.getJob(jobId)?.options.costCapUsd ?? 0,
  });
  const decision: DecisionService = fakeDecision();
  const engine = createJobEngine({
    store,
    vision: benchVision(llm, locateImage, readImage, cardsByName),
    extraction: benchExtraction(llm),
    decision,
    jobsDir: join(root, 'jobs'),
    getLlmConcurrency: () => llm.getConcurrency(),
  });

  let peakRssMb = 0;
  let peakHeapMb = 0;
  let peakConcurrency = 0;
  let peakRate = 0;
  let unfinishedPeak = 0;
  const memoryByQuarter: number[] = [0, 0, 0, 0];
  engine.subscribe((progress) => {
    const { rss, heapUsed } = process.memoryUsage();
    const rssMb = rss / 1_048_576;
    peakRssMb = Math.max(peakRssMb, rssMb);
    peakHeapMb = Math.max(peakHeapMb, heapUsed / 1_048_576);
    peakConcurrency = Math.max(peakConcurrency, progress.concurrency);
    peakRate = Math.max(peakRate, progress.cardsPerMinute);
    unfinishedPeak = Math.max(unfinishedPeak, progress.reconciliation.cardsInProgress);
    const finished = progress.reconciliation.cards - progress.reconciliation.cardsInProgress;
    const quarter = Math.min(3, Math.floor((finished / totalCards) * 4));
    memoryByQuarter[quarter] = Math.max(memoryByQuarter[quarter] ?? 0, rssMb);
  });

  const isFinished = (): boolean => {
    const status = store.getJob(job.id)?.status;
    return status === 'done' || status === 'paused';
  };
  engine.start(job.id);
  if (clock) await clock.runUntil(isFinished);
  else while (!isFinished()) await wait(1_000);

  const minutes = (Date.now() - startedAt) / 60_000;
  const progress = engine.getProgress(job.id);
  const rec = progress.reconciliation;
  console.log(
    JSON.stringify({
      label: 'SIMULATED',
      scenario: name,
      clock: realClock ? 'real' : 'virtual',
      status: progress.status,
      files: rec.files,
      cards: rec.cards,
      verified: rec.verified,
      needsReview: rec.needsReview,
      balanced: rec.balanced,
      minutes: Number(minutes.toFixed(1)),
      cardsPerMinute: Number((rec.cards / minutes).toFixed(1)),
      peakApiInFlight: api.stats.peakInFlight,
      peakLimiter: peakConcurrency,
      imageSlots: IMAGE_SLOTS,
      peakUnfinishedCards: unfinishedPeak,
      peakRssMb: Math.round(peakRssMb),
      peakHeapMb: Math.round(peakHeapMb),
      rssByQuarterOfJobMb: memoryByQuarter.map(Math.round),
      requests: api.stats.requests,
      rateLimited429: api.stats.rateLimited,
      slowDown429: api.stats.slowDowns,
      server5xx: api.stats.serverErrors,
      tokensPerCard: Math.round((api.stats.inputTokens + api.stats.outputTokens) / rec.cards),
      costUsd: Number(progress.spendUsd.toFixed(2)),
    }),
  );

  await engine.shutdown();
  store.close();
  rmSync(root, { recursive: true, force: true });
}

await main();
