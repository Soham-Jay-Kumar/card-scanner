/**
 * An in-memory Store for engine tests. Like SQLite, it hands out copies, so code
 * can't change saved data by holding on to an object. A test can make it "crash"
 * right after any durable write: that write stands, and every later write throws,
 * which is what a real process death leaves on disk.
 */
import { randomUUID } from 'node:crypto';
import type {
  Card,
  CardRow,
  CardStatus,
  Job,
  JobOptions,
  JobStatus,
  LlmLedgerEntry,
  NewCard,
  NewSourceFile,
  PauseReason,
  ReadRecord,
  ReadVariant,
  Reconciliation,
  SourceFile,
  Store,
} from '../../shared/contracts.ts';

export class StoreCrashed extends Error {
  constructor() {
    super('The store crashed.');
    this.name = 'StoreCrashed';
  }
}

export type WriteName =
  | 'setJobStatus'
  | 'addFile'
  | 'updateFile'
  | 'createCard'
  | 'updateCard'
  | 'saveRead'
  | 'recordLlmCall'
  | 'markPossibleDuplicates';

const IN_PROGRESS_STAGES = new Set(['received', 'normalized', 'quality_checked', 'located']);

export class MemoryStore implements Store {
  /** Every durable write so far, in order. */
  readonly writes: WriteName[] = [];
  markDuplicatesCalls = 0;
  /** Set this to break the count, as a Store bug would. */
  forceUnbalanced = false;

  private crashWhen: ((name: WriteName, count: number) => boolean) | null = null;
  private crashed = false;

  private readonly jobs = new Map<string, Job>();
  private readonly files = new Map<string, SourceFile>();
  private readonly cards = new Map<string, Card>();
  private readonly reads = new Map<string, Map<ReadVariant, ReadRecord>>();
  private readonly ledger: LlmLedgerEntry[] = [];

  /** Crash right after the first write for which this returns true. */
  crashAfter(when: (name: WriteName, count: number) => boolean): void {
    this.crashWhen = when;
  }

  /** The process restarted: what was written is still there. */
  reopen(): void {
    this.crashed = false;
    this.crashWhen = null;
  }

  private write(name: WriteName): void {
    if (this.crashed) throw new StoreCrashed();
    this.writes.push(name);
    const count = this.writes.filter((entry) => entry === name).length;
    if (this.crashWhen?.(name, count)) this.crashed = true;
  }

  createJob(input: { name: string; options: JobOptions }): Job {
    const job: Job = {
      id: randomUUID(),
      name: input.name,
      createdAt: new Date().toISOString(),
      status: 'queued',
      pauseReason: null,
      options: input.options,
    };
    this.jobs.set(job.id, job);
    return structuredClone(job);
  }

  getJob(id: string): Job | undefined {
    return structuredClone(this.jobs.get(id));
  }

  listJobs(): Job[] {
    return structuredClone([...this.jobs.values()]);
  }

  setJobStatus(id: string, status: JobStatus, pauseReason?: PauseReason | null): void {
    if (this.crashed) throw new StoreCrashed();
    const job = this.jobs.get(id);
    if (!job) throw new Error('No such job.');
    job.status = status;
    job.pauseReason = pauseReason ?? null;
    this.write('setJobStatus');
  }

  setJobCostCap(id: string, costCapUsd: number): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error('No such job.');
    job.options = { ...job.options, costCapUsd };
  }

  deleteJob(id: string): void {
    this.jobs.delete(id);
  }

  addFile(input: NewSourceFile): SourceFile {
    const siblings = [...this.files.values()].filter((file) => file.jobId === input.jobId);
    const original = siblings.find((file) => file.sha256 === input.sha256);
    const file: SourceFile = {
      ...input,
      id: randomUUID(),
      seq: siblings.length,
      stage: original ? 'duplicate' : 'received',
      duplicateOfFileId: original?.id ?? null,
      normalized: null,
      quality: null,
      locate: null,
      error: null,
    };
    this.files.set(file.id, file);
    this.write('addFile');
    return structuredClone(file);
  }

  getFile(id: string): SourceFile | undefined {
    return structuredClone(this.files.get(id));
  }

  listFiles(jobId: string): SourceFile[] {
    return structuredClone([...this.files.values()].filter((file) => file.jobId === jobId));
  }

  updateFile(id: string, patch: Parameters<Store['updateFile']>[1]): void {
    if (this.crashed) throw new StoreCrashed();
    const file = this.files.get(id);
    if (!file) throw new Error('No such file.');
    Object.assign(file, structuredClone(patch));
    this.write('updateFile');
  }

  createCard(input: NewCard): Card {
    if (this.crashed) throw new StoreCrashed();
    const card: Card = {
      ...structuredClone(input),
      id: randomUUID(),
      stage: 'created',
      status: 'pending',
      readImages: [],
      decision: null,
      finalRow: null,
      confirmedByHuman: false,
      possibleDuplicateOf: null,
      error: null,
    };
    this.cards.set(card.id, card);
    this.write('createCard');
    return structuredClone(card);
  }

  getCard(id: string): Card | undefined {
    return structuredClone(this.cards.get(id));
  }

  listCards(jobId: string, filter?: { status?: CardStatus }): Card[] {
    const cards = [...this.cards.values()].filter(
      (card) => card.jobId === jobId && (filter?.status === undefined || card.status === filter.status),
    );
    // Upload order, as the real store gives. Workers create cards in any order.
    const firstSeq = (card: Card): number => this.files.get(card.sourceFileIds[0] ?? '')?.seq ?? 0;
    return structuredClone(cards.toSorted((a, b) => firstSeq(a) - firstSeq(b) || a.indexInSource - b.indexInSource));
  }

  updateCard(id: string, patch: Parameters<Store['updateCard']>[1]): void {
    if (this.crashed) throw new StoreCrashed();
    const card = this.cards.get(id);
    if (!card) throw new Error('No such card.');
    Object.assign(card, structuredClone(patch));
    this.write('updateCard');
  }

  saveRead(record: ReadRecord): void {
    if (this.crashed) throw new StoreCrashed();
    const reads = this.reads.get(record.cardId) ?? new Map<ReadVariant, ReadRecord>();
    reads.set(record.variant, structuredClone(record));
    this.reads.set(record.cardId, reads);
    this.write('saveRead');
  }

  listReads(cardId: string): ReadRecord[] {
    return structuredClone([...(this.reads.get(cardId)?.values() ?? [])]);
  }

  recordLlmCall(entry: LlmLedgerEntry): void {
    this.ledger.push(structuredClone(entry));
    this.write('recordLlmCall');
  }

  getJobSpendUsd(jobId: string): number {
    return this.ledger.filter((entry) => entry.jobId === jobId).reduce((sum, entry) => sum + (entry.usage?.costUsd ?? 0), 0);
  }

  confirmCard(cardId: string, row: CardRow): void {
    const card = this.cards.get(cardId);
    if (!card) throw new Error('No such card.');
    card.status = 'confirmed';
    card.finalRow = row;
    card.confirmedByHuman = true;
  }

  rejectCard(cardId: string, reason: string): void {
    const card = this.cards.get(cardId);
    if (!card) throw new Error('No such card.');
    card.status = 'rejected';
    card.error = reason;
  }

  getCopyableRows(jobId: string): Array<{ cardId: string; row: CardRow }> {
    return this.listCards(jobId)
      .filter((card) => card.finalRow !== null && (card.status === 'verified' || card.status === 'confirmed'))
      .map((card) => ({ cardId: card.id, row: card.finalRow as CardRow }));
  }

  getReconciliation(jobId: string): Reconciliation {
    const files = this.listFiles(jobId);
    const cards = this.listCards(jobId);
    const countFiles = (stage: string): number => files.filter((file) => file.stage === stage).length;
    const countCards = (status: CardStatus): number => cards.filter((card) => card.status === status).length;
    const result: Reconciliation = {
      files: files.length,
      duplicateFiles: countFiles('duplicate'),
      noCardFiles: countFiles('no_card'),
      failedFiles: countFiles('failed'),
      filesInProgress: files.filter((file) => IN_PROGRESS_STAGES.has(file.stage)).length,
      cards: cards.length,
      verified: countCards('verified'),
      confirmed: countCards('confirmed'),
      needsReview: countCards('needs_review'),
      rejected: countCards('rejected'),
      failedCards: countCards('failed'),
      cardsInProgress: countCards('pending'),
      balanced: false,
    };
    const fileBuckets =
      result.duplicateFiles + result.noCardFiles + result.failedFiles + result.filesInProgress + countFiles('cropped');
    const cardBuckets =
      result.verified + result.confirmed + result.needsReview + result.rejected + result.failedCards + result.cardsInProgress;
    result.balanced = !this.forceUnbalanced && fileBuckets === result.files && cardBuckets === result.cards;
    return result;
  }

  markPossibleDuplicates(_jobId: string): void {
    if (this.crashed) throw new StoreCrashed();
    this.markDuplicatesCalls += 1;
    this.write('markPossibleDuplicates');
  }

  close(): void {}
}
