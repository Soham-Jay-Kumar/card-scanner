import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Card,
  CardCrop,
  CardDecision,
  CardRow,
  FieldConsensus,
  FieldConsensusMap,
  LlmLedgerEntry,
  LocateResult,
  NormalizedImage,
  QualityReport,
  ReadRecord,
  ReadVariant,
  SourceFile,
  Store,
} from '../shared/contracts.ts';
import { createStore } from './index.ts';

const options = { frontBackPairs: false, defaultCountry: 'IN', costCapUsd: 10 };

const quality = (patch: Partial<QualityReport> = {}): QualityReport => ({
  ok: true,
  width: 1600,
  height: 900,
  blurScore: 312.5,
  meanLuminance: 141.25,
  issues: [],
  ...patch,
});

const crop = (index = 0, patch: Partial<CardCrop> = {}): CardCrop => ({
  path: `/data/crop-${index}.jpg`,
  width: 1600,
  height: 900,
  side: 'single',
  quality: quality(),
  ...patch,
});

const row = (patch: Partial<CardRow> = {}): CardRow => ({
  name: 'Jane Doe',
  position: 'CEO',
  company: 'Acme',
  email: '',
  phone: '',
  website: '',
  ...patch,
});

const blankConsensus = (): FieldConsensus => ({
  field: 'name',
  values: { A: 'x', B: 'x', C: null },
  agreement: 'majority',
  chosen: 'x',
  candidates: [{ value: 'x', reads: ['A', 'B'] }],
  unreadable: false,
});

const decision = (cardRow: CardRow): CardDecision => ({
  status: 'needs_review',
  row: cardRow,
  consensus: { name: blankConsensus() } as FieldConsensusMap,
  checks: [{ check: 'quality', field: null, passed: false, detail: "The app couldn't locate this card reliably." }],
  flaggedFields: ['name', 'email'],
});

describe('store', () => {
  let folder: string;
  let dbPath: string;
  let store: Store;
  let open: boolean;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'store-test-'));
    dbPath = join(folder, 'nested', 'card-scanner.sqlite');
    store = createStore(dbPath);
    open = true;
  });

  afterEach(() => {
    if (open) store.close();
    rmSync(folder, { recursive: true, force: true });
  });

  function reopen() {
    store.close();
    store = createStore(dbPath);
  }

  const newJob = (name = 'Test job', jobOptions = options) => store.createJob({ name, options: jobOptions }).id;

  let hashCounter = 0;
  const newFile = (jobId: string, sha256 = `hash-${(hashCounter += 1)}`): SourceFile =>
    store.addFile({ jobId, originalName: `${sha256}.jpg`, sha256, byteSize: 1234, storedPath: `/data/${sha256}.jpg` });

  const newCard = (jobId: string, files: SourceFile[], indexInSource = 0, crops = [crop()]): Card =>
    store.createCard({ jobId, sourceFileIds: files.map((file) => file.id), indexInSource, crops });

  describe('jobs', () => {
    it('creates, reads and lists jobs', () => {
      const job = store.createJob({ name: 'Conference', options });
      expect(job).toMatchObject({ name: 'Conference', status: 'uploading', pauseReason: null, options });
      expect(new Date(job.createdAt).toISOString()).toBe(job.createdAt);
      expect(store.getJob(job.id)).toEqual(job);
      const second = store.createJob({ name: 'Later', options });
      expect(store.listJobs().map((item) => item.id)).toEqual([second.id, job.id]);
      expect(store.getJob('nope')).toBeUndefined();
    });

    it('sets and clears the pause reason', () => {
      const id = newJob();
      store.setJobStatus(id, 'paused', 'out_of_credit');
      expect(store.getJob(id)).toMatchObject({ status: 'paused', pauseReason: 'out_of_credit' });
      store.setJobStatus(id, 'running');
      expect(store.getJob(id)).toMatchObject({ status: 'running', pauseReason: null });
    });

    it('refuses to update a job that does not exist', () => {
      expect(() => store.setJobStatus('nope', 'running')).toThrow('Unknown job');
    });
  });

  describe('files', () => {
    it('assigns seq in upload order, per job', () => {
      const first = newJob();
      const second = newJob();
      expect([newFile(first).seq, newFile(first).seq, newFile(first).seq]).toEqual([0, 1, 2]);
      expect(newFile(second).seq).toBe(0);
    });

    it('marks an exact sha256 match in the same job as a duplicate of the first copy', () => {
      const id = newJob();
      const original = newFile(id, 'same');
      const copy = newFile(id, 'same');
      const third = newFile(id, 'same');
      expect(original).toMatchObject({ stage: 'received', duplicateOfFileId: null });
      expect(copy).toMatchObject({ stage: 'duplicate', duplicateOfFileId: original.id, seq: 1 });
      expect(third).toMatchObject({ stage: 'duplicate', duplicateOfFileId: original.id, seq: 2 });
    });

    it('does not treat the same file in another job as a duplicate', () => {
      newFile(newJob(), 'same');
      expect(newFile(newJob(), 'same').stage).toBe('received');
    });

    it('round-trips every JSON field, including the multi-card additions', () => {
      const id = newJob();
      const file = newFile(id);
      const normalized: NormalizedImage = { path: '/data/n.jpg', width: 4000, height: 3000, sourceFormat: 'heic' };
      const locate: LocateResult = {
        noCard: false,
        locations: Array.from({ length: 36 }, (_, index) => ({
          box: { x: index * 10, y: index * 5, width: 400.5, height: 250.25 },
          rotation: index % 2 === 0 ? 0 : 90,
        })),
        fellBackToFullImage: false,
        countConfirmed: false,
        note: 'The two passes disagree: 36 and 35.',
      };
      const report = quality({ ok: false, issues: ['location_uncertain', 'blurry'] });
      store.updateFile(file.id, { stage: 'located', normalized, quality: report, locate, error: 'note' });
      expect(store.getFile(file.id)).toEqual({
        ...file,
        stage: 'located',
        normalized,
        quality: report,
        locate,
        error: 'note',
      });
    });

    it('keeps countConfirmed true as well as false', () => {
      const file = newFile(newJob());
      const locate: LocateResult = { noCard: false, locations: [], fellBackToFullImage: true, countConfirmed: true, note: null };
      store.updateFile(file.id, { locate });
      expect(store.getFile(file.id)?.locate).toEqual(locate);
    });

    it('only writes keys present in the patch, and null clears', () => {
      const file = newFile(newJob());
      store.updateFile(file.id, { error: 'bad', quality: quality() });
      store.updateFile(file.id, { stage: 'failed' });
      expect(store.getFile(file.id)).toMatchObject({ stage: 'failed', error: 'bad' });
      store.updateFile(file.id, { error: null, quality: null });
      expect(store.getFile(file.id)).toMatchObject({ error: null, quality: null });
    });

    it('refuses a file for a job that does not exist', () => {
      expect(() => newFile('nope')).toThrow();
    });

    it('refuses to update a file that does not exist', () => {
      expect(() => store.updateFile('nope', { stage: 'failed' })).toThrow('Unknown file');
    });
  });

  describe('cards', () => {
    it('creates a pending card and round-trips crop quality exactly', () => {
      const id = newJob();
      const file = newFile(id);
      const crops = [
        crop(0, { side: 'front', quality: quality({ ok: false, blurScore: 0.1, issues: ['location_uncertain'] }) }),
        crop(1, { side: 'back', quality: quality({ width: 212, height: 133, meanLuminance: 89.123456789 }) }),
      ];
      const card = newCard(id, [file], 3, crops);
      expect(card).toEqual({
        id: card.id,
        jobId: id,
        sourceFileIds: [file.id],
        indexInSource: 3,
        stage: 'created',
        status: 'pending',
        crops,
        readImages: [],
        decision: null,
        finalRow: null,
        confirmedByHuman: false,
        possibleDuplicateOf: null,
        error: null,
      });
      expect(store.getCard(card.id)?.crops).toEqual(crops);
    });

    it('keeps the order of a front and back pair', () => {
      const id = newJob();
      const front = newFile(id);
      const back = newFile(id);
      expect(newCard(id, [back, front]).sourceFileIds).toEqual([back.id, front.id]);
    });

    it('round-trips decisions, read images and final rows', () => {
      const id = newJob();
      const card = newCard(id, [newFile(id)]);
      const cardRow = row({ name: '山田太郎', company: 'तुलिका "Quoted" \\ Inc', phone: '+91 98765 43210' });
      const patch: Parameters<Store['updateCard']>[1] = {
        stage: 'decided',
        status: 'needs_review',
        crops: [crop(9)],
        readImages: [{ A: '/a.jpg', B: '/b.jpg', C: '/c.jpg' }],
        decision: decision(cardRow),
        finalRow: cardRow,
        error: 'x',
        possibleDuplicateOf: 'other',
      };
      store.updateCard(card.id, patch);
      expect(store.getCard(card.id)).toEqual({ ...card, ...patch });
    });

    it('refuses a card whose file is in another job, or that has no file', () => {
      const first = newJob();
      const second = newJob();
      const file = newFile(first);
      expect(() => newCard(second, [file])).toThrow('is not in job');
      expect(() => newCard(first, [])).toThrow('at least one source file');
      expect(store.listCards(second)).toEqual([]);
    });

    it('filters by status', () => {
      const id = newJob();
      const file = newFile(id);
      const verified = newCard(id, [file], 0);
      newCard(id, [file], 1);
      store.updateCard(verified.id, { status: 'verified' });
      expect(store.listCards(id).map((card) => card.indexInSource)).toEqual([0, 1]);
      expect(store.listCards(id, { status: 'verified' }).map((card) => card.id)).toEqual([verified.id]);
    });

    it('refuses to update a card that does not exist', () => {
      expect(() => store.updateCard('nope', { status: 'failed' })).toThrow('Unknown card');
      expect(() => store.confirmCard('nope', row())).toThrow('Unknown card');
      expect(() => store.rejectCard('nope', 'x')).toThrow('Unknown card');
    });

    it('confirms a card with the edited row', () => {
      const id = newJob();
      const card = newCard(id, [newFile(id)]);
      const edited = row({ name: 'Edited' });
      store.confirmCard(card.id, edited);
      expect(store.getCard(card.id)).toMatchObject({ status: 'confirmed', finalRow: edited, confirmedByHuman: true });
    });

    it('rejects a card, keeps the reason and removes any final row', () => {
      const id = newJob();
      const card = newCard(id, [newFile(id)]);
      store.updateCard(card.id, { finalRow: row() });
      store.rejectCard(card.id, 'Not a business card');
      expect(store.getCard(card.id)).toMatchObject({
        status: 'rejected',
        error: 'Not a business card',
        finalRow: null,
        confirmedByHuman: false,
      });
    });
  });

  describe('reads', () => {
    const read = (cardId: string, variant: ReadVariant, name: string): ReadRecord => ({
      cardId,
      variant,
      outcome: {
        ok: true,
        data: {
          transcript: [name],
          name,
          position: '',
          company: '',
          emails: [],
          phones: [{ number: '+91 98765 43210', label: 'Tel' }],
          websites: [],
          unreadable: ['phone'],
        },
      },
      model: 'gpt-6-luna',
      usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 250, reasoningTokens: 100, costUsd: 0.000225 },
      createdAt: '2026-11-06T00:00:00.000Z',
    });

    it('upserts on card and variant', () => {
      const id = newJob();
      const card = newCard(id, [newFile(id)]);
      store.saveRead(read(card.id, 'A', 'First'));
      store.saveRead(read(card.id, 'B', 'Second'));
      const replacement = read(card.id, 'A', 'Replaced');
      store.saveRead(replacement);
      const reads = store.listReads(card.id);
      expect(reads.map((item) => item.variant)).toEqual(['A', 'B']);
      expect(reads[0]).toEqual(replacement);
    });

    it('round-trips a failed read with no usage', () => {
      const id = newJob();
      const card = newCard(id, [newFile(id)]);
      const failed: ReadRecord = {
        cardId: card.id,
        variant: 'C',
        outcome: { ok: false, failure: 'schema_invalid', detail: 'bad' },
        model: 'gpt-6-luna',
        usage: null,
        createdAt: '2026-11-06T00:00:00.000Z',
      };
      store.saveRead(failed);
      expect(store.listReads(card.id)).toEqual([failed]);
    });

    it('refuses a read for a card that does not exist', () => {
      expect(() => store.saveRead(read('nope', 'A', 'x'))).toThrow();
    });
  });

  describe('spend ledger', () => {
    const entry = (jobId: string, costUsd: number | null): LlmLedgerEntry => ({
      jobId,
      cardId: null,
      fileId: null,
      purpose: 'read_a',
      model: 'gpt-6-luna',
      ok: costUsd !== null,
      failure: costUsd === null ? 'retries_exhausted' : null,
      attempts: 2,
      latencyMs: 812,
      usage:
        costUsd === null
          ? null
          : { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, costUsd },
      createdAt: '2026-11-06T00:00:00.000Z',
    });

    it('adds up spend per job and counts a call with no usage as zero', () => {
      const first = newJob();
      const second = newJob();
      expect(store.getJobSpendUsd(first)).toBe(0);
      store.recordLlmCall(entry(first, 0.25));
      store.recordLlmCall(entry(first, 0.5));
      store.recordLlmCall(entry(first, null));
      store.recordLlmCall(entry(second, 1));
      expect(store.getJobSpendUsd(first)).toBeCloseTo(0.75);
      expect(store.getJobSpendUsd(second)).toBe(1);
    });
  });

  describe('getCopyableRows with one image holding many cards', () => {
    it('follows reading order within a sheet, with verified and confirmed cards mixed', () => {
      const id = newJob();
      const sheet = newFile(id);
      const count = 36;
      // Created out of order, as concurrent workers would.
      const order = Array.from({ length: count }, (_, index) => (index * 7) % count);
      expect(new Set(order).size).toBe(count);
      const cards = new Map(order.map((index) => [index, newCard(id, [sheet], index)]));

      for (let index = 0; index < count; index += 1) {
        const card = cards.get(index) as Card;
        const cardRow = row({ name: `Card ${index}` });
        if (index % 5 === 0) store.updateCard(card.id, { status: 'needs_review', decision: decision(cardRow) });
        else if (index % 7 === 0) store.rejectCard(card.id, 'no');
        else if (index % 3 === 0) store.confirmCard(card.id, cardRow);
        else if (index % 11 === 0) continue;
        else store.updateCard(card.id, { status: 'verified', finalRow: cardRow });
      }

      const names = store.getCopyableRows(id).map(({ row: item }) => item.name);
      const expected = Array.from({ length: count }, (_, index) => index)
        .filter((index) => index % 5 !== 0 && index % 7 !== 0 && (index % 3 === 0 || index % 11 !== 0))
        .map((index) => `Card ${index}`);
      expect(names).toEqual(expected);
      expect(names.length).toBeGreaterThan(15);
    });

    it('orders by file seq first, then position in the file', () => {
      const id = newJob();
      const [first, second, third] = [newFile(id), newFile(id), newFile(id)];
      const made: Array<[SourceFile, number]> = [
        [third, 1],
        [first, 2],
        [second, 0],
        [third, 0],
        [first, 0],
        [second, 1],
        [first, 1],
      ];
      for (const [file, index] of made) {
        const card = newCard(id, [file], index);
        store.updateCard(card.id, { status: 'verified', finalRow: row({ name: `${file.seq}-${index}` }) });
      }
      expect(store.getCopyableRows(id).map(({ row: item }) => item.name)).toEqual([
        '0-0',
        '0-1',
        '0-2',
        '1-0',
        '1-1',
        '2-0',
        '2-1',
      ]);
      expect(store.listCards(id).map((card) => `${card.indexInSource}`).length).toBe(7);
    });

    it('orders a front and back pair by its earliest file', () => {
      const id = newJob();
      const [first, second, third, fourth] = [newFile(id), newFile(id), newFile(id), newFile(id)];
      const later = newCard(id, [third, fourth]);
      const earlier = newCard(id, [second, first]);
      store.updateCard(later.id, { status: 'verified', finalRow: row({ name: 'Later' }) });
      store.updateCard(earlier.id, { status: 'verified', finalRow: row({ name: 'Earlier' }) });
      expect(store.getCopyableRows(id).map(({ row: item }) => item.name)).toEqual(['Earlier', 'Later']);
    });

    it('returns verified and confirmed only, with the card id', () => {
      const id = newJob();
      const file = newFile(id);
      for (const [index, status] of (['pending', 'needs_review', 'rejected', 'failed'] as const).entries()) {
        store.updateCard(newCard(id, [file], index).id, { status, finalRow: row() });
      }
      expect(store.getCopyableRows(id)).toEqual([]);
      const verified = newCard(id, [file], 9);
      store.updateCard(verified.id, { status: 'verified', finalRow: row({ name: 'Yes' }) });
      expect(store.getCopyableRows(id)).toEqual([{ cardId: verified.id, row: row({ name: 'Yes' }) }]);
    });

    it('uses the decision row for a verified card with no final row, and never drops one silently', () => {
      const id = newJob();
      const file = newFile(id);
      const fromDecision = newCard(id, [file], 0);
      store.updateCard(fromDecision.id, { status: 'verified', decision: decision(row({ name: 'From decision' })) });
      expect(store.getCopyableRows(id).map(({ row: item }) => item.name)).toEqual(['From decision']);
      store.updateCard(newCard(id, [file], 1).id, { status: 'verified' });
      expect(() => store.getCopyableRows(id)).toThrow('has no row');
    });

    it('uses the confirmed edit rather than the original decision', () => {
      const id = newJob();
      const card = newCard(id, [newFile(id)]);
      store.updateCard(card.id, { status: 'needs_review', decision: decision(row({ name: 'Misread' })) });
      store.confirmCard(card.id, row({ name: 'Corrected' }));
      expect(store.getCopyableRows(id)[0]?.row.name).toBe('Corrected');
    });
  });

  describe('getReconciliation', () => {
    it('counts a file with 36 cards once under files and 36 times under cards', () => {
      const id = newJob();
      const sheet = newFile(id);
      store.updateFile(sheet.id, { stage: 'cropped' });
      for (let index = 0; index < 36; index += 1) {
        const card = newCard(id, [sheet], index);
        if (index < 30) store.updateCard(card.id, { status: 'verified', finalRow: row() });
        else if (index < 34) store.updateCard(card.id, { status: 'needs_review' });
        else store.confirmCard(card.id, row());
      }
      expect(store.getReconciliation(id)).toEqual({
        files: 1,
        duplicateFiles: 0,
        noCardFiles: 0,
        failedFiles: 0,
        filesInProgress: 0,
        cards: 36,
        verified: 30,
        confirmed: 2,
        needsReview: 4,
        rejected: 0,
        failedCards: 0,
        cardsInProgress: 0,
        balanced: true,
      });
    });

    it('puts every file and card in exactly one bucket', () => {
      const id = newJob();
      const sheet = newFile(id);
      const single = newFile(id);
      const copy = newFile(id, sheet.sha256);
      const empty = newFile(id);
      const broken = newFile(id);
      newFile(id);
      const located = newFile(id);
      const quality_checked = newFile(id);
      const normalized = newFile(id);

      store.updateFile(sheet.id, { stage: 'cropped' });
      store.updateFile(single.id, { stage: 'cropped' });
      store.updateFile(empty.id, { stage: 'no_card' });
      store.updateFile(broken.id, { stage: 'failed' });
      store.updateFile(located.id, { stage: 'located' });
      store.updateFile(quality_checked.id, { stage: 'quality_checked' });
      store.updateFile(normalized.id, { stage: 'normalized' });

      const statuses = ['pending', 'verified', 'needs_review', 'confirmed', 'rejected', 'failed'] as const;
      statuses.forEach((status, index) => {
        store.updateCard(newCard(id, [sheet], index).id, { status, finalRow: row() });
      });
      store.updateCard(newCard(id, [single]).id, { status: 'verified', finalRow: row() });

      const report = store.getReconciliation(id);
      expect(report).toEqual({
        files: 9,
        duplicateFiles: 1,
        noCardFiles: 1,
        failedFiles: 1,
        filesInProgress: 4,
        cards: 7,
        verified: 2,
        confirmed: 1,
        needsReview: 1,
        rejected: 1,
        failedCards: 1,
        cardsInProgress: 1,
        balanced: true,
      });
      expect(copy.stage).toBe('duplicate');
    });

    it('stays balanced while a job is in progress', () => {
      const id = newJob();
      const file = newFile(id);
      expect(store.getReconciliation(id).balanced).toBe(true);
      newCard(id, [file]);
      expect(store.getReconciliation(id)).toMatchObject({ filesInProgress: 1, cardsInProgress: 1, balanced: true });
    });

    it('is not balanced when a cropped file has no cards', () => {
      const id = newJob();
      const file = newFile(id);
      store.updateFile(file.id, { stage: 'cropped' });
      expect(store.getReconciliation(id)).toMatchObject({ files: 1, cards: 0, balanced: false });
    });

    it('is not balanced by a file or card in a state no bucket counts', () => {
      const id = newJob();
      const file = newFile(id);
      const card = newCard(id, [file]);
      store.updateCard(card.id, { status: 'mystery' as never });
      expect(store.getReconciliation(id).balanced).toBe(false);
      store.updateCard(card.id, { status: 'pending' });
      store.updateFile(file.id, { stage: 'mystery' as never });
      expect(store.getReconciliation(id).balanced).toBe(false);
    });

    it('keeps two cards from one pair of files as two cards and two files', () => {
      const id = newJob();
      const front = newFile(id);
      const back = newFile(id);
      store.updateFile(front.id, { stage: 'cropped' });
      store.updateFile(back.id, { stage: 'cropped' });
      newCard(id, [front, back]);
      expect(store.getReconciliation(id)).toMatchObject({ files: 2, cards: 1, balanced: true });
    });

    it('separates jobs', () => {
      const first = newJob();
      newFile(newJob());
      expect(store.getReconciliation(first)).toMatchObject({ files: 0, balanced: true });
    });
  });

  describe('markPossibleDuplicates', () => {
    function verifiedCard(jobId: string, file: SourceFile, index: number, cardRow: CardRow): Card {
      const card = newCard(jobId, [file], index);
      store.updateCard(card.id, { status: 'verified', finalRow: cardRow });
      return card;
    }

    it('links later cards to the earliest match across files and keeps both rows', () => {
      const id = newJob();
      const first = verifiedCard(id, newFile(id), 0, row({ email: 'jane@acme.com' }));
      const other = verifiedCard(id, newFile(id), 0, row({ email: 'omar@acme.com' }));
      const repeat = verifiedCard(id, newFile(id), 0, row({ email: 'JANE@ACME.COM' }));
      store.markPossibleDuplicates(id);
      expect(store.getCard(first.id)?.possibleDuplicateOf).toBeNull();
      expect(store.getCard(other.id)?.possibleDuplicateOf).toBeNull();
      expect(store.getCard(repeat.id)?.possibleDuplicateOf).toBe(first.id);
      expect(store.getCopyableRows(id)).toHaveLength(3);
    });

    it('matches a phone across printed formats using the job country', () => {
      const id = newJob();
      const file = newFile(id);
      const first = verifiedCard(id, file, 0, row({ phone: '+91 98765 43210' }));
      const second = verifiedCard(id, file, 1, row({ phone: '98765-43210' }));
      store.markPossibleDuplicates(id);
      expect(store.getCard(second.id)?.possibleDuplicateOf).toBe(first.id);
      // A shared switchboard on one sheet is normal, so only email sends a card to review.
      expect(store.getCard(second.id)?.status).toBe('verified');
    });

    it('matches any value in a multi-value cell', () => {
      const id = newJob();
      const first = verifiedCard(id, newFile(id), 0, row({ email: 'a@acme.com; b@acme.com' }));
      const second = verifiedCard(id, newFile(id), 0, row({ email: 'c@acme.com; b@acme.com' }));
      store.markPossibleDuplicates(id);
      expect(store.getCard(second.id)?.possibleDuplicateOf).toBe(first.id);
    });

    it('does not link two people with different extensions on one switchboard', () => {
      const id = newJob();
      const file = newFile(id);
      verifiedCard(id, file, 0, row({ phone: '+1 212 373 4253 x12' }));
      const second = verifiedCard(id, file, 1, row({ phone: '+1 212 373 4253 x13' }));
      store.markPossibleDuplicates(id);
      expect(store.getCard(second.id)?.possibleDuplicateOf).toBeNull();
    });

    it('uses review values, and ignores rejected cards and cards with no values', () => {
      const id = newJob();
      const file = newFile(id);
      const rejected = verifiedCard(id, file, 0, row({ email: 'jane@acme.com' }));
      store.rejectCard(rejected.id, 'no');
      newCard(id, [file], 1);
      const review = newCard(id, [file], 2);
      store.updateCard(review.id, { status: 'needs_review', decision: decision(row({ email: 'jane@acme.com' })) });
      const last = verifiedCard(id, file, 3, row({ email: 'jane@acme.com' }));
      store.markPossibleDuplicates(id);
      expect(store.getCard(review.id)?.possibleDuplicateOf).toBeNull();
      expect(store.getCard(last.id)?.possibleDuplicateOf).toBe(review.id);
    });

    it('does not link blank contacts', () => {
      const id = newJob();
      const file = newFile(id);
      verifiedCard(id, file, 0, row());
      const second = verifiedCard(id, file, 1, row());
      store.markPossibleDuplicates(id);
      expect(store.getCard(second.id)?.possibleDuplicateOf).toBeNull();
    });

    it('recomputes, so a corrected card loses a stale link', () => {
      const id = newJob();
      const file = newFile(id);
      verifiedCard(id, file, 0, row({ email: 'jane@acme.com' }));
      const second = verifiedCard(id, file, 1, row({ email: 'jane@acme.com' }));
      store.markPossibleDuplicates(id);
      store.confirmCard(second.id, row({ email: 'omar@acme.com' }));
      store.markPossibleDuplicates(id);
      expect(store.getCard(second.id)?.possibleDuplicateOf).toBeNull();
    });

    describe('an email shared within one source file', () => {
      /** A verified card as the pipeline leaves it: finalRow and decision hold the same row. */
      function pipelineCard(file: SourceFile, index: number, cardRow: CardRow): Card {
        const card = newCard(file.jobId, [file], index);
        store.updateCard(card.id, {
          stage: 'decided',
          status: 'verified',
          finalRow: cardRow,
          decision: {
            ...decision(cardRow),
            status: 'verified',
            checks: [{ check: 'quality', field: null, passed: true, detail: 'Fine.' }],
            flaggedFields: [],
          },
        });
        return store.getCard(card.id) as Card;
      }

      const sharedChecks = (cardId: string) =>
        store.getCard(cardId)?.decision?.checks.filter((check) => check.check === 'shared_on_sheet') ?? [];

      it('moves each verified card to review, keeping the row in the decision', () => {
        const id = newJob();
        const sheet = newFile(id);
        const email = 'neighbour@acme.com';
        const rows = [row({ name: 'One', email }), row({ name: 'Two', email })];
        const cards = rows.map((cardRow, index) => pipelineCard(sheet, index, cardRow));
        const other = pipelineCard(sheet, 2, row({ name: 'Three', email: 'three@acme.com' }));

        store.markPossibleDuplicates(id);

        cards.forEach((card, index) => {
          const after = store.getCard(card.id);
          expect(after).toMatchObject({ status: 'needs_review', finalRow: null, stage: 'decided' });
          expect(after?.decision).toMatchObject({ status: 'needs_review', row: rows[index], flaggedFields: ['email'] });
          expect(sharedChecks(card.id)).toEqual([
            {
              check: 'shared_on_sheet',
              field: 'email',
              passed: false,
              detail:
                "This email also appears on another card in the same photo, so one card may have picked up its neighbour's text. Check it against the image.",
            },
          ]);
          expect(after?.decision?.checks).toHaveLength(2);
        });

        expect(store.getCard(cards[1]?.id ?? '')?.possibleDuplicateOf).toBe(cards[0]?.id);
        expect(store.getCard(other.id)).toEqual(other);
        expect(store.getCopyableRows(id).map(({ row: item }) => item.name)).toEqual(['Three']);
      });

      it('compares single addresses inside multi-value cells, ignoring case', () => {
        const id = newJob();
        const sheet = newFile(id);
        const first = pipelineCard(sheet, 0, row({ email: 'one@acme.com; shared@acme.com' }));
        const second = pipelineCard(sheet, 1, row({ email: 'SHARED@Acme.com; two@acme.com' }));
        store.markPossibleDuplicates(id);
        expect(store.getCard(first.id)?.status).toBe('needs_review');
        expect(store.getCard(second.id)?.status).toBe('needs_review');
      });

      it('does not match part of an address', () => {
        const id = newJob();
        const sheet = newFile(id);
        const first = pipelineCard(sheet, 0, row({ email: 'ann@acme.com' }));
        const second = pipelineCard(sheet, 1, row({ email: 'joann@acme.com; ann@acme.co' }));
        store.markPossibleDuplicates(id);
        expect(store.getCard(first.id)?.status).toBe('verified');
        expect(store.getCard(second.id)?.status).toBe('verified');
      });

      it('is safe to re-run: one check, and nothing else changes', () => {
        const id = newJob();
        const sheet = newFile(id);
        const email = 'shared@acme.com';
        const first = pipelineCard(sheet, 0, row({ email }));
        pipelineCard(sheet, 1, row({ email }));
        store.markPossibleDuplicates(id);
        const before = store.listCards(id);
        store.markPossibleDuplicates(id);
        store.markPossibleDuplicates(id);
        expect(store.listCards(id)).toEqual(before);
        expect(sharedChecks(first.id)).toHaveLength(1);
      });

      it('never adds a second check, even to a card set back to verified', () => {
        const id = newJob();
        const sheet = newFile(id);
        const email = 'shared@acme.com';
        const first = pipelineCard(sheet, 0, row({ email }));
        pipelineCard(sheet, 1, row({ email }));
        store.markPossibleDuplicates(id);
        store.updateCard(first.id, { status: 'verified', finalRow: row({ email }) });
        store.markPossibleDuplicates(id);
        expect(sharedChecks(first.id)).toHaveLength(1);
        expect(store.getCard(first.id)?.decision?.flaggedFields).toEqual(['email']);
      });

      it('never changes a card a person confirmed, but still protects its verified neighbour', () => {
        const id = newJob();
        const sheet = newFile(id);
        const email = 'shared@acme.com';
        const confirmed = pipelineCard(sheet, 0, row({ name: 'Person checked', email }));
        store.confirmCard(confirmed.id, row({ name: 'Person checked', email }));
        const neighbour = pipelineCard(sheet, 1, row({ email }));
        const before = store.getCard(confirmed.id);

        store.markPossibleDuplicates(id);

        expect(store.getCard(confirmed.id)).toEqual(before);
        expect(store.getCard(confirmed.id)).toMatchObject({ status: 'confirmed', confirmedByHuman: true });
        expect(store.getCard(neighbour.id)?.status).toBe('needs_review');
        expect(store.getCopyableRows(id).map(({ row: item }) => item.name)).toEqual(['Person checked']);
      });

      it('leaves two confirmed cards alone', () => {
        const id = newJob();
        const sheet = newFile(id);
        const email = 'shared@acme.com';
        const cards = [pipelineCard(sheet, 0, row({ email })), pipelineCard(sheet, 1, row({ email }))];
        for (const card of cards) store.confirmCard(card.id, row({ email }));
        store.markPossibleDuplicates(id);
        expect(store.listCards(id).map((card) => card.status)).toEqual(['confirmed', 'confirmed']);
        expect(store.getCopyableRows(id)).toHaveLength(2);
      });

      it('moves a verified card sharing with a needs_review card, which stays as it was', () => {
        const id = newJob();
        const sheet = newFile(id);
        const email = 'shared@acme.com';
        const review = newCard(id, [sheet], 0);
        store.updateCard(review.id, { status: 'needs_review', decision: decision(row({ email })) });
        const before = store.getCard(review.id);
        const verified = pipelineCard(sheet, 1, row({ email }));
        store.markPossibleDuplicates(id);
        expect(store.getCard(verified.id)?.status).toBe('needs_review');
        expect(store.getCard(review.id)).toEqual({ ...before, possibleDuplicateOf: null });
      });

      it('ignores a rejected neighbour', () => {
        const id = newJob();
        const sheet = newFile(id);
        const email = 'shared@acme.com';
        const rejected = pipelineCard(sheet, 0, row({ email }));
        store.rejectCard(rejected.id, 'Not a card');
        const verified = pipelineCard(sheet, 1, row({ email }));
        store.markPossibleDuplicates(id);
        expect(store.getCard(verified.id)).toEqual(verified);
      });

      it('leaves cards from different files verified, linked as possible duplicates', () => {
        const id = newJob();
        const email = 'shared@acme.com';
        const first = pipelineCard(newFile(id), 0, row({ email }));
        const second = pipelineCard(newFile(id), 0, row({ email }));
        store.markPossibleDuplicates(id);
        expect(store.getCard(first.id)).toEqual(first);
        expect(store.getCard(second.id)).toEqual({ ...second, possibleDuplicateOf: first.id });
        expect(store.getCopyableRows(id)).toHaveLength(2);
      });

      it('treats a front and back pair sharing a file as the same source', () => {
        const id = newJob();
        const [front, back, otherBack] = [newFile(id), newFile(id), newFile(id)];
        const email = 'shared@acme.com';
        const first = newCard(id, [front, back]);
        const second = newCard(id, [front, otherBack], 1);
        for (const card of [first, second]) store.updateCard(card.id, { status: 'verified', finalRow: row({ email }) });
        store.markPossibleDuplicates(id);
        expect(store.getCard(first.id)?.status).toBe('needs_review');
        expect(store.getCard(second.id)?.status).toBe('needs_review');
      });

      it('keeps the row on a verified card with no decision, and stops it being copied', () => {
        const id = newJob();
        const file = newFile(id);
        const email = 'shared@acme.com';
        const first = verifiedCard(id, file, 0, row({ name: 'Kept', email }));
        verifiedCard(id, file, 1, row({ email }));
        store.markPossibleDuplicates(id);
        expect(store.getCard(first.id)).toMatchObject({ status: 'needs_review', finalRow: row({ name: 'Kept', email }) });
        expect(store.getCopyableRows(id)).toEqual([]);
      });

      it('keeps reconciliation balanced', () => {
        const id = newJob();
        const sheet = newFile(id);
        store.updateFile(sheet.id, { stage: 'cropped' });
        for (let index = 0; index < 36; index += 1) {
          pipelineCard(sheet, index, row({ email: index < 4 ? 'shared@acme.com' : `p${index}@acme.com` }));
        }
        store.markPossibleDuplicates(id);
        expect(store.getReconciliation(id)).toMatchObject({
          files: 1,
          cards: 36,
          verified: 32,
          needsReview: 4,
          balanced: true,
        });
      });

      it('stays quick at 1,200 cards on one sheet, and on the re-run before a copy', () => {
        store.close();
        store = createStore(':memory:');
        const id = newJob();
        const sheet = newFile(id);
        for (let index = 0; index < 1_200; index += 1) {
          pipelineCard(sheet, index, row({ email: `pair${Math.floor(index / 2)}@acme.com` }));
        }
        const started = performance.now();
        store.markPossibleDuplicates(id);
        store.markPossibleDuplicates(id);
        // Generous, because other work shares this machine. A nested scan does about 720,000 comparisons.
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(store.getReconciliation(id)).toMatchObject({ needsReview: 1_200, verified: 0, balanced: true });
      });
    });

    it('does not link across jobs', () => {
      const first = newJob();
      const second = newJob();
      verifiedCard(first, newFile(first), 0, row({ email: 'jane@acme.com' }));
      const other = verifiedCard(second, newFile(second), 0, row({ email: 'jane@acme.com' }));
      store.markPossibleDuplicates(second);
      expect(store.getCard(other.id)?.possibleDuplicateOf).toBeNull();
    });
  });

  describe('deleteJob', () => {
    it('removes every row belonging to the job and nothing else', () => {
      const keep = newJob('Keep');
      const keepFile = newFile(keep);
      const keepCard = newCard(keep, [keepFile]);

      const id = newJob('Delete');
      const file = newFile(id, 'same');
      newFile(id, 'same');
      const card = newCard(id, [file]);
      store.saveRead({
        cardId: card.id,
        variant: 'A',
        outcome: { ok: false, failure: 'refused', detail: 'x' },
        model: 'm',
        usage: null,
        createdAt: 'now',
      });
      store.recordLlmCall({
        jobId: id,
        cardId: card.id,
        fileId: file.id,
        purpose: 'locate',
        model: 'm',
        ok: true,
        failure: null,
        attempts: 1,
        latencyMs: 1,
        usage: null,
        createdAt: 'now',
      });

      store.deleteJob(id);

      expect(store.getJob(id)).toBeUndefined();
      expect(store.getFile(file.id)).toBeUndefined();
      expect(store.getCard(card.id)).toBeUndefined();
      expect(store.listReads(card.id)).toEqual([]);
      expect(store.getJobSpendUsd(id)).toBe(0);
      expect(store.getCard(keepCard.id)).toBeDefined();

      const raw = new DatabaseSync(dbPath, { readOnly: true });
      const count = (table: string) =>
        (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(['jobs', 'files', 'cards', 'card_files', 'reads', 'llm_calls'].map(count)).toEqual([1, 1, 1, 1, 0, 0]);
      raw.close();
    });

    it('ignores a job that does not exist', () => {
      expect(() => store.deleteJob('nope')).not.toThrow();
    });
  });

  describe('durability', () => {
    it('uses WAL', () => {
      const raw = new DatabaseSync(dbPath, { readOnly: true });
      expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      raw.close();
    });

    it('keeps everything across a restart with a real file', () => {
      const id = newJob('Survivor');
      const file = newFile(id);
      const card = newCard(id, [file], 2, [crop(0, { quality: quality({ ok: false, issues: ['location_uncertain'] }) })]);
      store.setJobStatus(id, 'paused', 'cost_cap');
      store.updateCard(card.id, { status: 'verified', finalRow: row({ name: '山田太郎' }) });
      const before = {
        job: store.getJob(id),
        files: store.listFiles(id),
        cards: store.listCards(id),
        rows: store.getCopyableRows(id),
        reconciliation: store.getReconciliation(id),
      };

      reopen();

      expect({
        job: store.getJob(id),
        files: store.listFiles(id),
        cards: store.listCards(id),
        rows: store.getCopyableRows(id),
        reconciliation: store.getReconciliation(id),
      }).toEqual(before);
      expect(newFile(id).seq).toBe(1);
    });

    it('keeps every returned write when the process is killed without closing', () => {
      store.close();
      open = false;
      const storeUrl = pathToFileURL(resolve('src/data/store.ts')).href;
      const script = `
        import { createStore } from ${JSON.stringify(storeUrl)};
        const store = createStore(${JSON.stringify(dbPath)});
        const job = store.createJob({ name: 'Killed', options: { frontBackPairs: false, defaultCountry: null, costCapUsd: 10 } });
        const file = store.addFile({ jobId: job.id, originalName: 'a.jpg', sha256: 'a', byteSize: 1, storedPath: '/a.jpg' });
        const card = store.createCard({ jobId: job.id, sourceFileIds: [file.id], indexInSource: 0, crops: [] });
        store.saveRead({ cardId: card.id, variant: 'A', outcome: { ok: false, failure: 'refused', detail: 'x' }, model: 'm', usage: null, createdAt: 'now' });
        console.log(JSON.stringify({ jobId: job.id, cardId: card.id }));
        process.kill(process.pid, 'SIGKILL');
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '--no-warnings', '-e', script], { encoding: 'utf8' });
      expect(child.signal).toBe('SIGKILL');
      const { jobId, cardId } = JSON.parse(child.stdout) as { jobId: string; cardId: string };

      store = createStore(dbPath);
      open = true;
      expect(store.getJob(jobId)?.name).toBe('Killed');
      expect(store.listFiles(jobId)).toHaveLength(1);
      expect(store.listReads(cardId)).toHaveLength(1);
    });

    it('rolls back a failed transaction, leaving no half-made card', () => {
      const id = newJob();
      const file = newFile(id);
      expect(() =>
        store.createCard({ jobId: id, sourceFileIds: [file.id, 'nope'], indexInSource: 0, crops: [] }),
      ).toThrow();
      expect(store.listCards(id)).toEqual([]);
      expect(newCard(id, [file]).status).toBe('pending');
    });
  });

  describe('scale', () => {
    it('handles 1,200 cards on a few sheets without slowing down', () => {
      // In memory, so this measures the work and not the disk.
      store.close();
      store = createStore(':memory:');
      const id = newJob();
      const files = Array.from({ length: 34 }, () => newFile(id));
      for (let index = 0; index < 1_200; index += 1) {
        const sheet = files[index % 34] as SourceFile;
        const card = newCard(id, [sheet], Math.floor(index / 34));
        // A group of 200 cards sharing one switchboard is the worst case for a nested scan.
        const cardRow = row({
          email: `person${index % 900}@acme.com`,
          phone: index % 6 === 0 ? '+91 98765 43210' : `+91 98765 ${String(40000 + index)}`,
        });
        store.updateCard(card.id, { status: 'verified', finalRow: cardRow });
      }

      const started = performance.now();
      store.markPossibleDuplicates(id);
      const elapsed = performance.now() - started;

      const cards = store.listCards(id);
      expect(cards).toHaveLength(1_200);
      expect(cards.filter((card) => card.possibleDuplicateOf !== null).length).toBeGreaterThan(300);
      expect(store.getCopyableRows(id)).toHaveLength(1_200);
      expect(store.getReconciliation(id)).toMatchObject({ cards: 1_200, verified: 1_200, balanced: true });
      // Generous, because other work shares this machine. A nested scan does about 720,000 comparisons.
      expect(elapsed).toBeLessThan(5_000);
    });
  });
});
