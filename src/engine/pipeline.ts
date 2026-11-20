/**
 * The work of one job run: files become cards, cards become decisions.
 *
 * File workers feed a queue that card workers drain. File workers wait while the
 * card backlog is full, so one 36-card photo holds back new files rather than
 * piling up behind them, and memory stays flat: only ids sit in the queue, and
 * images are loaded inside a gated step.
 *
 * Every step writes its result before the next begins and checks what is already
 * saved before it runs, so a run can stop anywhere and the next one carries on.
 */
import { mkdir } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { CONFIG } from '../shared/config.ts';
import {
  FIELD_KEYS,
  JobPauseError,
  READ_VARIANTS,
  type Card,
  type CardCrop,
  type CardDecision,
  type DecisionService,
  type ExtractionService,
  type LlmPurpose,
  type NewCard,
  type QualityReport,
  type ReadImages,
  type ReadOutcome,
  type ReadVariant,
  type SourceFile,
  type Store,
  type VisionService,
} from '../shared/contracts.ts';
import { Gate, WorkQueue } from './queue.ts';

/** Leaves a core for the event loop, which also keeps API calls moving. */
export const IMAGE_SLOTS = Math.max(1, availableParallelism() - 1);
/** Locate calls and reads. The client's ramp-up decides how many are really sent. */
export const NETWORK_SLOTS = CONFIG.concurrency.max;
/** Sixteen cards offer 48 reads, enough to keep every network slot busy. */
export const CARD_WORKERS = 16;
export const FILE_WORKERS = 16;
/** Past this many unfinished cards, no new file starts. */
export const CARD_BACKLOG_LIMIT = CARD_WORKERS * 3;

const STOPPED = new Error('The run stopped.');

const PURPOSE_BY_VARIANT: Record<ReadVariant, LlmPurpose> = { A: 'read_a', B: 'read_b', C: 'read_c' };

/** One file, or both files of a front/back pair. */
interface Unit {
  files: SourceFile[];
  pairing: boolean;
}

interface CardRef {
  id: string;
  indexInSource: number;
  pending: boolean;
}

interface CardTask {
  cardId: string;
  unit: Unit;
}

export interface Run {
  jobId: string;
  controller: AbortController;
  stopRequested: boolean;
  queue: WorkQueue<CardTask>;
  startedAt: number;
  /** Times cards finished, in order, for the speed estimate. */
  finishedAt: number[];
  done: Promise<void>;
}

export interface PipelineDeps {
  store: Store;
  vision: VisionService;
  extraction: ExtractionService;
  decision: DecisionService;
  jobsDir: string;
  imageGate: Gate;
  networkGate: Gate;
  onPause(run: Run, error: JobPauseError): void;
  onProgress(jobId: string): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupIntoUnits(files: SourceFile[], pairing: boolean): Unit[] {
  const ordered = files.toSorted((a, b) => a.seq - b.seq);
  if (!pairing) return ordered.map((file) => ({ files: [file], pairing }));
  // Pairs follow position, not what survives, so a duplicate can't shift every later pair.
  const units: Unit[] = [];
  for (let i = 0; i < ordered.length; i += 2) units.push({ files: ordered.slice(i, i + 2), pairing });
  return units;
}

/** Why a card must be checked by a person because of how it was paired, if any. */
function pairingProblem(unit: Unit, card: Card): string | null {
  if (!unit.pairing || card.crops.length > 1) return null;
  if (unit.files.some((file) => (file.locate?.locations.length ?? 0) > 1)) {
    return 'This file shows more than one card while front and back pairing is on, so its other side was not guessed. Check this card.';
  }
  if (unit.files.length > 1) return 'The other side of this card could not be used. Check this card.';
  return null;
}

function requireReview(decision: CardDecision, detail: string): CardDecision {
  return {
    ...decision,
    status: 'needs_review',
    checks: [...decision.checks, { check: 'quality', field: null, passed: false, detail }],
    flaggedFields: [...FIELD_KEYS],
  };
}

/** The card's own crops decide review. A two-sided card takes the worse of its reports. */
function cardQuality(card: Card, unit: Unit): QualityReport | null {
  const reports = card.crops.map((crop) => crop.quality);
  const worst = reports.find((report) => !report.ok) ?? reports[0];
  if (!worst) return unit.files.find((file) => card.sourceFileIds.includes(file.id))?.quality ?? null;
  return { ...worst, ok: reports.every((report) => report.ok), issues: [...new Set(reports.flatMap((report) => report.issues))] };
}

export async function runPipeline(deps: PipelineDeps, run: Run): Promise<void> {
  const { store, vision, extraction, decision, jobsDir, imageGate, networkGate, onPause, onProgress } = deps;
  const { jobId, queue, controller } = run;
  const { signal } = controller;

  const job = store.getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} does not exist.`);
  const { frontBackPairs, defaultCountry } = job.options;
  const units = groupIntoUnits(store.listFiles(jobId), frontBackPairs);

  // Read once, so 1,000 files don't each scan every card.
  const cardsByFile = new Map<string, CardRef[]>();
  const indexCard = (card: Card): void => {
    const ref = { id: card.id, indexInSource: card.indexInSource, pending: card.status === 'pending' };
    for (const fileId of card.sourceFileIds) {
      const refs = cardsByFile.get(fileId);
      if (refs) refs.push(ref);
      else cardsByFile.set(fileId, [ref]);
    }
  };
  store.listCards(jobId).forEach(indexCard);

  const throwIfStopped = (): void => {
    if (run.stopRequested) throw STOPPED;
  };

  /** Takes a pause on board. True means the step was interrupted, not that it failed. */
  const wasInterrupted = (error: unknown): boolean => {
    if (error instanceof JobPauseError) {
      onPause(run, error);
      return true;
    }
    return error === STOPPED || signal.aborted;
  };

  const imageWork = <T>(task: () => Promise<T>): Promise<T> =>
    imageGate.run(() => {
      throwIfStopped();
      return task();
    });
  const networkWork = <T>(task: () => Promise<T>): Promise<T> =>
    networkGate.run(() => {
      throwIfStopped();
      return task();
    });

  const saveFile = (file: SourceFile, patch: Parameters<Store['updateFile']>[1]): void => {
    store.updateFile(file.id, patch);
    Object.assign(file, patch);
    onProgress(jobId);
  };

  const fileDir = async (file: SourceFile): Promise<string> => {
    const dir = join(jobsDir, jobId, 'files', file.id);
    await mkdir(dir, { recursive: true });
    return dir;
  };

  /** Runs a file through to 'located', or to the terminal stage it ends on. */
  async function advanceFile(file: SourceFile): Promise<void> {
    try {
      if (file.stage === 'received') {
        const outDir = await fileDir(file);
        const normalized = await imageWork(() =>
          vision.normalize({ sourcePath: file.storedPath, originalName: file.originalName, outDir }),
        );
        saveFile(file, { normalized, stage: 'normalized' });
      }
      if (file.stage === 'normalized') {
        const image = file.normalized as NonNullable<SourceFile['normalized']>;
        saveFile(file, { quality: await imageWork(() => vision.assessQuality(image)), stage: 'quality_checked' });
      }
      if (file.stage === 'quality_checked') {
        const image = file.normalized as NonNullable<SourceFile['normalized']>;
        const locate = await networkWork(() => vision.locate(image, { jobId, purpose: 'locate', fileId: file.id, signal }));
        saveFile(file, { locate, stage: locate.noCard ? 'no_card' : 'located' });
      }
    } catch (error) {
      if (!wasInterrupted(error)) saveFile(file, { stage: 'failed', error: messageOf(error) });
    }
  }

  async function cropFile(file: SourceFile): Promise<CardCrop[] | null> {
    const image = file.normalized as NonNullable<SourceFile['normalized']>;
    const locate = file.locate as NonNullable<SourceFile['locate']>;
    try {
      const outDir = await fileDir(file);
      const crops = await imageWork(() => vision.crop(image, locate, outDir));
      // An empty location list means the whole image, which is one crop.
      const expected = Math.max(1, locate.locations.length);
      if (crops.length !== expected) throw new Error(`Expected ${expected} card crops, but got ${crops.length}.`);
      return crops;
    } catch (error) {
      if (!wasInterrupted(error)) saveFile(file, { stage: 'failed', error: messageOf(error) });
      return null;
    }
  }

  /** Safe to repeat: a crash can land between any two cards of a sheet. */
  function ensureCard(input: Omit<NewCard, 'jobId'>): void {
    const [firstFileId] = input.sourceFileIds;
    const refs = firstFileId === undefined ? [] : (cardsByFile.get(firstFileId) ?? []);
    if (refs.some((ref) => ref.indexInSource === input.indexInSource)) return;
    indexCard(store.createCard({ jobId, ...input }));
  }

  async function createSingleCards(file: SourceFile): Promise<void> {
    if (file.stage !== 'located') return;
    const crops = await cropFile(file);
    if (!crops) return;
    crops.forEach((crop, indexInSource) => ensureCard({ sourceFileIds: [file.id], indexInSource, crops: [crop] }));
    saveFile(file, { stage: 'cropped' });
  }

  async function createPairCard(front: SourceFile, back: SourceFile): Promise<void> {
    const alreadyCreated = (cardsByFile.get(front.id) ?? []).length > 0;
    if (!alreadyCreated) {
      const [frontCrops, backCrops] = await Promise.all([cropFile(front), cropFile(back)]);
      if (run.stopRequested) return;
      if (!frontCrops || !backCrops) {
        // One side failed, so the other carries on alone and goes to review.
        const survivor = frontCrops ? front : back;
        const crops = frontCrops ?? backCrops;
        if (crops) {
          crops.forEach((crop, indexInSource) => ensureCard({ sourceFileIds: [survivor.id], indexInSource, crops: [crop] }));
          saveFile(survivor, { stage: 'cropped' });
        }
        return;
      }
      const [frontCrop, backCrop] = [frontCrops[0], backCrops[0]] as [CardCrop, CardCrop];
      ensureCard({
        sourceFileIds: [front.id, back.id],
        indexInSource: 0,
        crops: [
          { ...frontCrop, side: 'front' },
          { ...backCrop, side: 'back' },
        ],
      });
    }
    for (const file of [front, back]) {
      if (file.stage === 'located') saveFile(file, { stage: 'cropped' });
    }
  }

  async function createCards(unit: Unit): Promise<void> {
    const usable = unit.files.filter((file) => file.stage === 'located' || file.stage === 'cropped');
    const [first, second] = usable;
    if (first && second && usable.every((file) => (file.locate?.locations.length ?? 0) <= 1)) {
      await createPairCard(first, second);
      return;
    }
    await Promise.all(usable.map(createSingleCards));
  }

  async function processUnit(unit: Unit): Promise<void> {
    await Promise.all(unit.files.map(advanceFile));
    if (!run.stopRequested) await createCards(unit);

    // Cards from before a crash wait until now, so a re-crop can't run under them.
    const tasks = new Map<string, CardTask>();
    for (const file of unit.files) {
      for (const ref of cardsByFile.get(file.id) ?? []) {
        if (ref.pending) tasks.set(ref.id, { cardId: ref.id, unit });
      }
    }
    queue.push([...tasks.values()]);
  }

  async function runRead(card: Card, variant: ReadVariant): Promise<void> {
    const ctx = { jobId, purpose: PURPOSE_BY_VARIANT[variant], cardId: card.id, signal };
    const imagePaths = card.readImages.map((images: ReadImages) => images[variant]);
    const read = (): Promise<ReadOutcome> => networkWork(() => extraction.readCard({ variant, imagePaths }, ctx));
    let outcome: ReadOutcome;
    try {
      outcome = await read();
      // Extraction rejects some answers the client accepted, so the client can't
      // have retried those. Nothing is saved yet, so this can't repeat a saved read.
      if (!outcome.ok && outcome.failure === 'schema_invalid') outcome = await read();
    } catch (error) {
      if (wasInterrupted(error)) return;
      outcome = { ok: false, failure: 'retries_exhausted', detail: messageOf(error) };
    }
    store.saveRead({
      cardId: card.id,
      variant,
      outcome,
      model: CONFIG.model,
      // The ledger holds the real usage: readCard returns only the outcome.
      usage: null,
      createdAt: new Date().toISOString(),
    });
  }

  async function prepareCard(card: Card): Promise<Card> {
    if (card.stage !== 'created') return card;
    const outDir = join(jobsDir, jobId, 'cards', card.id);
    await mkdir(outDir, { recursive: true });
    const readImages: ReadImages[] = [];
    for (const crop of card.crops) readImages.push(await imageWork(() => vision.prepareReadImages(crop, outDir)));
    store.updateCard(card.id, { readImages, stage: 'prepared' });
    return { ...card, readImages, stage: 'prepared' };
  }

  async function decideCard(card: Card, unit: Unit): Promise<void> {
    const reads = store.listReads(card.id);
    let decided = await decision.decide({
      reads,
      consensus: extraction.compare(reads),
      quality: cardQuality(card, unit),
      defaultCountry,
    });
    const problem = pairingProblem(unit, card);
    if (problem) decided = requireReview(decided, problem);
    store.updateCard(card.id, {
      stage: 'decided',
      status: decided.status,
      decision: decided,
      finalRow: decided.status === 'verified' ? decided.row : null,
    });
  }

  async function processCard({ cardId, unit }: CardTask): Promise<void> {
    const saved = store.getCard(cardId);
    if (!saved || saved.status !== 'pending') return;
    try {
      const card = await prepareCard(saved);
      if (card.stage === 'prepared') store.updateCard(card.id, { stage: 'reading' });

      const finished = new Set(store.listReads(card.id).map((read) => read.variant));
      await Promise.all(READ_VARIANTS.filter((variant) => !finished.has(variant)).map((variant) => runRead(card, variant)));
      if (signal.aborted || store.listReads(card.id).length < READ_VARIANTS.length) return;

      await decideCard(card, unit);
    } catch (error) {
      if (wasInterrupted(error)) return;
      store.updateCard(cardId, { status: 'failed', error: messageOf(error) });
    }
    run.finishedAt.push(Date.now());
    onProgress(jobId);
  }

  let nextUnit = 0;
  let failure: unknown = null;
  /** A store failure can't be recorded on a file or card, so it ends the whole run. */
  const stopOnFailure = (error: unknown): void => {
    failure ??= error;
    run.stopRequested = true;
    queue.stop();
  };

  const fileWorker = async (): Promise<void> => {
    try {
      for (;;) {
        await queue.waitForRoom(CARD_BACKLOG_LIMIT);
        const unit = run.stopRequested ? undefined : units[nextUnit];
        if (!unit) return;
        nextUnit += 1;
        await processUnit(unit);
      }
    } catch (error) {
      stopOnFailure(error);
    }
  };

  const cardWorker = async (): Promise<void> => {
    try {
      for (;;) {
        const task = await queue.take();
        if (!task) return;
        await processCard(task);
        queue.finishOne();
      }
    } catch (error) {
      stopOnFailure(error);
    }
  };

  const fileWorkers = Array.from({ length: FILE_WORKERS }, fileWorker);
  const cardWorkers = Array.from({ length: CARD_WORKERS }, cardWorker);
  await Promise.all(fileWorkers);
  queue.close();
  await Promise.all(cardWorkers);
  if (failure !== null) throw failure;
}
