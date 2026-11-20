import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStore } from '../data/index.ts';
import { CONFIG } from '../shared/config.ts';
import {
  JobPauseError,
  READ_VARIANTS,
  type DecisionService,
  type ExtractionService,
  type Job,
  type JobEngine,
  type JobOptions,
  type JobProgress,
  type LlmCallContext,
  type PauseReason,
  type QualityReport,
  type ReadOutcome,
  type VisionService,
} from '../shared/contracts.ts';
import { createJobEngine } from './engine.ts';
import { CARD_BACKLOG_LIMIT, FILE_WORKERS, IMAGE_SLOTS, NETWORK_SLOTS } from './pipeline.ts';
import { fakeDecision, fakeExtraction, fakeVision, SAMPLE_READ, type FilePlan, type ReadCall } from './testing/fakes.ts';
import { MemoryStore, type WriteName } from './testing/memoryStore.ts';

let jobsDir: string;
beforeAll(() => {
  jobsDir = mkdtempSync(join(tmpdir(), 'engine-test-'));
});
afterAll(() => rmSync(jobsDir, { recursive: true, force: true }));

const engines: JobEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.shutdown()));
  vi.restoreAllMocks();
});

function newEngine(store: MemoryStore, vision: VisionService, extraction: ExtractionService, decision: DecisionService = fakeDecision()): JobEngine {
  const engine = createJobEngine({ store, vision, extraction, decision, jobsDir });
  engines.push(engine);
  return engine;
}

function addJob(store: MemoryStore, files: Array<string | { name: string; sha?: string }>, options: Partial<JobOptions> = {}): Job {
  const job = store.createJob({ name: 'test', options: { frontBackPairs: false, defaultCountry: null, costCapUsd: 10, ...options } });
  for (const entry of files) {
    const { name, sha } = typeof entry === 'string' ? { name: entry, sha: undefined } : entry;
    store.addFile({ jobId: job.id, originalName: name, sha256: sha ?? name, byteSize: 100, storedPath: `/uploads/${name}` });
  }
  return job;
}

async function waitFor(condition: () => boolean, label = 'condition'): Promise<void> {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error(`Waiting for ${label}`);
    },
    { timeout: 10_000, interval: 2 },
  );
}

const statusOf = (store: MemoryStore, job: Job): string | undefined => store.getJob(job.id)?.status;
const isDone = (store: MemoryStore, job: Job) => (): boolean => statusOf(store, job) === 'done';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function abortable(ctx: LlmCallContext): Promise<never> {
  return new Promise((_resolve, reject) => {
    ctx.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
}

const pauseWith = (reason: PauseReason) => new JobPauseError(reason, reason);

describe('file pipeline', () => {
  it('runs a job to done and accounts for every file and card', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg', 'b.jpg', 'sheet.jpg']);
    const vision = fakeVision({ plans: { 'sheet.jpg': { cards: 8 } } });
    const extraction = fakeExtraction();
    newEngine(store, vision, extraction).start(job.id);
    await waitFor(isDone(store, job), 'done');

    const rec = store.getReconciliation(job.id);
    expect(rec).toMatchObject({ files: 3, cards: 10, verified: 10, cardsInProgress: 0, filesInProgress: 0, balanced: true });
    expect(extraction.calls).toHaveLength(30);
    for (const card of store.listCards(job.id)) {
      expect(card).toMatchObject({ stage: 'decided', status: 'verified', finalRow: { name: 'Jane Doe' } });
      expect(store.listReads(card.id)).toHaveLength(3);
    }
    expect(store.listFiles(job.id).every((file) => file.stage === 'cropped')).toBe(true);
    expect(store.markDuplicatesCalls).toBe(1);
  });

  it('writes each stage in order, before the next stage begins', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const seen: string[] = [];
    const vision = fakeVision({
      before: (step) => {
        seen.push(`${step}:${store.listFiles(job.id)[0]?.stage}`);
      },
    });
    newEngine(store, vision, fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(seen.slice(0, 4)).toEqual(['normalize:received', 'assessQuality:normalized', 'locate:quality_checked', 'crop:located']);
  });

  it('records a failing file and keeps going', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['bad.jpg', 'good.jpg', 'badcrop.jpg']);
    const vision = fakeVision({ plans: { 'bad.jpg': { failAt: 'normalize' }, 'badcrop.jpg': { failAt: 'crop' } } });
    newEngine(store, vision, fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');

    const files = store.listFiles(job.id);
    expect(files[0]).toMatchObject({ stage: 'failed', error: expect.stringContaining('normalize failed') });
    expect(files[2]).toMatchObject({ stage: 'failed', error: expect.stringContaining('crop failed') });
    expect(store.getReconciliation(job.id)).toMatchObject({ failedFiles: 2, cards: 1, verified: 1, balanced: true });
  });

  it('fails a file rather than lose a card when crop returns too few', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['sheet.jpg']);
    const vision = fakeVision({ plans: { 'sheet.jpg': { cards: 3 } } });
    const crop = vision.crop.bind(vision);
    vision.crop = async (...args) => (await crop(...args)).slice(0, 2);
    newEngine(store, vision, fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(store.listFiles(job.id)[0]).toMatchObject({ stage: 'failed', error: expect.stringContaining('Expected 3') });
  });

  it('ends a file with no card as no_card and skips duplicates', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['blank.jpg', { name: 'a.jpg', sha: 'same' }, { name: 'a-copy.jpg', sha: 'same' }]);
    const vision = fakeVision({ plans: { 'blank.jpg': { cards: 0 } } });
    newEngine(store, vision, fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');

    expect(store.getReconciliation(job.id)).toMatchObject({ noCardFiles: 1, duplicateFiles: 1, cards: 1, balanced: true });
    expect(vision.calls.some((call) => call.detail.includes('a-copy'))).toBe(false);
  });
});

describe('card pipeline', () => {
  it('sends a card with every read failed to review, never drops it', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const extraction = fakeExtraction(() => ({ ok: false, failure: 'refused', detail: 'no' }));
    const decision = fakeDecision();
    newEngine(store, fakeVision(), extraction, decision).start(job.id);
    await waitFor(isDone(store, job), 'done');

    const [card] = store.listCards(job.id);
    expect(card).toMatchObject({ status: 'needs_review', stage: 'decided', finalRow: null });
    expect(decision.calls[0]?.reads).toHaveLength(3);
    expect(store.getReconciliation(job.id)).toMatchObject({ needsReview: 1, balanced: true });
  });

  it('records an unexpected read error as a failed read, and the card still gets decided', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const extraction = fakeExtraction(({ variant }) => {
      if (variant === 'B') throw new Error('disk error');
      return { ok: true, data: SAMPLE_READ };
    });
    newEngine(store, fakeVision(), extraction).start(job.id);
    await waitFor(isDone(store, job), 'done');

    const [card] = store.listCards(job.id);
    expect(card?.status).toBe('needs_review');
    const failed = store.listReads(card?.id ?? '').find((read) => read.variant === 'B');
    expect(failed?.outcome).toMatchObject({ ok: false, failure: 'retries_exhausted', detail: 'disk error' });
  });

  it('marks a card failed when its images cannot be prepared, and the job still ends', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg', 'b.jpg']);
    const vision = fakeVision({
      before: (step, detail) => {
        if (step === 'prepareReadImages' && detail.includes('x0') && store.listCards(job.id).length > 0) {
          const first = store.listCards(job.id)[0];
          if (detail === first?.crops[0]?.path) throw new Error('corrupt crop');
        }
      },
    });
    newEngine(store, vision, fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(store.getReconciliation(job.id)).toMatchObject({ failedCards: 1, verified: 1, balanced: true });
    expect(store.listCards(job.id).find((card) => card.status === 'failed')?.error).toContain('corrupt crop');
  });

  it("gives decide the card's own crop quality, not the file's", async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['sheet.jpg']);
    const blurry: QualityReport = { ok: false, width: 300, height: 180, blurScore: 3, meanLuminance: 100, issues: ['low_resolution', 'blurry'] };
    const vision = fakeVision({
      plans: { 'sheet.jpg': { cards: 3 } },
      cropQuality: (_path, index) => (index === 1 ? blurry : { ...blurry, ok: true, issues: [] }),
    });
    const decision = fakeDecision();
    newEngine(store, vision, fakeExtraction(), decision).start(job.id);
    await waitFor(isDone(store, job), 'done');

    expect(decision.calls.map((call) => call.quality?.ok).toSorted()).toEqual([false, true, true]);
    const review = store.listCards(job.id).filter((card) => card.status === 'needs_review');
    expect(review.map((card) => card.indexInSource)).toEqual([1]);
  });

  it('passes the default country through to decide', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg'], { defaultCountry: 'IN' });
    const decision = fakeDecision();
    newEngine(store, fakeVision(), fakeExtraction(), decision).start(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(decision.calls[0]?.defaultCountry).toBe('IN');
  });
});

describe('retrying answers extraction rejected', () => {
  const rejected: ReadOutcome = { ok: false, failure: 'schema_invalid', detail: 'Read A: the transcript is empty' };

  it('retries once and keeps the good answer', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    let attempts = 0;
    const extraction = fakeExtraction(({ variant }) => {
      if (variant !== 'A') return { ok: true, data: SAMPLE_READ };
      attempts += 1;
      return attempts === 1 ? rejected : { ok: true, data: SAMPLE_READ };
    });
    newEngine(store, fakeVision(), extraction).start(job.id);
    await waitFor(isDone(store, job), 'done');

    expect(attempts).toBe(2);
    const [card] = store.listCards(job.id);
    expect(card?.status).toBe('verified');
    expect(store.listReads(card?.id ?? '').every((read) => read.outcome.ok)).toBe(true);
    expect(store.writes.filter((name) => name === 'saveRead')).toHaveLength(3);
  });

  it('saves the failure after the second attempt, and the card goes to review', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const extraction = fakeExtraction(({ variant }) => (variant === 'B' ? rejected : { ok: true, data: SAMPLE_READ }));
    newEngine(store, fakeVision(), extraction).start(job.id);
    await waitFor(isDone(store, job), 'done');

    expect(extraction.calls.filter((call) => call.variant === 'B')).toHaveLength(2);
    const [card] = store.listCards(job.id);
    expect(card?.status).toBe('needs_review');
    const read = store.listReads(card?.id ?? '').find((record) => record.variant === 'B');
    expect(read).toMatchObject({ model: CONFIG.model, usage: null, outcome: { ok: false, failure: 'schema_invalid' } });
  });

  it.each(['refused', 'incomplete', 'retries_exhausted'] as const)('does not retry %s, which the client already handled', async (failure) => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const extraction = fakeExtraction(({ variant }) =>
      variant === 'A' ? { ok: false, failure, detail: 'no' } : { ok: true, data: SAMPLE_READ },
    );
    newEngine(store, fakeVision(), extraction).start(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(extraction.calls.filter((call) => call.variant === 'A')).toHaveLength(1);
  });

  it('does not run a saved failure again after a restart', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    store.crashAfter((name, count) => name === 'saveRead' && count === 1);
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = createJobEngine({
      store,
      vision: fakeVision(),
      extraction: fakeExtraction(() => rejected),
      decision: fakeDecision(),
      jobsDir,
    });
    first.start(job.id);
    await waitFor(() => store.writes.includes('saveRead'), 'a saved failure');
    await first.shutdown();
    silence.mockRestore();
    store.reopen();
    store.setJobStatus(job.id, 'running', null);

    const [card] = store.listCards(job.id);
    const saved = store.listReads(card?.id ?? '')[0]?.variant;
    const second = fakeExtraction();
    newEngine(store, fakeVision(), second).recover();
    await waitFor(isDone(store, job), 'done');
    expect(second.calls.map((call) => call.variant)).not.toContain(saved);
    expect(second.calls).toHaveLength(2);
  });

  it('saves nothing when a pause interrupts the retry, so the read runs afresh on resume', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    let attempts = 0;
    const extraction = fakeExtraction(({ variant }) => {
      if (variant !== 'A') return { ok: true, data: SAMPLE_READ };
      attempts += 1;
      if (attempts === 1) return rejected;
      if (attempts === 2) throw pauseWith('network');
      return { ok: true, data: SAMPLE_READ };
    });
    const engine = newEngine(store, fakeVision(), extraction);
    engine.start(job.id);
    await waitFor(() => statusOf(store, job) === 'paused', 'paused');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const [card] = store.listCards(job.id);
    expect(store.listReads(card?.id ?? '').map((read) => read.variant)).not.toContain('A');

    engine.resume(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(attempts).toBe(3);
    expect(store.listCards(job.id)[0]?.status).toBe('verified');
  });
});

describe('front and back pairs', () => {
  it('pairs files in seq order and sends both images to every read', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['f1.jpg', 'b1.jpg', 'f2.jpg', 'b2.jpg'], { frontBackPairs: true });
    const extraction = fakeExtraction();
    newEngine(store, fakeVision(), extraction).start(job.id);
    await waitFor(isDone(store, job), 'done');

    const files = store.listFiles(job.id);
    const cards = store.listCards(job.id);
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.sourceFileIds)).toEqual([
      [files[0]?.id, files[1]?.id],
      [files[2]?.id, files[3]?.id],
    ]);
    expect(cards[0]?.crops.map((crop) => crop.side)).toEqual(['front', 'back']);
    expect(cards[0]?.readImages).toHaveLength(2);
    const firstCardReads = extraction.calls.filter((call) => call.cardId === cards[0]?.id);
    expect(firstCardReads).toHaveLength(3);
    expect(firstCardReads.every((call) => call.imagePaths.length === 2)).toBe(true);
    expect(cards.every((card) => card.status === 'verified')).toBe(true);
    expect(store.getReconciliation(job.id)).toMatchObject({ cards: 2, balanced: true });
  });

  it('makes an unpaired last file a single card', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['f1.jpg', 'b1.jpg', 'f2.jpg'], { frontBackPairs: true });
    newEngine(store, fakeVision(), fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');

    const last = store.listCards(job.id)[1];
    expect(last?.crops.map((crop) => crop.side)).toEqual(['single']);
    expect(last?.status).toBe('verified');
  });

  it('treats each card of a multi-card file as single and flags review, for both files of the pair', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['sheet.jpg', 'back.jpg'], { frontBackPairs: true });
    const vision = fakeVision({ plans: { 'sheet.jpg': { cards: 3 } } });
    newEngine(store, vision, fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');

    const cards = store.listCards(job.id);
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card.status).toBe('needs_review');
      expect(card.finalRow).toBeNull();
      expect(card.crops.map((crop) => crop.side)).toEqual(['single']);
      expect(card.decision?.checks.some((check) => !check.passed && check.detail.includes('more than one card'))).toBe(true);
      expect(card.decision?.flaggedFields.length).toBeGreaterThan(0);
    }
    expect(store.getReconciliation(job.id)).toMatchObject({ needsReview: 4, verified: 0, balanced: true });
  });

  it('flags a multi-card unpaired last file too', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['sheet.jpg'], { frontBackPairs: true });
    newEngine(store, fakeVision({ plans: { 'sheet.jpg': { cards: 2 } } }), fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(store.getReconciliation(job.id)).toMatchObject({ needsReview: 2, balanced: true });
  });

  it('sends a front to review when its back found no card, and keeps later pairs aligned', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['f1.jpg', { name: 'dup.jpg', sha: 'f1.jpg' }, 'f2.jpg', 'blank.jpg', 'f3.jpg', 'b3.jpg'], { frontBackPairs: true });
    const vision = fakeVision({ plans: { 'blank.jpg': { cards: 0 } } });
    newEngine(store, vision, fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');

    const [f1, , f2, , f3, b3] = store.listFiles(job.id);
    const cardOf = (fileId: string | undefined) => store.listCards(job.id).find((card) => card.sourceFileIds.includes(fileId ?? ''));
    expect(cardOf(f1?.id)?.status).toBe('needs_review');
    expect(cardOf(f2?.id)?.status).toBe('needs_review');
    expect(cardOf(f3?.id)).toMatchObject({ status: 'verified', sourceFileIds: [f3?.id, b3?.id] });
    expect(cardOf(f3?.id)?.crops.map((crop) => crop.side)).toEqual(['front', 'back']);
    expect(store.getReconciliation(job.id)).toMatchObject({ duplicateFiles: 1, noCardFiles: 1, cards: 3, balanced: true });
  });

  it('gives a two-sided card the worse report, with issues combined', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['front.jpg', 'back.jpg'], { frontBackPairs: true });
    const report = (ok: boolean, issues: QualityReport['issues']): QualityReport => ({ ok, width: 900, height: 500, blurScore: 9, meanLuminance: 50, issues });
    const vision = fakeVision({
      cropQuality: (path) => (path.includes('back') ? report(false, ['too_dark', 'blurry']) : report(true, [])),
    });
    const decision = fakeDecision();
    newEngine(store, vision, fakeExtraction(), decision).start(job.id);
    await waitFor(isDone(store, job), 'done');

    expect(decision.calls[0]?.quality).toMatchObject({ ok: false, issues: ['too_dark', 'blurry'] });
    expect(store.listCards(job.id)[0]?.status).toBe('needs_review');
  });

  it('combines issues when both sides have problems', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['front.jpg', 'back.jpg'], { frontBackPairs: true });
    const report = (issues: QualityReport['issues']): QualityReport => ({ ok: false, width: 900, height: 500, blurScore: 9, meanLuminance: 50, issues });
    const vision = fakeVision({ cropQuality: (path) => report(path.includes('back') ? ['too_dark'] : ['blurry']) });
    const decision = fakeDecision();
    newEngine(store, vision, fakeExtraction(), decision).start(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(decision.calls[0]?.quality?.issues.toSorted()).toEqual(['blurry', 'too_dark']);
  });
});

/** Runs a job, stopping it dead right after the chosen write, then restarts on the same data. */
async function crashAndRecover(
  files: string[],
  plans: Record<string, FilePlan>,
  options: Partial<JobOptions>,
  crashAfter: (name: WriteName, count: number) => boolean,
): Promise<{ store: MemoryStore; job: Job; before: ReadCall[]; after: ReadCall[]; readsSavedAtCrash: Set<string> }> {
  const store = new MemoryStore();
  const job = addJob(store, files, options);
  store.crashAfter(crashAfter);

  const first = fakeExtraction();
  const firstEngine = createJobEngine({ store, vision: fakeVision({ plans }), extraction: first, decision: fakeDecision(), jobsDir });
  const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
  firstEngine.start(job.id);
  await vi.waitFor(() => {
    const stillGoing = statusOf(store, job) === 'running' && store.writes.length === 0;
    if (stillGoing) throw new Error('not started');
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The process dies. Nothing it did after the crash point reached the disk.
  await waitFor(() => (store as unknown as { crashed: boolean }).crashed || statusOf(store, job) === 'done', 'the crash');
  await firstEngine.shutdown();
  silence.mockRestore();

  store.reopen();
  // A crash can't record anything, so the job must still look interrupted.
  if (statusOf(store, job) === 'paused') store.setJobStatus(job.id, 'running', null);
  const readsSavedAtCrash = new Set(
    store.listCards(job.id).flatMap((card) => store.listReads(card.id).map((read) => `${card.id}:${read.variant}`)),
  );

  const second = fakeExtraction();
  const engine = newEngine(store, fakeVision({ plans }), second);
  engine.recover();
  await waitFor(isDone(store, job), 'done after recovery');
  return { store, job, before: first.calls, after: second.calls, readsSavedAtCrash };
}

function expectWholeJob(store: MemoryStore, job: Job, expectedCards: number): void {
  const cards = store.listCards(job.id);
  expect(cards).toHaveLength(expectedCards);
  const keys = cards.map((card) => `${card.sourceFileIds.join('+')}#${card.indexInSource}`);
  expect(new Set(keys).size).toBe(expectedCards);
  expect(cards.every((card) => card.status === 'verified')).toBe(true);
  for (const card of cards) expect(store.listReads(card.id).map((read) => read.variant).toSorted()).toEqual([...READ_VARIANTS]);
  expect(store.getReconciliation(job.id)).toMatchObject({ cards: expectedCards, cardsInProgress: 0, filesInProgress: 0, balanced: true });
}

describe('crash recovery', () => {
  const singleFiles = ['a.jpg', 'sheet.jpg'];
  const singlePlans = { 'sheet.jpg': { cards: 3 } };
  const pairFiles = ['f1.jpg', 'b1.jpg', 'f2.jpg', 'b2.jpg'];

  /** Every durable write in a clean run, so each one is tried as the crash point. */
  async function writesInCleanRun(files: string[], plans: Record<string, FilePlan>, options: Partial<JobOptions>): Promise<number> {
    const store = new MemoryStore();
    const job = addJob(store, files, options);
    newEngine(store, fakeVision({ plans }), fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');
    return store.writes.length;
  }

  it('survives a crash after every single write, losing and repeating nothing', async () => {
    const total = await writesInCleanRun(singleFiles, singlePlans, {});
    expect(total).toBeGreaterThan(30);
    for (let point = 1; point <= total; point += 1) {
      let count = 0;
      const { store, job, after, readsSavedAtCrash } = await crashAndRecover(singleFiles, singlePlans, {}, () => (count += 1) === point);
      expectWholeJob(store, job, 4);
      for (const call of after) expect(readsSavedAtCrash.has(`${call.cardId}:${call.variant}`)).toBe(false);
      const perRead = new Set(after.map((call) => `${call.cardId}:${call.variant}`));
      expect(perRead.size).toBe(after.length);
    }
  }, 120_000);

  it('survives a crash after every write of a front/back job too', async () => {
    const total = await writesInCleanRun(pairFiles, {}, { frontBackPairs: true });
    for (let point = 1; point <= total; point += 1) {
      let count = 0;
      const { store, job, after, readsSavedAtCrash } = await crashAndRecover(pairFiles, {}, { frontBackPairs: true }, () => (count += 1) === point);
      expectWholeJob(store, job, 2);
      for (const card of store.listCards(job.id)) expect(card.crops).toHaveLength(2);
      for (const call of after) expect(readsSavedAtCrash.has(`${call.cardId}:${call.variant}`)).toBe(false);
    }
  }, 120_000);

  it('neither loses nor duplicates cards after a crash at card 17 of 36', async () => {
    const plans = { 'sheet.jpg': { cards: 36 } };
    const { store, job } = await crashAndRecover(['sheet.jpg'], plans, {}, (name, count) => name === 'createCard' && count === 17);
    expectWholeJob(store, job, 36);

    const cards = store.listCards(job.id).toSorted((a, b) => a.indexInSource - b.indexInSource);
    expect(cards.map((card) => card.indexInSource)).toEqual(Array.from({ length: 36 }, (_, i) => i));
    // indexInSource matches locations order: each card holds the crop of its own location.
    expect(cards.map((card) => card.crops[0]?.path.split('/').at(-1))).toEqual(cards.map((_, i) => `crop-x${i * 10}.jpg`));
  });

  it('recovers cards made before the crash even if their file then fails to crop', async () => {
    const plans = { 'sheet.jpg': { cards: 4 } };
    const store = new MemoryStore();
    const job = addJob(store, ['sheet.jpg']);
    store.crashAfter((name, count) => name === 'createCard' && count === 2);
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = createJobEngine({ store, vision: fakeVision({ plans }), extraction: fakeExtraction(), decision: fakeDecision(), jobsDir });
    first.start(job.id);
    await waitFor(() => store.writes.filter((name) => name === 'createCard').length === 2, 'the crash');
    await first.shutdown();
    silence.mockRestore();
    store.reopen();
    store.setJobStatus(job.id, 'running', null);

    newEngine(store, fakeVision({ plans: { 'sheet.jpg': { cards: 4, failAt: 'crop' } } }), fakeExtraction()).recover();
    await waitFor(isDone(store, job), 'done');
    expect(store.getReconciliation(job.id)).toMatchObject({ failedFiles: 1, cards: 2, verified: 2, balanced: true });
  });

  it('keeps cards waiting until a re-crop has finished, so nothing reads a file being rewritten', async () => {
    const plans = { 'sheet.jpg': { cards: 6 } };
    const store = new MemoryStore();
    const job = addJob(store, ['sheet.jpg']);
    store.crashAfter((name, count) => name === 'createCard' && count === 3);
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = createJobEngine({ store, vision: fakeVision({ plans }), extraction: fakeExtraction(), decision: fakeDecision(), jobsDir });
    first.start(job.id);
    await waitFor(() => store.writes.filter((name) => name === 'createCard').length === 3, 'the crash');
    await first.shutdown();
    silence.mockRestore();
    store.reopen();
    store.setJobStatus(job.id, 'running', null);

    const order: string[] = [];
    const vision = fakeVision({
      plans,
      before: (step) => {
        if (step === 'crop' || step === 'prepareReadImages') order.push(step);
      },
    });
    newEngine(store, vision, fakeExtraction()).recover();
    await waitFor(isDone(store, job), 'done');
    expect(order[0]).toBe('crop');
    expect(order.filter((step) => step === 'crop')).toHaveLength(1);
  });

  it('never repeats a finished read after a restart', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg', 'b.jpg', 'c.jpg']);
    const silence = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.crashAfter((name, count) => name === 'saveRead' && count === 5);
    const first = fakeExtraction();
    const engine = createJobEngine({ store, vision: fakeVision(), extraction: first, decision: fakeDecision(), jobsDir });
    engine.start(job.id);
    await waitFor(() => store.writes.filter((name) => name === 'saveRead').length === 5, 'five reads');
    await engine.shutdown();
    silence.mockRestore();
    store.reopen();
    store.setJobStatus(job.id, 'running', null);

    const saved = store.listCards(job.id).flatMap((card) => store.listReads(card.id).map((read) => `${card.id}:${read.variant}`));
    expect(saved).toHaveLength(5);

    const second = fakeExtraction();
    newEngine(store, fakeVision(), second).recover();
    await waitFor(isDone(store, job), 'done');
    expect(second.calls).toHaveLength(9 - 5);
    for (const call of second.calls) expect(saved).not.toContain(`${call.cardId}:${call.variant}`);
  });

  it('recovers running and queued jobs, but not paused, done or cancelled ones', async () => {
    const store = new MemoryStore();
    const statuses = ['running', 'queued', 'paused', 'done', 'cancelled'] as const;
    const jobs = statuses.map((status) => {
      const job = addJob(store, ['a.jpg']);
      store.setJobStatus(job.id, status, status === 'paused' ? 'user' : null);
      return job;
    });
    const extraction = fakeExtraction();
    newEngine(store, fakeVision(), extraction).recover();
    await waitFor(() => statusOf(store, jobs[0] as Job) === 'done' && statusOf(store, jobs[1] as Job) === 'done', 'both recovered');
    expect(extraction.calls).toHaveLength(6);
    expect(statusOf(store, jobs[2] as Job)).toBe('paused');
  });

  it('shuts down without changing job status, and carries on after a restart', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg', 'b.jpg']);
    const started = deferred();
    const extraction = fakeExtraction((_input, ctx) => {
      started.resolve();
      return abortable(ctx);
    });
    const engine = createJobEngine({ store, vision: fakeVision(), extraction, decision: fakeDecision(), jobsDir });
    engine.start(job.id);
    await started.promise;
    await engine.shutdown();

    expect(statusOf(store, job)).toBe('running');
    expect(store.listCards(job.id).flatMap((card) => store.listReads(card.id))).toHaveLength(0);

    newEngine(store, fakeVision(), fakeExtraction()).recover();
    await waitFor(isDone(store, job), 'done');
    expect(store.getReconciliation(job.id)).toMatchObject({ cards: 2, verified: 2, balanced: true });
  });
});

describe('pause and resume', () => {
  it('stops dispatching on a user pause, lets in-flight reads finish, and resumes', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
    const hold = deferred();
    const extraction = fakeExtraction(async () => {
      await hold.promise;
      return { ok: true, data: SAMPLE_READ };
    });
    const engine = newEngine(store, fakeVision(), extraction);
    engine.start(job.id);
    await waitFor(() => extraction.calls.length >= 12, 'reads in flight');

    engine.pause(job.id);
    expect(store.getJob(job.id)).toMatchObject({ status: 'paused', pauseReason: 'user' });
    const started = extraction.calls.length;
    hold.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(extraction.calls).toHaveLength(started);
    expect(store.listCards(job.id).flatMap((card) => store.listReads(card.id))).toHaveLength(started);

    engine.resume(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(store.getReconciliation(job.id)).toMatchObject({ verified: 4, balanced: true });
  });

  it('handles a resume that arrives while reads are still draining', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg', 'b.jpg']);
    const hold = deferred();
    const extraction = fakeExtraction(async () => {
      await hold.promise;
      return { ok: true, data: SAMPLE_READ };
    });
    const engine = newEngine(store, fakeVision(), extraction);
    engine.start(job.id);
    await waitFor(() => extraction.calls.length === 6, 'all reads started');
    engine.pause(job.id);
    engine.resume(job.id);
    engine.pause(job.id);
    engine.resume(job.id);
    hold.resolve();
    await waitFor(isDone(store, job), 'done');
    expect(extraction.calls).toHaveLength(6);
  });

  it('pauses with the reason from JobPauseError, with many reads in flight', async () => {
    const store = new MemoryStore();
    const files = Array.from({ length: 40 }, (_, i) => `f${i}.jpg`);
    const job = addJob(store, files);
    const trigger = deferred();
    const release = deferred();
    let calls = 0;
    const extraction = fakeExtraction(async ({ variant }) => {
      calls += 1;
      const mine = calls;
      if (mine === 7) {
        await trigger.promise;
        throw pauseWith('out_of_credit');
      }
      await release.promise;
      if (variant === 'C' && mine > 20) throw pauseWith('bad_api_key');
      return { ok: true, data: SAMPLE_READ };
    });
    const engine = newEngine(store, fakeVision(), extraction);
    engine.start(job.id);
    await waitFor(() => calls >= NETWORK_SLOTS, 'network slots full');
    expect(calls).toBe(NETWORK_SLOTS);

    trigger.resolve();
    await waitFor(() => statusOf(store, job) === 'paused', 'paused');
    release.resolve();

    // The first reason stands: later errors from in-flight calls can't replace it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getJob(job.id)?.pauseReason).toBe('out_of_credit');
    // Stopped dispatching: at most the one slot the failed call freed, nothing after.
    expect(extraction.calls.length).toBeLessThanOrEqual(NETWORK_SLOTS + 1);

    // Nothing was recorded as a failure, and every read that came back was kept.
    const saved = store.listCards(job.id).flatMap((card) => store.listReads(card.id));
    expect(saved.every((read) => read.outcome.ok)).toBe(true);
    expect(saved.length).toBeGreaterThan(0);
    expect(store.listFiles(job.id).some((file) => file.stage === 'failed')).toBe(false);
    expect(store.listCards(job.id).some((card) => card.status === 'failed')).toBe(false);

    const savedKeys = new Set(store.listCards(job.id).flatMap((card) => store.listReads(card.id).map((read) => `${card.id}:${read.variant}`)));
    const next = fakeExtraction();
    const resumed = newEngine(store, fakeVision(), next);
    resumed.resume(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(store.getReconciliation(job.id)).toMatchObject({ cards: 40, verified: 40, balanced: true });
    for (const call of next.calls) expect(savedKeys.has(`${call.cardId}:${call.variant}`)).toBe(false);
  });

  it('pauses a file at locate without failing it, and picks up from there', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    let blocked = true;
    const vision = fakeVision({
      before: (step) => {
        if (step === 'locate' && blocked) throw pauseWith('cost_cap');
      },
    });
    const engine = newEngine(store, vision, fakeExtraction());
    engine.start(job.id);
    await waitFor(() => statusOf(store, job) === 'paused', 'paused');
    expect(store.getJob(job.id)?.pauseReason).toBe('cost_cap');
    expect(store.listFiles(job.id)[0]?.stage).toBe('quality_checked');

    blocked = false;
    engine.resume(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(vision.calls.filter((call) => call.step === 'normalize')).toHaveLength(1);
  });

  it('does not finish a job that paused on its last read', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const extraction = fakeExtraction(({ variant }) => {
      if (variant === 'C') throw pauseWith('network');
      return { ok: true, data: SAMPLE_READ };
    });
    newEngine(store, fakeVision(), extraction).start(job.id);
    await waitFor(() => statusOf(store, job) === 'paused', 'paused');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getJob(job.id)).toMatchObject({ status: 'paused', pauseReason: 'network' });
    expect(store.listCards(job.id)[0]?.status).toBe('pending');
    expect(store.markDuplicatesCalls).toBe(0);
  });
});

describe('cancel', () => {
  it('stops work, aborts calls in flight and keeps what exists', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg', 'b.jpg']);
    const extraction = fakeExtraction((input, ctx): Promise<ReadOutcome> | ReadOutcome => {
      if (input.variant === 'A') return { ok: true, data: SAMPLE_READ };
      return abortable(ctx);
    });
    const engine = newEngine(store, fakeVision(), extraction);
    engine.start(job.id);
    await waitFor(() => store.listCards(job.id).flatMap((card) => store.listReads(card.id)).length === 2, 'read A of both cards');
    await waitFor(() => extraction.calls.length === 6, 'all reads started');

    engine.cancel(job.id);
    expect(statusOf(store, job)).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(store.listCards(job.id)).toHaveLength(2);
    expect(store.listCards(job.id).flatMap((card) => store.listReads(card.id))).toHaveLength(2);

    engine.start(job.id);
    engine.resume(job.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(statusOf(store, job)).toBe('cancelled');
    expect(extraction.calls).toHaveLength(6);
  });

  it('reaches reads left over from a paused run', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const extraction = fakeExtraction((_input, ctx) => abortable(ctx));
    const engine = newEngine(store, fakeVision(), extraction);
    engine.start(job.id);
    await waitFor(() => extraction.calls.length === 3, 'reads in flight');
    engine.pause(job.id);
    engine.resume(job.id);
    engine.cancel(job.id);
    await engine.shutdown();
    expect(statusOf(store, job)).toBe('cancelled');
  });
});

describe('finishing', () => {
  it('marks duplicates, then sets done', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    newEngine(store, fakeVision(), fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');
    const writes = store.writes;
    expect(writes.indexOf('markPossibleDuplicates')).toBeLessThan(writes.lastIndexOf('setJobStatus'));
  });

  it('surfaces a count that does not reconcile instead of finishing', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    store.forceUnbalanced = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = newEngine(store, fakeVision(), fakeExtraction());
    engine.start(job.id);
    await waitFor(() => statusOf(store, job) === 'paused', 'paused');

    expect(store.getJob(job.id)?.pauseReason).toBeNull();
    expect(engine.getProgress(job.id).reconciliation.balanced).toBe(false);
    expect(errors).toHaveBeenCalled();
    expect(store.markDuplicatesCalls).toBe(0);

    // Once the counts are right, Resume finishes the job.
    store.forceUnbalanced = false;
    engine.resume(job.id);
    await waitFor(isDone(store, job), 'done');
  });

  it('finishes an empty job', async () => {
    const store = new MemoryStore();
    const job = addJob(store, []);
    newEngine(store, fakeVision(), fakeExtraction()).start(job.id);
    await waitFor(isDone(store, job), 'done');
  });

  it('counts needs_review cards as finished', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const extraction = fakeExtraction(({ variant }) =>
      variant === 'A' ? { ok: false, failure: 'incomplete', detail: 'cut off' } : { ok: true, data: SAMPLE_READ },
    );
    newEngine(store, fakeVision(), extraction).start(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(store.getReconciliation(job.id)).toMatchObject({ needsReview: 1, balanced: true });
  });
});

describe('on the real store', () => {
  function realJob(names: string[], options: Partial<JobOptions>) {
    const store = createStore(join(jobsDir, `${randomUUID()}.sqlite`));
    const job = store.createJob({ name: 'real', options: { frontBackPairs: false, defaultCountry: null, costCapUsd: 10, ...options } });
    for (const name of names) {
      store.addFile({ jobId: job.id, originalName: name, sha256: name.replace('-copy', ''), byteSize: 100, storedPath: `/uploads/${name}` });
    }
    return { store, job };
  }

  it('balances a pairs job with a multi-card file, a no-card back and a duplicate', async () => {
    const { store, job } = realJob(['f1.jpg', 'b1.jpg', 'sheet.jpg', 'back.jpg', 'f3.jpg', 'blank.jpg', 'f4.jpg', 'f4-copy.jpg'], { frontBackPairs: true });
    const plans = { 'sheet.jpg': { cards: 3 }, 'blank.jpg': { cards: 0 } };
    const engine = createJobEngine({ store, vision: fakeVision({ plans }), extraction: fakeExtraction(), decision: fakeDecision(), jobsDir });
    engines.push(engine);
    engine.start(job.id);
    await waitFor(() => store.getJob(job.id)?.status === 'done', 'done');

    expect(store.getReconciliation(job.id)).toMatchObject({ noCardFiles: 1, duplicateFiles: 1, cards: 7, verified: 1, needsReview: 6, cardsInProgress: 0, balanced: true });
    expect(store.getCopyableRows(job.id)).toHaveLength(1);
    await engine.shutdown();
    store.close();
  });

  it('keeps 36 distinct cards after a crash at card 17', async () => {
    const { store, job } = realJob(['sheet.jpg'], {});
    const plans = { 'sheet.jpg': { cards: 36 } };
    let created = 0;
    const crashing = {
      ...store,
      createCard: (input: Parameters<typeof store.createCard>[0]) => {
        if (created === 17) throw new Error('The process died.');
        created += 1;
        return store.createCard(input);
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = createJobEngine({ store: crashing, vision: fakeVision({ plans }), extraction: fakeExtraction(), decision: fakeDecision(), jobsDir });
    first.start(job.id);
    await waitFor(() => created === 17, 'the crash');
    await first.shutdown();
    expect(store.listCards(job.id)).toHaveLength(17);
    store.setJobStatus(job.id, 'running', null);

    const second = createJobEngine({ store, vision: fakeVision({ plans }), extraction: fakeExtraction(), decision: fakeDecision(), jobsDir });
    engines.push(second);
    second.recover();
    await waitFor(() => store.getJob(job.id)?.status === 'done', 'done');

    expect(store.listCards(job.id).map((card) => card.indexInSource)).toEqual(Array.from({ length: 36 }, (_, i) => i));
    // The fake gives every card the same email, so the store sends same-sheet cards to review.
    expect(store.getReconciliation(job.id)).toMatchObject({ cards: 36, cardsInProgress: 0, failedCards: 0, balanced: true });
    await second.shutdown();
    store.close();
  });
});

describe('a card added by a person', () => {
  /** What the server's add-a-card route does. */
  function addCard(store: MemoryStore, engine: JobEngine, job: Job, fileIndex: number): string {
    const file = store.listFiles(job.id)[fileIndex];
    const siblings = store.listCards(job.id).filter((card) => card.sourceFileIds.includes(file?.id ?? ''));
    const crop = siblings[0]?.crops[0];
    const card = store.createCard({
      jobId: job.id,
      sourceFileIds: [file?.id ?? ''],
      indexInSource: siblings.length,
      crops: crop ? [crop] : [],
    });
    store.updateFile(file?.id ?? '', { stage: 'cropped' });
    engine.start(job.id);
    return card.id;
  }

  it('runs on a finished job, reads only that card, and finishes again', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg', 'b.jpg']);
    const extraction = fakeExtraction();
    const engine = newEngine(store, fakeVision(), extraction);
    engine.start(job.id);
    await waitFor(isDone(store, job), 'done');
    expect(extraction.calls).toHaveLength(6);

    const added = addCard(store, engine, job, 0);
    expect(statusOf(store, job)).toBe('running');
    await waitFor(isDone(store, job), 'done again');

    expect(store.getCard(added)).toMatchObject({ stage: 'decided', status: 'verified' });
    expect(extraction.calls).toHaveLength(9);
    expect(extraction.calls.slice(6).every((call) => call.cardId === added)).toBe(true);
    expect(store.getReconciliation(job.id)).toMatchObject({ cards: 3, verified: 3, balanced: true });
    expect(store.markDuplicatesCalls).toBe(2);
  });

  it('is picked up when added while the job runs, after its file has gone by', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg', 'b.jpg']);
    const hold = deferred();
    const extraction = fakeExtraction(async ({ cardId }) => {
      if (cardId === store.listCards(job.id)[1]?.id) await hold.promise;
      return { ok: true, data: SAMPLE_READ };
    });
    const engine = newEngine(store, fakeVision(), extraction);
    engine.start(job.id);
    await waitFor(() => store.getReconciliation(job.id).verified === 1, 'the first card');

    const added = addCard(store, engine, job, 0);
    hold.resolve();
    await waitFor(isDone(store, job), 'done');
    expect(store.getCard(added)?.status).toBe('verified');
    expect(store.getReconciliation(job.id)).toMatchObject({ cards: 3, verified: 3, balanced: true });
  });

  it('leaves a finished job alone when nothing is pending', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const extraction = fakeExtraction();
    const engine = newEngine(store, fakeVision(), extraction);
    engine.start(job.id);
    await waitFor(isDone(store, job), 'done');
    const writes = store.writes.length;
    engine.start(job.id);
    expect(statusOf(store, job)).toBe('done');
    expect(store.writes).toHaveLength(writes);
  });

  it('reports a pending card that no file can reach, instead of looping', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.createCard({ jobId: job.id, sourceFileIds: ['missing-file'], indexInSource: 0, crops: [] });
    newEngine(store, fakeVision(), fakeExtraction()).start(job.id);
    await waitFor(() => statusOf(store, job) === 'paused', 'paused');
    expect(store.getJob(job.id)?.pauseReason).toBeNull();
    expect(errors).toHaveBeenCalled();
  });
});

describe('concurrency and back-pressure', () => {
  function tracker(): { enter(): void; exit(): void; peak(): number; now(): number } {
    let active = 0;
    let peak = 0;
    return {
      enter: () => {
        active += 1;
        peak = Math.max(peak, active);
      },
      exit: () => {
        active -= 1;
      },
      peak: () => peak,
      now: () => active,
    };
  }

  it('keeps image work and network work within separate limits', async () => {
    const store = new MemoryStore();
    const job = addJob(store, Array.from({ length: 60 }, (_, i) => `f${i}.jpg`));
    const image = tracker();
    const network = tracker();
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));
    const base = fakeVision();
    const vision: VisionService = {
      ...base,
      normalize: async (input) => {
        image.enter();
        await tick();
        image.exit();
        return base.normalize(input);
      },
      prepareReadImages: async (crop, dir) => {
        image.enter();
        await tick();
        image.exit();
        return base.prepareReadImages(crop, dir);
      },
      locate: async (input, ctx) => {
        network.enter();
        await tick();
        network.exit();
        return base.locate(input, ctx);
      },
    };
    const extraction = fakeExtraction(async () => {
      network.enter();
      await tick();
      network.exit();
      return { ok: true, data: SAMPLE_READ };
    });
    newEngine(store, vision, extraction).start(job.id);
    await waitFor(isDone(store, job), 'done');

    expect(image.peak()).toBeLessThanOrEqual(IMAGE_SLOTS);
    expect(network.peak()).toBeLessThanOrEqual(NETWORK_SLOTS);
    expect(network.peak()).toBeGreaterThan(IMAGE_SLOTS);
  });

  it('does not start every file at once', async () => {
    const store = new MemoryStore();
    const job = addJob(store, Array.from({ length: 200 }, (_, i) => `f${i}.jpg`));
    const hold = deferred();
    const vision = fakeVision({ before: () => hold.promise });
    newEngine(store, vision, fakeExtraction()).start(job.id);
    await waitFor(() => vision.calls.length >= IMAGE_SLOTS, 'first files');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(vision.calls.length).toBeLessThanOrEqual(FILE_WORKERS);
    hold.resolve();
    await waitFor(isDone(store, job), 'done');
  });

  it('holds new files back while a big sheet is unfinished: back-pressure counts cards', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['sheet1.jpg', 'sheet2.jpg', ...Array.from({ length: 40 }, (_, i) => `f${i}.jpg`)]);
    const hold = deferred();
    const extraction = fakeExtraction(async () => {
      await hold.promise;
      return { ok: true, data: SAMPLE_READ };
    });
    const vision = fakeVision({ plans: { 'sheet1.jpg': { cards: 36 }, 'sheet2.jpg': { cards: 36 } } });
    newEngine(store, vision, extraction).start(job.id);
    await waitFor(() => extraction.calls.length >= NETWORK_SLOTS, 'reads blocked');
    await new Promise((resolve) => setTimeout(resolve, 30));

    const located = vision.calls.filter((call) => call.step === 'locate').length;
    const cards = store.listCards(job.id).length;
    expect(cards).toBeGreaterThanOrEqual(CARD_BACKLOG_LIMIT);
    // Files stop starting once the backlog is full, however few files that took.
    expect(located).toBeLessThan(42);
    expect(cards).toBeLessThanOrEqual(CARD_BACKLOG_LIMIT + 2 * 36 + FILE_WORKERS);

    hold.resolve();
    await waitFor(isDone(store, job), 'done');
    expect(store.getReconciliation(job.id)).toMatchObject({ cards: 112, verified: 112, balanced: true });
  });

  it('finishes a mix of one-card files and 36-card sheets with nothing stalled', async () => {
    const store = new MemoryStore();
    const names = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? `sheet${i}.jpg` : `single${i}.jpg`));
    const job = addJob(store, names);
    const plans = Object.fromEntries(names.filter((name) => name.startsWith('sheet')).map((name) => [name, { cards: 36 }]));
    const extraction = fakeExtraction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { ok: true, data: SAMPLE_READ };
    });
    newEngine(store, fakeVision({ plans }), extraction).start(job.id);
    await waitFor(isDone(store, job), 'done');

    expect(store.getReconciliation(job.id)).toMatchObject({ files: 30, cards: 6 * 36 + 24, verified: 6 * 36 + 24, balanced: true });
  });

  it('shares the network limit across jobs', async () => {
    const store = new MemoryStore();
    const jobs = [addJob(store, ['a.jpg', 'b.jpg']), addJob(store, ['c.jpg'])];
    const engine = newEngine(store, fakeVision(), fakeExtraction());
    jobs.forEach((job) => engine.start(job.id));
    await waitFor(() => jobs.every((job) => statusOf(store, job) === 'done'), 'both done');
    expect(store.getReconciliation(jobs[0]?.id ?? '').cards).toBe(2);
    expect(store.getReconciliation(jobs[1]?.id ?? '').cards).toBe(1);
  });
});

describe('progress', () => {
  it('has no estimate until a card finishes', () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const engine = newEngine(store, fakeVision(), fakeExtraction());
    expect(engine.getProgress(job.id)).toMatchObject({ status: 'queued', cardsPerMinute: 0, etaSeconds: null, spendUsd: 0, costCapUsd: 10, concurrency: 0 });
  });

  it('rejects an unknown job', () => {
    const engine = newEngine(new MemoryStore(), fakeVision(), fakeExtraction());
    expect(() => engine.getProgress('nope')).toThrow('does not exist');
    expect(() => engine.start('nope')).toThrow('does not exist');
  });

  it('reports speed and time left while running', async () => {
    const store = new MemoryStore();
    const job = addJob(store, Array.from({ length: 20 }, (_, i) => `f${i}.jpg`));
    let finished = 0;
    const hold = deferred();
    const extraction = fakeExtraction(async () => {
      finished += 1;
      if (finished > 12) await hold.promise;
      return { ok: true, data: SAMPLE_READ };
    });
    const engine = newEngine(store, fakeVision(), extraction);
    engine.start(job.id);
    await waitFor(() => finished > 12 && store.getReconciliation(job.id).verified >= 1, 'a finished card and reads in flight');

    const progress = engine.getProgress(job.id);
    expect(progress.status).toBe('running');
    expect(progress.cardsPerMinute).toBeGreaterThan(0);
    expect(progress.etaSeconds).toBeGreaterThan(0);
    expect(progress.concurrency).toBeGreaterThan(0);
    hold.resolve();
    await waitFor(isDone(store, job), 'done');
    expect(engine.getProgress(job.id)).toMatchObject({ status: 'done', etaSeconds: null });
  });

  it('shows the client ramp-up level when given one', () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    const engine = createJobEngine({
      store,
      vision: fakeVision(),
      extraction: fakeExtraction(),
      decision: fakeDecision(),
      jobsDir,
      getLlmConcurrency: () => CONFIG.concurrency.initial,
    });
    engines.push(engine);
    expect(engine.getProgress(job.id).concurrency).toBe(CONFIG.concurrency.initial);
  });

  it('throttles updates but always sends status changes, and stops after unsubscribe', async () => {
    const store = new MemoryStore();
    const job = addJob(store, Array.from({ length: 30 }, (_, i) => `f${i}.jpg`));
    const seen: JobProgress[] = [];
    const engine = newEngine(store, fakeVision(), fakeExtraction());
    const unsubscribe = engine.subscribe((progress) => seen.push(progress));
    engine.start(job.id);
    await waitFor(isDone(store, job), 'done');
    await waitFor(() => seen.at(-1)?.status === 'done', 'the final update');

    // 30 files make well over 100 changes, so an unthrottled feed would show them all.
    expect(seen.length).toBeLessThan(40);
    expect(seen[0]?.status).toBe('running');
    expect(seen.at(-1)?.reconciliation).toMatchObject({ verified: 30, balanced: true });

    unsubscribe();
    const count = seen.length;
    engine.pause(job.id);
    expect(seen).toHaveLength(count);
  });

  it('keeps working when a listener throws', async () => {
    const store = new MemoryStore();
    const job = addJob(store, ['a.jpg']);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = newEngine(store, fakeVision(), fakeExtraction());
    engine.subscribe(() => {
      throw new Error('listener bug');
    });
    engine.start(job.id);
    await waitFor(isDone(store, job), 'done');
  });
});
