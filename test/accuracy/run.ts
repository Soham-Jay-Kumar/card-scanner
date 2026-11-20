/**
 * Runs a card folder through the whole app and scores it against truth.
 *
 *   node test/accuracy/run.ts                                 synthetic set, fake server
 *   OPENAI_API_KEY=sk-... node test/accuracy/run.ts           synthetic set, live Luna
 *   OPENAI_API_KEY=sk-... node test/accuracy/run.ts --truth /path/to/real-cards/truth.json
 *
 * The key is the only switch. See test/accuracy/README.md.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { CardReadData } from '../../src/shared/contracts.ts';
import { startFakeOpenAI } from '../fake-openai/server.ts';
import type { FakeCard, FakeOpenAI, Noise } from '../fake-openai/server.ts';
import { installFakeDns, loadApp, startTestApp } from '../helpers/app.ts';
import type { TruthSet } from '../synth/truth.ts';
import { formatReport, scoreResults } from './score.ts';
import type { AccuracyReport } from './score.ts';

export const REPORT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.artifacts', 'accuracy');

export interface AccuracyOptions {
  truthPath: string;
  /** Live runs only: the real key. Without it the fake server answers. */
  apiKey?: string;
  noise?: Noise;
  seed?: number;
  defaultCountry?: string;
  timeoutMs?: number;
}

function fakeCards(truth: TruthSet): FakeCard[] {
  const cards: FakeCard[] = [];
  for (const file of truth.files) {
    for (const card of file.cards) {
      if (card.markerId === undefined || !card.read) {
        throw new Error(`${file.file} has no marker strip, so the fake server cannot read it. Hand-labelled cards need OPENAI_API_KEY.`);
      }
      cards.push({ id: card.markerId, aspect: card.aspect ?? 1.75, read: card.read as CardReadData });
    }
  }
  return cards;
}

export async function runAccuracy(options: AccuracyOptions): Promise<AccuracyReport> {
  const { truthPath, apiKey, noise, seed = 1, defaultCountry, timeoutMs = 3 * 60 * 60 * 1000 } = options;
  const { createApp, skipReason } = await loadApp();
  if (!createApp) throw new Error(skipReason);

  const truth = JSON.parse(await readFile(truthPath, 'utf8')) as TruthSet;
  const folder = dirname(truthPath);
  const live = Boolean(apiKey);

  // Checked first, so a folder the fake can't read leaves nothing patched.
  const known = live ? [] : fakeCards(truth);
  let fake: FakeOpenAI | null = null;
  const dns = live ? null : installFakeDns();
  if (!live) fake = await startFakeOpenAI({ cards: known, seed, noise: noise ?? null });
  const app = await startTestApp(createApp, live ? { apiKey: apiKey!, realRetries: true } : { baseURL: fake!.url });

  try {
    const job = await app.newJob({ name: 'accuracy', ...(defaultCountry ? { defaultCountry } : {}) });
    for (const file of truth.files) await app.upload(job.id, { name: file.file, bytes: await readFile(join(folder, file.file)) });
    await app.post(`/api/jobs/${job.id}/start`);
    const progress = await app.waitForStatus(job.id, ['done', 'paused', 'cancelled'], timeoutMs);
    if (progress.status !== 'done') throw new Error(`The job stopped as ${progress.status} (${progress.pauseReason}). Nothing was scored.`);

    const { store } = app.app;
    const files = store.listFiles(job.id);
    const nameOf = new Map(files.map((file) => [file.id, file.originalName]));
    const results = store.listCards(job.id).map((card) => ({
      file: nameOf.get(card.sourceFileIds[0] ?? '') ?? '',
      index: card.indexInSource,
      status: card.status,
      row: card.finalRow ?? card.decision?.row ?? null,
    }));
    return scoreResults({
      truth,
      files: files.map((file) => ({ file: file.originalName, stage: file.stage })),
      cards: results,
      reader: live ? 'live' : 'fake',
    });
  } finally {
    await app.close();
    await fake?.close();
    dns?.restore();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      truth: { type: 'string' },
      noise: { type: 'string' },
      correlated: { type: 'string' },
      seed: { type: 'string', default: '1' },
      country: { type: 'string' },
    },
  });
  let truthPath = values.truth;
  if (!truthPath) {
    const { generateSynthSet, SYNTH_TRUTH } = await import('../synth/generate.ts');
    await generateSynthSet();
    truthPath = SYNTH_TRUTH;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  console.log(apiKey ? 'OPENAI_API_KEY is set: using the live API. This costs money.' : 'No OPENAI_API_KEY: using the fake server.');
  const noise = values.noise ? { rate: Number(values.noise), correlatedRate: Number(values.correlated ?? 0) } : undefined;
  const report = await runAccuracy({
    truthPath: resolve(truthPath),
    ...(apiKey ? { apiKey } : {}),
    ...(noise ? { noise } : {}),
    seed: Number(values.seed),
    ...(values.country ? { defaultCountry: values.country } : {}),
  });
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(join(REPORT_DIR, `report-${report.reader}.json`), JSON.stringify(report, null, 2));
  const text = formatReport(report);
  await writeFile(join(REPORT_DIR, `report-${report.reader}.txt`), text);
  console.log(text);
}
