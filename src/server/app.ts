/**
 * Composition root: wires every team's module together behind the HTTP API.
 * Owned by the Chief Engineer. Takes its settings as arguments, so tests can
 * point the whole app at a temp folder and the QA fake server.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';

import { CONFIG } from '../shared/config.ts';
import { FIELD_KEYS } from '../shared/contracts.ts';
import { photoNeedsCheck } from '../shared/photoCheck.ts';
import type { Card, CardLocation, CardRow, CardStatus, FieldKey, JobEngine, LocateResult, Store } from '../shared/contracts.ts';
import { createStore } from '../data/index.ts';
import { createDecisionService } from '../validation/index.ts';
import { createExtractionService } from '../extraction/index.ts';
import { createJobEngine } from '../engine/index.ts';
import { createLlmClient } from '../llm/index.ts';
import { createPasteService } from '../paste/index.ts';
import { createVisionService } from '../vision/index.ts';
import { toCsv, toXlsx } from '../export/index.ts';

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

const NewJobBody = z.object({
  name: z.string().trim().min(1).max(200),
  frontBackPairs: z.boolean().default(false),
  defaultCountry: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase())
    .nullable()
    .default(null),
  costCapUsd: z.number().positive().max(10_000).default(CONFIG.job.defaultCostCapUsd),
});

const RowBody = z.object({
  row: z.object(Object.fromEntries(FIELD_KEYS.map((key) => [key, z.string().max(2_000)])) as Record<FieldKey, z.ZodString>),
});

const RejectBody = z.object({ reason: z.string().trim().min(1).max(500) });
const AddCardBody = z.object({
  box: z.object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
});
const CostCapBody = z.object({ costCapUsd: z.number().positive().max(10_000) });
const CopyBody = z.object({ includeHeader: z.boolean().default(true) });
const VerifyBody = z.object({ pastedText: z.string().max(20_000_000) });

export interface AppOptions {
  dataDir: string;
  apiKey?: string;
  baseURL?: string;
  /** Built web app folder. Omit when only the API is needed. */
  staticDir?: string;
}

export interface CardScannerApp {
  http: Hono;
  store: Store;
  engine: JobEngine;
  shutdown(): Promise<void>;
}

function cardSummary(card: Card, sourceName: string) {
  return {
    id: card.id,
    status: card.status,
    row: card.finalRow ?? card.decision?.row ?? null,
    flaggedFields: card.decision?.flaggedFields ?? [],
    confirmedByHuman: card.confirmedByHuman,
    possibleDuplicateOf: card.possibleDuplicateOf,
    error: card.error,
    sourceName,
    sourceFileIds: card.sourceFileIds,
  };
}

export function createApp(options: AppOptions): CardScannerApp {
  const jobsDir = join(options.dataDir, 'jobs');
  const store = createStore(join(options.dataDir, 'card-scanner.sqlite'));

  const llm = createLlmClient({
    // A missing key fails on the first call with a 401, which pauses the job with a plain message.
    apiKey: options.apiKey || 'missing-api-key',
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    onCall: (entry) => store.recordLlmCall(entry),
    getSpendUsd: (jobId) => store.getJobSpendUsd(jobId),
    getCostCapUsd: (jobId) => store.getJob(jobId)?.options.costCapUsd ?? CONFIG.job.defaultCostCapUsd,
  });

  const vision = createVisionService({ llm });
  const engine = createJobEngine({
    store,
    vision,
    extraction: createExtractionService({ llm }),
    decision: createDecisionService({}),
    jobsDir,
    getLlmConcurrency: () => llm.getConcurrency(),
  });

  const paste = createPasteService();
  const hasReader = Boolean(options.apiKey || options.baseURL);

  const http = new Hono();

  /** The app listens on this Mac only, but any website could still call localhost, so refuse those. */
  http.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    const fetchSite = c.req.header('sec-fetch-site');
    const allowed =
      LOCAL_HOST.test(c.req.header('host') ?? '') &&
      (!origin || LOCAL_ORIGIN.test(origin)) &&
      (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none');
    if (!allowed) return c.json({ error: 'Requests are only accepted from this Mac.' }, 403);
    await next();
  });

  const requireJob = (id: string) => {
    const job = store.getJob(id);
    if (!job) throw new HttpError(404, 'That job no longer exists.');
    return job;
  };
  const requireFile = (id: string) => {
    const file = store.getFile(id);
    if (!file) throw new HttpError(404, 'That image no longer exists.');
    return file;
  };
  const requireCard = (id: string) => {
    const card = store.getCard(id);
    if (!card) throw new HttpError(404, 'That card no longer exists.');
    return card;
  };

  http.get('/api/status', (c) => c.json({ hasApiKey: hasReader, model: CONFIG.model, maxCardsPerJob: CONFIG.job.maxCardsPerJob }));

  http.get('/api/jobs', (c) =>
    c.json(store.listJobs().map((job) => ({ ...job, reconciliation: store.getReconciliation(job.id) }))),
  );

  http.post('/api/jobs', async (c) => {
    const body = NewJobBody.parse(await c.req.json());
    const job = store.createJob({
      name: body.name,
      options: { frontBackPairs: body.frontBackPairs, defaultCountry: body.defaultCountry, costCapUsd: body.costCapUsd },
    });
    return c.json(job, 201);
  });

  http.get('/api/jobs/:id', (c) => c.json(requireJob(c.req.param('id'))));

  http.delete('/api/jobs/:id', async (c) => {
    const job = requireJob(c.req.param('id'));
    engine.cancel(job.id);
    store.deleteJob(job.id);
    await rm(join(jobsDir, job.id), { recursive: true, force: true });
    return c.json({ deleted: true });
  });

  /** One file per request, so a failed upload can be retried without resending the rest. */
  http.post('/api/jobs/:id/files', async (c) => {
    const job = requireJob(c.req.param('id'));
    if (job.status !== 'uploading') throw new HttpError(409, 'This job has already started.');
    if (store.listFiles(job.id).length >= CONFIG.job.maxCardsPerJob) {
      throw new HttpError(413, `A job can hold up to ${CONFIG.job.maxCardsPerJob} files.`);
    }
    const body = c.req.raw.body;
    if (!body) throw new HttpError(400, 'No file was sent.');

    const originalName = decodeURIComponent(c.req.header('x-file-name') ?? 'card');
    const uploadDir = join(jobsDir, job.id, 'uploads');
    await mkdir(uploadDir, { recursive: true });

    const tempPath = join(uploadDir, `${randomUUID()}.part`);
    const hash = createHash('sha256');
    let byteSize = 0;
    try {
      await pipeline(
        Readable.fromWeb(body as never),
        async function* (source) {
          for await (const chunk of source) {
            byteSize += (chunk as Buffer).length;
            if (byteSize > MAX_UPLOAD_BYTES) throw new HttpError(413, 'That file is larger than 64 MB.');
            hash.update(chunk as Buffer);
            yield chunk;
          }
        },
        createWriteStream(tempPath),
      );
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    if (byteSize === 0) {
      await rm(tempPath, { force: true });
      throw new HttpError(400, `${originalName} is empty.`);
    }

    const sha256 = hash.digest('hex');
    const storedPath = join(uploadDir, `${sha256}${extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '')}`);
    await rename(tempPath, storedPath);
    return c.json(store.addFile({ jobId: job.id, originalName, sha256, byteSize, storedPath }), 201);
  });

  http.get('/api/jobs/:id/files', (c) => c.json(store.listFiles(requireJob(c.req.param('id')).id)));

  http.get('/api/files/:id/image', async (c) => {
    const path = requireFile(c.req.param('id')).normalized?.path;
    const info = path ? await stat(path).catch(() => null) : null;
    if (!path || !info) throw new HttpError(404, 'That image no longer exists.');
    const type = path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: { 'content-type': type, 'content-length': String(info.size), 'cache-control': 'private, max-age=3600' },
    });
  });

  /**
   * The user drew a box around a card the app missed. This is the safety net for
   * a card overlooked by both locate passes, which no automatic check can catch.
   */
  http.post('/api/files/:id/cards', async (c) => {
    const file = requireFile(c.req.param('id'));
    if (!file.normalized) throw new HttpError(409, 'This image could not be read, so a card cannot be added to it.');
    const location = AddCardBody.parse(await c.req.json()) as CardLocation;

    const locate: LocateResult = file.locate ?? {
      noCard: false,
      locations: [],
      fellBackToFullImage: false,
      countConfirmed: false,
      note: null,
    };
    const single: LocateResult = { noCard: false, locations: [location], fellBackToFullImage: false, countConfirmed: true, note: null };
    const crops = await vision.crop(file.normalized, single, join(jobsDir, file.jobId, 'added', randomUUID()));

    const siblings = store.listCards(file.jobId).filter((card) => card.sourceFileIds.includes(file.id));
    const card = store.createCard({
      jobId: file.jobId,
      sourceFileIds: [file.id],
      indexInSource: Math.max(-1, ...siblings.map((sibling) => sibling.indexInSource)) + 1,
      crops,
    });
    // The count changed, so the person confirms it again once they've finished adding cards.
    store.updateFile(file.id, {
      stage: 'cropped',
      locate: { ...locate, noCard: false, locations: [...locate.locations, location], checkedByPerson: false },
    });
    // A paused scan stays paused: the new card is read when the user presses Resume.
    if (store.getJob(file.jobId)?.status !== 'paused') engine.start(file.jobId);
    return c.json(cardSummary(card, file.originalName), 201);
  });

  http.post('/api/files/:id/confirm-count', (c) => {
    const file = requireFile(c.req.param('id'));
    if (!file.locate) throw new HttpError(409, 'This image hasn’t been searched for cards yet.');
    store.updateFile(file.id, { locate: { ...file.locate, countConfirmed: true, note: null, checkedByPerson: true } });
    return c.json(requireFile(file.id));
  });

  http.post('/api/jobs/:id/start', (c) => {
    const job = requireJob(c.req.param('id'));
    if (!hasReader) throw new HttpError(409, 'Add your OpenAI API key to .env.local, then restart the app.');
    if (store.listFiles(job.id).length === 0) throw new HttpError(400, 'This job has no files yet.');
    engine.start(job.id);
    return c.json(engine.getProgress(job.id));
  });
  http.post('/api/jobs/:id/pause', (c) => {
    const job = requireJob(c.req.param('id'));
    engine.pause(job.id);
    return c.json(engine.getProgress(job.id));
  });
  http.post('/api/jobs/:id/resume', (c) => {
    const job = requireJob(c.req.param('id'));
    engine.resume(job.id);
    return c.json(engine.getProgress(job.id));
  });
  http.post('/api/jobs/:id/cost-cap', async (c) => {
    const job = requireJob(c.req.param('id'));
    const { costCapUsd } = CostCapBody.parse(await c.req.json());
    const spent = store.getJobSpendUsd(job.id);
    if (costCapUsd <= spent) throw new HttpError(400, `The new cap must be more than the $${spent.toFixed(2)} already spent.`);
    store.setJobCostCap(job.id, costCapUsd);
    return c.json(engine.getProgress(job.id));
  });
  http.post('/api/jobs/:id/cancel', (c) => {
    const job = requireJob(c.req.param('id'));
    engine.cancel(job.id);
    return c.json(engine.getProgress(job.id));
  });

  http.get('/api/jobs/:id/progress', (c) => c.json(engine.getProgress(requireJob(c.req.param('id')).id)));

  http.get('/api/jobs/:id/cards', (c) => {
    const job = requireJob(c.req.param('id'));
    const status = c.req.query('status') as CardStatus | undefined;
    const names = new Map(store.listFiles(job.id).map((file) => [file.id, file.originalName]));
    const cards = store.listCards(job.id, status ? { status } : undefined);
    return c.json(cards.map((card) => cardSummary(card, names.get(card.sourceFileIds[0] ?? '') ?? '')));
  });

  http.get('/api/cards/:id', (c) => {
    const card = requireCard(c.req.param('id'));
    return c.json({ card, reads: store.listReads(card.id) });
  });

  /** Serves the natural crop. The path comes from the database, never from the request. */
  http.get('/api/cards/:id/images/:index', async (c) => {
    const card = requireCard(c.req.param('id'));
    const crop = card.crops[Number(c.req.param('index'))];
    if (!crop) throw new HttpError(404, 'That image no longer exists.');
    const info = await stat(crop.path).catch(() => null);
    if (!info) throw new HttpError(404, 'That image no longer exists.');
    const type = crop.path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    return new Response(Readable.toWeb(createReadStream(crop.path)) as ReadableStream, {
      headers: { 'content-type': type, 'content-length': String(info.size), 'cache-control': 'private, max-age=3600' },
    });
  });

  http.post('/api/cards/:id/confirm', async (c) => {
    const card = requireCard(c.req.param('id'));
    const { row } = RowBody.parse(await c.req.json());
    store.confirmCard(card.id, row as CardRow);
    return c.json(cardSummary(requireCard(card.id), ''));
  });

  http.post('/api/cards/:id/reject', async (c) => {
    const card = requireCard(c.req.param('id'));
    const { reason } = RejectBody.parse(await c.req.json());
    store.rejectCard(card.id, reason);
    return c.json(cardSummary(requireCard(card.id), ''));
  });

  /** Nothing leaves the app while an image with several cards still needs its count confirmed. */
  const requireCountsChecked = (jobId: string) => {
    const waiting = store.listFiles(jobId).filter(photoNeedsCheck).length;
    if (waiting > 0) {
      throw new HttpError(
        409,
        `Check ${waiting === 1 ? '1 photo' : `${waiting} photos`} in the Photos tab first, to confirm every card was found.`,
      );
    }
  };

  /** Runs the neighbouring-card check first, so a suspect card can never leave the app unchecked. */
  const copyableRows = (jobId: string) => {
    store.markPossibleDuplicates(jobId);
    return store.getCopyableRows(jobId).map(({ row }) => row);
  };

  /** Writes the Mac clipboard directly. The payload comes back only for the browser fallback. */
  http.post('/api/jobs/:id/copy', async (c) => {
    const job = requireJob(c.req.param('id'));
    const { includeHeader } = CopyBody.parse(await c.req.json().catch(() => ({})));
    requireCountsChecked(job.id);
    const rows = copyableRows(job.id);
    if (rows.length === 0) throw new HttpError(409, 'No cards are ready to copy yet.');
    const payload = paste.encode(rows, { includeHeader });
    const result = await paste
      .writeClipboard(payload)
      .catch((error: Error) => ({ verified: false, detail: error.message }));
    return c.json({ ...result, rowCount: rows.length, fallback: result.verified ? null : payload });
  });

  http.post('/api/jobs/:id/verify-paste', async (c) => {
    const job = requireJob(c.req.param('id'));
    const { pastedText } = VerifyBody.parse(await c.req.json());
    return c.json(paste.verifyPaste(copyableRows(job.id), pastedText));
  });

  const downloadName = (name: string, extension: string) =>
    `${name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'business-cards'}.${extension}`;

  http.get('/api/jobs/:id/export.xlsx', async (c) => {
    const job = requireJob(c.req.param('id'));
    requireCountsChecked(job.id);
    const buffer = await toXlsx(copyableRows(job.id));
    return new Response(new Uint8Array(buffer), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${downloadName(job.name, 'xlsx')}"`,
      },
    });
  });

  http.get('/api/jobs/:id/export.csv', (c) => {
    const job = requireJob(c.req.param('id'));
    requireCountsChecked(job.id);
    return new Response(new Uint8Array(toCsv(copyableRows(job.id))), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${downloadName(job.name, 'csv')}"`,
      },
    });
  });

  if (options.staticDir) {
    const root = options.staticDir;
    http.use('/*', serveStatic({ root }));
    http.get('*', serveStatic({ root, path: 'index.html' }));
  }

  http.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status as 400);
    if (error instanceof z.ZodError) return c.json({ error: 'That request was not valid.', issues: error.issues }, 400);
    console.error(error);
    return c.json({ error: 'Something went wrong on this Mac. Check the terminal for details.' }, 500);
  });

  return {
    http,
    store,
    engine,
    async shutdown() {
      await engine.shutdown();
      store.close();
    },
  };
}
