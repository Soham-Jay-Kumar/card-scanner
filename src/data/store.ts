/**
 * The job database, on node:sqlite. Synchronous, and every write has reached
 * the disk on return: WAL with synchronous=FULL survives the app or the system
 * crashing. checkpoint_fullfsync keeps the database file itself safe from a
 * power cut. Commits deliberately don't use fullfsync: measured on this Mac it
 * takes each write from under 1ms to about 20ms, blocking the server, and a
 * power cut can cost at most the last moments of work, which a resume redoes.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type {
  Card,
  CardCrop,
  CardDecision,
  CardRow,
  CardStage,
  CardStatus,
  CreateStore,
  FileStage,
  Job,
  JobOptions,
  JobStatus,
  LlmLedgerEntry,
  LocateResult,
  NewCard,
  NewSourceFile,
  NormalizedImage,
  PauseReason,
  QualityReport,
  ReadImages,
  ReadOutcome,
  ReadRecord,
  ReadVariant,
  Reconciliation,
  SourceFile,
  Store,
  LlmUsage,
} from '../shared/contracts.ts';
import { findPossibleDuplicates, findSharedOnSheet, sendToReview } from './duplicates.ts';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    pause_reason TEXT,
    options TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    stored_path TEXT NOT NULL,
    stage TEXT NOT NULL,
    duplicate_of_file_id TEXT REFERENCES files (id) ON DELETE SET NULL,
    normalized TEXT,
    quality TEXT,
    locate TEXT,
    error TEXT,
    UNIQUE (job_id, seq)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS files_by_hash ON files (job_id, sha256, seq);
  CREATE INDEX IF NOT EXISTS files_by_duplicate ON files (duplicate_of_file_id);

  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    first_file_seq INTEGER NOT NULL,
    index_in_source INTEGER NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    crops TEXT NOT NULL,
    read_images TEXT NOT NULL,
    decision TEXT,
    final_row TEXT,
    confirmed_by_human INTEGER NOT NULL DEFAULT 0,
    possible_duplicate_of TEXT,
    error TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS cards_in_upload_order ON cards (job_id, first_file_seq, index_in_source);

  CREATE TABLE IF NOT EXISTS card_files (
    card_id TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, position)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS card_files_by_file ON card_files (file_id);

  CREATE TABLE IF NOT EXISTS reads (
    card_id TEXT NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    variant TEXT NOT NULL,
    outcome TEXT NOT NULL,
    model TEXT NOT NULL,
    usage TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (card_id, variant)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    card_id TEXT,
    file_id TEXT,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    ok INTEGER NOT NULL,
    failure TEXT,
    attempts INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    usage TEXT,
    cost_usd REAL NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS llm_calls_by_job ON llm_calls (job_id);
`;

type SqlValue = string | number | null;

const toJson = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

function fromJson<T>(text: unknown): T | null {
  return typeof text === 'string' ? (JSON.parse(text) as T) : null;
}

interface JobRow {
  id: string;
  name: string;
  created_at: string;
  status: string;
  pause_reason: string | null;
  options: string;
}

interface FileRow {
  id: string;
  job_id: string;
  seq: number;
  original_name: string;
  sha256: string;
  byte_size: number;
  stored_path: string;
  stage: string;
  duplicate_of_file_id: string | null;
  normalized: string | null;
  quality: string | null;
  locate: string | null;
  error: string | null;
}

interface CardTableRow {
  id: string;
  job_id: string;
  source_file_ids: string;
  index_in_source: number;
  stage: string;
  status: string;
  crops: string;
  read_images: string;
  decision: string | null;
  final_row: string | null;
  confirmed_by_human: number;
  possible_duplicate_of: string | null;
  error: string | null;
}

interface ReadTableRow {
  card_id: string;
  variant: string;
  outcome: string;
  model: string;
  usage: string | null;
  created_at: string;
}

const toJob = (row: JobRow): Job => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  status: row.status as JobStatus,
  pauseReason: row.pause_reason as PauseReason | null,
  options: JSON.parse(row.options) as JobOptions,
});

const toFile = (row: FileRow): SourceFile => ({
  id: row.id,
  jobId: row.job_id,
  seq: row.seq,
  originalName: row.original_name,
  sha256: row.sha256,
  byteSize: row.byte_size,
  storedPath: row.stored_path,
  stage: row.stage as FileStage,
  duplicateOfFileId: row.duplicate_of_file_id,
  normalized: fromJson<NormalizedImage>(row.normalized),
  quality: fromJson<QualityReport>(row.quality),
  locate: fromJson<LocateResult>(row.locate),
  error: row.error,
});

const toCard = (row: CardTableRow): Card => ({
  id: row.id,
  jobId: row.job_id,
  sourceFileIds: JSON.parse(row.source_file_ids) as string[],
  indexInSource: row.index_in_source,
  stage: row.stage as CardStage,
  status: row.status as CardStatus,
  crops: JSON.parse(row.crops) as CardCrop[],
  readImages: JSON.parse(row.read_images) as ReadImages[],
  decision: fromJson<CardDecision>(row.decision),
  finalRow: fromJson<CardRow>(row.final_row),
  confirmedByHuman: row.confirmed_by_human === 1,
  possibleDuplicateOf: row.possible_duplicate_of,
  error: row.error,
});

const toRead = (row: ReadTableRow): ReadRecord => ({
  cardId: row.card_id,
  variant: row.variant as ReadVariant,
  outcome: JSON.parse(row.outcome) as ReadOutcome,
  model: row.model,
  usage: fromJson<LlmUsage>(row.usage),
  createdAt: row.created_at,
});

const SOURCE_FILE_IDS = `
    (SELECT json_group_array(file_id)
       FROM (SELECT file_id FROM card_files WHERE card_id = c.id ORDER BY position)) AS source_file_ids`;

const SELECT_CARD = `SELECT c.*, ${SOURCE_FILE_IDS} FROM cards c`;

/** File seq, then position within that file, so rows follow reading order within a sheet. */
const UPLOAD_ORDER = 'ORDER BY c.first_file_seq, c.index_in_source, c.rowid';

const FILE_STAGES_IN_PROGRESS: readonly string[] = ['received', 'normalized', 'quality_checked', 'located'];

/** Which column each patch key writes to, and how its value is stored. */
const FILE_COLUMNS: Record<string, [string, (value: unknown) => SqlValue]> = {
  stage: ['stage', (value) => value as string],
  normalized: ['normalized', toJson],
  quality: ['quality', toJson],
  locate: ['locate', toJson],
  error: ['error', (value) => value as string | null],
};

const CARD_COLUMNS: Record<string, [string, (value: unknown) => SqlValue]> = {
  stage: ['stage', (value) => value as string],
  status: ['status', (value) => value as string],
  crops: ['crops', toJson],
  readImages: ['read_images', toJson],
  decision: ['decision', toJson],
  finalRow: ['final_row', toJson],
  error: ['error', (value) => value as string | null],
  possibleDuplicateOf: ['possible_duplicate_of', (value) => value as string | null],
};

export const createStore: CreateStore = (dbPath) => {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, timeout: 5_000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA checkpoint_fullfsync = ON;');
  db.exec(SCHEMA);

  const statements = new Map<string, StatementSync>();
  function sql(text: string): StatementSync {
    let statement = statements.get(text);
    if (!statement) {
      statement = db.prepare(text);
      statements.set(text, statement);
    }
    return statement;
  }

  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function requireChange(changes: number | bigint, kind: string, id: string): void {
    if (Number(changes) === 0) throw new Error(`Unknown ${kind}: ${id}`);
  }

  /** Writes only the keys present in the patch. An explicit null clears a column. */
  function patchRow(
    table: string,
    id: string,
    patch: Record<string, unknown>,
    columns: Record<string, [string, (value: unknown) => SqlValue]>,
    kind: string,
  ): void {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const values: SqlValue[] = [];
    const assignments = entries.map(([key, value]) => {
      const column = columns[key];
      if (!column) throw new Error(`Cannot update ${key} on a ${kind}`);
      values.push(column[1](value));
      return `${column[0]} = ?`;
    });
    const { changes } = sql(`UPDATE ${table} SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
    requireChange(changes, kind, id);
  }

  function getJob(id: string): Job | undefined {
    const row = sql('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : undefined;
  }

  function getFile(id: string): SourceFile | undefined {
    const row = sql('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
    return row ? toFile(row) : undefined;
  }

  function getCard(id: string): Card | undefined {
    const row = sql(`${SELECT_CARD} WHERE c.id = ?`).get(id) as CardTableRow | undefined;
    return row ? toCard(row) : undefined;
  }

  function listCards(jobId: string, filter?: { status?: CardStatus }): Card[] {
    const rows = filter?.status
      ? sql(`${SELECT_CARD} WHERE c.job_id = ? AND c.status = ? ${UPLOAD_ORDER}`).all(jobId, filter.status)
      : sql(`${SELECT_CARD} WHERE c.job_id = ? ${UPLOAD_ORDER}`).all(jobId);
    return (rows as unknown as CardTableRow[]).map(toCard);
  }

  function countBy(query: string, jobId: string): Map<string, number> {
    const rows = sql(query).all(jobId) as unknown as Array<{ bucket: string; total: number }>;
    return new Map(rows.map((row) => [row.bucket, row.total]));
  }

  const sumOf = (counts: Map<string, number>): number => [...counts.values()].reduce((sum, count) => sum + count, 0);

  const store: Store = {
    createJob({ name, options }) {
      const job: Job = {
        id: randomUUID(),
        name,
        createdAt: new Date().toISOString(),
        status: 'uploading',
        pauseReason: null,
        options,
      };
      sql('INSERT INTO jobs (id, name, created_at, status, pause_reason, options) VALUES (?, ?, ?, ?, NULL, ?)').run(
        job.id,
        job.name,
        job.createdAt,
        job.status,
        JSON.stringify(options),
      );
      return job;
    },

    getJob,

    listJobs() {
      const rows = sql('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC').all();
      return (rows as unknown as JobRow[]).map(toJob);
    },

    setJobStatus(id, status, pauseReason) {
      const { changes } = sql('UPDATE jobs SET status = ?, pause_reason = ? WHERE id = ?').run(
        status,
        pauseReason ?? null,
        id,
      );
      requireChange(changes, 'job', id);
    },

    setJobCostCap(id, costCapUsd) {
      const job = getJob(id);
      if (!job) throw new Error(`No job ${id}`);
      const options: JobOptions = { ...job.options, costCapUsd };
      const { changes } = sql('UPDATE jobs SET options = ? WHERE id = ?').run(JSON.stringify(options), id);
      requireChange(changes, 'job', id);
    },

    deleteJob(id) {
      sql('DELETE FROM jobs WHERE id = ?').run(id);
    },

    addFile(input) {
      const { jobId, originalName, sha256, byteSize, storedPath } = input;
      return transaction(() => {
        const { next } = sql('SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM files WHERE job_id = ?').get(jobId) as {
          next: number;
        };
        const original = sql('SELECT id FROM files WHERE job_id = ? AND sha256 = ? ORDER BY seq LIMIT 1').get(
          jobId,
          sha256,
        ) as { id: string } | undefined;
        const id = randomUUID();
        sql(
          `INSERT INTO files (id, job_id, seq, original_name, sha256, byte_size, stored_path, stage, duplicate_of_file_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, jobId, next, originalName, sha256, byteSize, storedPath, original ? 'duplicate' : 'received', original?.id ?? null);
        return getFile(id) as SourceFile;
      });
    },

    getFile,

    listFiles(jobId) {
      const rows = sql('SELECT * FROM files WHERE job_id = ? ORDER BY seq').all(jobId);
      return (rows as unknown as FileRow[]).map(toFile);
    },

    updateFile(id, patch) {
      patchRow('files', id, patch, FILE_COLUMNS, 'file');
    },

    createCard(input: NewCard) {
      const { jobId, sourceFileIds, indexInSource, crops } = input;
      if (sourceFileIds.length === 0) throw new Error('A card needs at least one source file.');
      return transaction(() => {
        const seqs = sourceFileIds.map((fileId) => {
          const file = sql('SELECT seq FROM files WHERE id = ? AND job_id = ?').get(fileId, jobId) as
            | { seq: number }
            | undefined;
          if (!file) throw new Error(`File ${fileId} is not in job ${jobId}`);
          return file.seq;
        });
        const id = randomUUID();
        sql(
          `INSERT INTO cards (id, job_id, first_file_seq, index_in_source, stage, status, crops, read_images)
           VALUES (?, ?, ?, ?, 'created', 'pending', ?, '[]')`,
        ).run(id, jobId, Math.min(...seqs), indexInSource, JSON.stringify(crops));
        sourceFileIds.forEach((fileId, position) => {
          sql('INSERT INTO card_files (card_id, position, file_id) VALUES (?, ?, ?)').run(id, position, fileId);
        });
        return getCard(id) as Card;
      });
    },

    getCard,
    listCards,

    updateCard(id, patch) {
      patchRow('cards', id, patch, CARD_COLUMNS, 'card');
    },

    saveRead(record) {
      sql(
        `INSERT INTO reads (card_id, variant, outcome, model, usage, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (card_id, variant) DO UPDATE SET
           outcome = excluded.outcome, model = excluded.model, usage = excluded.usage, created_at = excluded.created_at`,
      ).run(
        record.cardId,
        record.variant,
        JSON.stringify(record.outcome),
        record.model,
        toJson(record.usage),
        record.createdAt,
      );
    },

    listReads(cardId) {
      const rows = sql('SELECT * FROM reads WHERE card_id = ? ORDER BY variant').all(cardId);
      return (rows as unknown as ReadTableRow[]).map(toRead);
    },

    recordLlmCall(entry: LlmLedgerEntry) {
      sql(
        `INSERT INTO llm_calls
           (job_id, card_id, file_id, purpose, model, ok, failure, attempts, latency_ms, usage, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.jobId,
        entry.cardId,
        entry.fileId,
        entry.purpose,
        entry.model,
        entry.ok ? 1 : 0,
        entry.failure,
        entry.attempts,
        entry.latencyMs,
        toJson(entry.usage),
        entry.usage?.costUsd ?? 0,
        entry.createdAt,
      );
    },

    getJobSpendUsd(jobId) {
      const { total } = sql('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_calls WHERE job_id = ?').get(jobId) as {
        total: number;
      };
      return total;
    },

    confirmCard(cardId, row) {
      const { changes } = sql(
        `UPDATE cards SET status = 'confirmed', final_row = ?, confirmed_by_human = 1, error = NULL WHERE id = ?`,
      ).run(JSON.stringify(row), cardId);
      requireChange(changes, 'card', cardId);
    },

    rejectCard(cardId, reason) {
      const { changes } = sql(
        `UPDATE cards SET status = 'rejected', final_row = NULL, confirmed_by_human = 0, error = ? WHERE id = ?`,
      ).run(reason, cardId);
      requireChange(changes, 'card', cardId);
    },

    getCopyableRows(jobId) {
      const rows = sql(
        `SELECT c.id, c.final_row, c.decision FROM cards c
         WHERE c.job_id = ? AND c.status IN ('verified', 'confirmed') ${UPLOAD_ORDER}`,
      ).all(jobId) as unknown as Array<Pick<CardTableRow, 'id' | 'final_row' | 'decision'>>;

      return rows.map(({ id, final_row: finalRow, decision }) => {
        const row = fromJson<CardRow>(finalRow) ?? fromJson<CardDecision>(decision)?.row;
        // Leaving it out would lose a card without anyone noticing.
        if (!row) throw new Error(`Card ${id} can be copied but has no row.`);
        return { cardId: id, row };
      });
    },

    getReconciliation(jobId): Reconciliation {
      const fileCounts = countBy('SELECT stage AS bucket, COUNT(*) AS total FROM files WHERE job_id = ? GROUP BY stage', jobId);
      const cardCounts = countBy('SELECT status AS bucket, COUNT(*) AS total FROM cards WHERE job_id = ? GROUP BY status', jobId);
      const count = (counts: Map<string, number>, bucket: string): number => counts.get(bucket) ?? 0;

      const files = sumOf(fileCounts);
      const duplicateFiles = count(fileCounts, 'duplicate');
      const noCardFiles = count(fileCounts, 'no_card');
      const failedFiles = count(fileCounts, 'failed');
      const filesInProgress = FILE_STAGES_IN_PROGRESS.reduce((sum, stage) => sum + count(fileCounts, stage), 0);

      // A cropped file is accounted for by its cards, however many it produced.
      const { total: croppedWithCards } = sql(
        `SELECT COUNT(*) AS total FROM files f
         WHERE f.job_id = ? AND f.stage = 'cropped'
           AND EXISTS (SELECT 1 FROM card_files cf WHERE cf.file_id = f.id)`,
      ).get(jobId) as { total: number };

      const cards = sumOf(cardCounts);
      const verified = count(cardCounts, 'verified');
      const confirmed = count(cardCounts, 'confirmed');
      const needsReview = count(cardCounts, 'needs_review');
      const rejected = count(cardCounts, 'rejected');
      const failedCards = count(cardCounts, 'failed');
      const cardsInProgress = count(cardCounts, 'pending');

      const filesAccountedFor = duplicateFiles + noCardFiles + failedFiles + filesInProgress + croppedWithCards;
      const cardsAccountedFor = verified + confirmed + needsReview + rejected + failedCards + cardsInProgress;

      return {
        files,
        duplicateFiles,
        noCardFiles,
        failedFiles,
        filesInProgress,
        cards,
        verified,
        confirmed,
        needsReview,
        rejected,
        failedCards,
        cardsInProgress,
        balanced: filesAccountedFor === files && cardsAccountedFor === cards,
      };
    },

    markPossibleDuplicates(jobId) {
      const defaultCountry = getJob(jobId)?.options.defaultCountry ?? null;
      const rows = sql(
        `SELECT c.id, c.status, c.final_row, c.decision, c.possible_duplicate_of, ${SOURCE_FILE_IDS} FROM cards c
         WHERE c.job_id = ? ${UPLOAD_ORDER}`,
      ).all(jobId) as unknown as Array<
        Pick<CardTableRow, 'id' | 'status' | 'final_row' | 'decision' | 'possible_duplicate_of' | 'source_file_ids'>
      >;

      const candidates = rows.map(({ id, status, final_row: finalRow, decision, source_file_ids: fileIds }) => ({
        cardId: id,
        row: status === 'rejected' ? null : (fromJson<CardRow>(finalRow) ?? fromJson<CardDecision>(decision)?.row ?? null),
        sourceFileIds: JSON.parse(fileIds) as string[],
      }));
      const links = findPossibleDuplicates(candidates, defaultCountry);
      const sharedOnSheet = findSharedOnSheet(candidates);

      transaction(() => {
        rows.forEach((row, index) => {
          const link = links.get(row.id) ?? null;
          if (link !== row.possible_duplicate_of) {
            sql('UPDATE cards SET possible_duplicate_of = ? WHERE id = ?').run(link, row.id);
          }

          // Only verified cards move, so a confirmed card is never touched and a re-run finds nothing to do.
          const cardRow = candidates[index]?.row;
          if (row.status !== 'verified' || !cardRow || !sharedOnSheet.has(row.id)) return;
          const decision = fromJson<CardDecision>(row.decision);
          // With no decision to hold the row, finalRow keeps it. needs_review alone stops it being copied.
          sql(`UPDATE cards SET status = 'needs_review', final_row = ?, decision = ? WHERE id = ?`).run(
            decision ? null : row.final_row,
            toJson(decision && sendToReview(decision, cardRow)),
            row.id,
          );
        });
      });
    },

    close() {
      statements.clear();
      db.close();
    },
  };

  return store;
};
