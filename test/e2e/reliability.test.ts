/**
 * Injected failures, pause and resume, and a real SIGKILL mid-job. A small job by
 * default. RUN_1000_CARDS=1 runs the plan's full 1,000-card job.
 *
 * Retry delays are shortened here. Honouring Retry-After is still real, because the
 * client's waits for it come from the header.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONFIG } from '../../src/shared/config.ts';
import { startFakeOpenAI } from '../fake-openai/server.ts';
import type { FakeOpenAI, FaultRule } from '../fake-openai/server.ts';
import { installFakeDns, loadApp, spawnJobChild, startTestApp, tempDataDir, THOUSAND_CARDS } from '../helpers/app.ts';
import type { FakeDns, TestApp, UploadItem } from '../helpers/app.ts';
import { cardFile, testCard } from '../helpers/fixtures.ts';
import type { TestCard } from '../helpers/fixtures.ts';

const JOB_CARDS = THOUSAND_CARDS ? 1_000 : 14;
const TIMEOUT = THOUSAND_CARDS ? 90 * 60_000 : 15 * 60_000;
const BASE_ID = 2000;
const { createApp, skipReason } = await loadApp();

const CHAOS: FaultRule[] = [
  { fault: 'slow_down', rate: 0.03, retryAfterSeconds: 1 },
  { fault: 'server_500', rate: 0.03 },
  { fault: 'overloaded_503', rate: 0.02, retryAfterSeconds: 1 },
  { fault: 'connection_reset', rate: 0.02 },
  { fault: 'malformed_json', rate: 0.02 },
  { fault: 'malformed_output', rate: 0.02 },
  { fault: 'wrong_schema', rate: 0.02 },
  { fault: 'refusal', rate: 0.02 },
  { fault: 'incomplete', rate: 0.02 },
  { fault: 'response_failed', rate: 0.01 },
  { fault: 'hang', rate: 0.01 },
];

async function makeCards(count: number, firstId: number): Promise<{ cards: TestCard[]; items: UploadItem[] }> {
  const cards = Array.from({ length: count }, (_, index) => testCard(firstId + index));
  const items: UploadItem[] = [];
  for (const card of cards) items.push(await cardFile(card, [], 900));
  return { cards, items };
}

describe.skipIf(!createApp)(`reliability ${skipReason}`, () => {
  let dns: FakeDns;
  beforeAll(() => {
    dns = installFakeDns();
  });
  afterAll(() => dns?.restore());

  describe('a stream of injected failures', () => {
    let fake: FakeOpenAI;
    let app: TestApp;
    let jobId: string;
    let cards: TestCard[];
    const doomed = 2 + BASE_ID;

    beforeAll(async () => {
      fake = await startFakeOpenAI({ seed: 5 });
      app = await startTestApp(createApp!, { baseURL: fake.url, requestTimeoutMs: 8_000 });
      const made = await makeCards(10, BASE_ID);
      cards = made.cards;
      fake.addCards(cards.map((card) => card.fake));
      // Earlier rules win, so this card's reads fail on every attempt and the rest see the mix.
      fake.configure({ faults: [{ fault: 'refusal', purpose: 'read', cardIds: [doomed] }, ...CHAOS] });
      const { job } = await app.runJob(made.items, undefined, TIMEOUT);
      jobId = job.id;
    }, TIMEOUT);
    afterAll(async () => {
      await app?.close();
      await fake?.close();
    });

    it('loses no card and stays balanced', async () => {
      const count = await app.reconciliation(jobId);
      expect(count).toMatchObject({ cards: 10, cardsInProgress: 0, filesInProgress: 0, balanced: true });
      expect((await app.api<{ status: string }>(`/api/jobs/${jobId}/progress`)).status).toBe('done');
    });

    it('never turns a failure into a value', async () => {
      for (const summary of await app.cards(jobId)) {
        const expected = cards.find((card) => summary.sourceName === `card-${card.markerId}.jpg`)!;
        if (summary.status === 'verified') expect(summary.row).toEqual(expected.row);
      }
    });

    it('sends a card whose reads keep being refused to a person, not to Verified', async () => {
      const summary = (await app.cards(jobId)).find((card) => card.sourceName === `card-${doomed}.jpg`)!;
      expect(summary.status).toBe('needs_review');
    });

    it('waits at least as long as Retry-After says', () => {
      const { log } = fake.stats();
      const limited = log.filter((entry) => entry.fault === 'slow_down' || entry.fault === 'overloaded_503');
      expect(limited.length).toBeGreaterThan(0);
      for (const entry of limited) {
        const next = log.find((later) => later.seq > entry.seq && later.purpose === entry.purpose && later.cards.join() === entry.cards.join() && later.pass === entry.pass);
        if (next) expect(next.receivedAt - entry.finishedAt!).toBeGreaterThanOrEqual(950);
      }
    });

    it('keeps to the concurrency limits and sends only valid requests', () => {
      expect(fake.stats().inFlightPeak).toBeLessThanOrEqual(CONFIG.concurrency.max);
      expect(fake.stats().violations).toEqual([]);
    });

    it('records spend equal to what the API billed', () => {
      expect(app.app.store.getJobSpendUsd(jobId)).toBeCloseTo(fake.stats().billed.costUsd, 9);
    });
  });

  describe('problems retrying cannot fix', () => {
    const cases = [
      { label: 'out of credit', fault: 'quota', reason: 'out_of_credit', firstId: 2100 },
      { label: 'a bad API key', fault: 'bad_key', reason: 'bad_api_key', firstId: 2120 },
    ] as const;

    for (const { label, fault, reason, firstId } of cases) {
      it(`${label} pauses the job, and Resume finishes it with no read repeated`, async () => {
        const fake = await startFakeOpenAI();
        const app = await startTestApp(createApp!, { baseURL: fake.url });
        const { cards, items } = await makeCards(6, firstId);
        fake.addCards(cards.map((card) => card.fake));

        // Allows the locates and some reads through, then everything fails.
        fake.configure({ outage: { fault, afterRequests: 18 } });
        const { job, progress } = await app.runJob(items, undefined, TIMEOUT);
        expect(progress.status).toBe('paused');
        expect(progress.pauseReason).toBe(reason);
        const before = fake.stats().log.length;
        const savedBefore = new Map(app.app.store.listCards(job.id).map((card) => [card.id, app.app.store.listReads(card.id).length]));

        fake.clearOutage();
        await app.post(`/api/jobs/${job.id}/resume`);
        const finished = await app.waitForStatus(job.id, ['done', 'paused'], TIMEOUT);
        expect(finished.status).toBe('done');
        expect(finished.reconciliation).toMatchObject({ cards: 6, verified: 6, balanced: true });

        const afterResume = fake.stats().log.slice(before).filter((entry) => entry.delivered && entry.purpose.startsWith('read')).length;
        const stillNeeded = 18 - [...savedBefore.values()].reduce((sum, saved) => sum + saved, 0);
        expect(afterResume).toBeLessThanOrEqual(stillNeeded);
        await app.close();
        await fake.close();
      }, TIMEOUT);
    }

    it('the cost cap pauses the job rather than overspending', async () => {
      const fake = await startFakeOpenAI();
      const app = await startTestApp(createApp!, { baseURL: fake.url });
      const { cards, items } = await makeCards(4, 2140);
      fake.addCards(cards.map((card) => card.fake));
      const { progress, job } = await app.runJob(items, { costCapUsd: 0.001 }, TIMEOUT);
      expect(progress.status).toBe('paused');
      expect(progress.pauseReason).toBe('cost_cap');
      expect((await app.reconciliation(job.id)).balanced).toBe(true);
      await app.close();
      await fake.close();
    }, TIMEOUT);

    it('raising the cap after a cost_cap pause lets Resume finish the job', async () => {
      const fake = await startFakeOpenAI();
      const app = await startTestApp(createApp!, { baseURL: fake.url });
      const { cards, items } = await makeCards(4, 2150);
      fake.addCards(cards.map((card) => card.fake));
      const { job, progress } = await app.runJob(items, { costCapUsd: 0.001 }, TIMEOUT);
      expect(progress.pauseReason).toBe('cost_cap');

      const spent = app.app.store.getJobSpendUsd(job.id);
      const tooLow = await app.raw(`/api/jobs/${job.id}/cost-cap`, { method: 'POST', body: JSON.stringify({ costCapUsd: spent }), headers: { 'content-type': 'application/json' } });
      expect(tooLow.status).toBe(400);

      await app.post(`/api/jobs/${job.id}/cost-cap`, { costCapUsd: 1 });
      await app.post(`/api/jobs/${job.id}/resume`);
      const finished = await app.waitForStatus(job.id, ['done', 'paused'], TIMEOUT);
      expect(finished.status).toBe('done');
      expect(finished.reconciliation).toMatchObject({ cards: 4, verified: 4, balanced: true });
      expect(app.app.store.getJobSpendUsd(job.id)).toBeCloseTo(fake.stats().billed.costUsd, 9);
      await app.close();
      await fake.close();
    }, TIMEOUT);
  });

  describe(`a real SIGKILL partway through a ${JOB_CARDS}-card job`, () => {
    it('loses nothing, repeats no finished read and tracks cost', async () => {
      const fake = await startFakeOpenAI({ seed: 9 });
      const dataDir = await tempDataDir();
      const { cards, items } = await makeCards(JOB_CARDS, BASE_ID + 200);
      fake.addCards(cards.map((card) => card.fake));
      fake.configure({ faults: CHAOS.filter((rule) => rule.fault !== 'hang') });

      const setup = await startTestApp(createApp!, { baseURL: fake.url, dataDir, keepData: true });
      const job = await setup.newJob({ name: 'kill test' });
      for (const item of items) await setup.upload(job.id, item);
      await setup.close();

      const first = spawnJobChild({ dataDir, baseURL: fake.url, jobId: job.id, flags: ['--start'] });
      const deliveredReads = () => fake.stats().log.filter((entry) => entry.delivered && entry.purpose.startsWith('read')).length;
      const killAt = Math.floor(JOB_CARDS * 1.2);
      const deadline = Date.now() + TIMEOUT;
      while (deliveredReads() < killAt && first.process.exitCode === null && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 20));
      }
      expect(first.process.kill('SIGKILL')).toBe(true);
      const firstEnd = await first.ended;
      expect(firstEnd.signal).toBe('SIGKILL');

      // What was truly saved at the moment of the kill.
      const checkpoint = await startTestApp(createApp!, { baseURL: fake.url, dataDir, keepData: true });
      const { store } = checkpoint.app;
      const nameOf = new Map(store.listFiles(job.id).map((file) => [file.id, file.originalName]));
      const markerOf = (fileId: string | undefined) => Number(/card-(\d+)/.exec(nameOf.get(fileId ?? '') ?? '')?.[1]);
      const savedReads = new Map<number, number>();
      for (const card of store.listCards(job.id)) savedReads.set(markerOf(card.sourceFileIds[0]), store.listReads(card.id).length);
      const unfinished = JOB_CARDS * 3 - [...savedReads.values()].reduce((sum, count) => sum + count, 0);
      await checkpoint.app.shutdown();
      expect(unfinished).toBeGreaterThan(0);
      const mark = fake.stats().log.length;

      const second = spawnJobChild({ dataDir, baseURL: fake.url, jobId: job.id, flags: ['--recover'] });
      const secondEnd = await second.ended;
      expect(secondEnd.code, secondEnd.output.slice(-800)).toBe(0);

      const final = await startTestApp(createApp!, { baseURL: fake.url, dataDir });
      const count = final.app.store.getReconciliation(job.id);
      expect(count).toMatchObject({ files: JOB_CARDS, cards: JOB_CARDS, cardsInProgress: 0, filesInProgress: 0, failedCards: 0, balanced: true });
      expect(final.app.store.getJob(job.id)?.status).toBe('done');

      const afterRestart = new Map<number, number>();
      for (const entry of fake.stats().log.slice(mark)) {
        if (entry.delivered && entry.purpose.startsWith('read')) afterRestart.set(entry.cards[0]!, (afterRestart.get(entry.cards[0]!) ?? 0) + 1);
      }
      for (const [marker, count] of afterRestart) {
        expect(count, `card ${marker} re-read a finished read`).toBeLessThanOrEqual(3 - (savedReads.get(marker) ?? 0));
      }

      // Replies that reached the killed process and never got saved are the only allowed gap.
      const spend = final.app.store.getJobSpendUsd(job.id);
      const { billed } = fake.stats();
      const perCall = billed.costUsd / billed.responses;
      expect(spend).toBeLessThanOrEqual(billed.costUsd + 1e-9);
      expect(billed.costUsd - spend).toBeLessThanOrEqual(perCall * (CONFIG.concurrency.max + 1));

      for (const row of final.app.store.getCopyableRows(job.id)) {
        expect(cards.some((card) => card.row.email === row.row.email && card.row.phone === row.row.phone)).toBe(true);
      }
      await final.close();
      await fake.close();
    }, TIMEOUT);
  });
});
