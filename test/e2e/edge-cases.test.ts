/** Job sizes and shapes at the limits, through the real HTTP API. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONFIG } from '../../src/shared/config.ts';
import { startFakeOpenAI } from '../fake-openai/server.ts';
import type { FakeOpenAI } from '../fake-openai/server.ts';
import { installFakeDns, loadApp, startTestApp, THOUSAND_CARDS } from '../helpers/app.ts';
import type { FakeDns, TestApp } from '../helpers/app.ts';
import { cardFile, testCard } from '../helpers/fixtures.ts';

const TIMEOUT = 10 * 60_000;
const { createApp, skipReason } = await loadApp();

describe.skipIf(!createApp)(`edge cases ${skipReason}`, () => {
  let fake: FakeOpenAI;
  let dns: FakeDns;
  let app: TestApp;

  beforeAll(async () => {
    dns = installFakeDns();
    fake = await startFakeOpenAI();
    app = await startTestApp(createApp!, { baseURL: fake.url });
  });
  afterAll(async () => {
    await app?.close();
    await fake?.close();
    dns?.restore();
  });

  it('an empty job refuses to start, with a plain message', async () => {
    const job = await app.newJob();
    const response = await app.raw(`/api/jobs/${job.id}/start`, { method: 'POST' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'This job has no files yet.' });
  });

  it('all duplicates: one card, the rest accounted for as duplicates', async () => {
    const card = testCard(3410);
    fake.addCards([card.fake]);
    const file = await cardFile(card);
    const items = Array.from({ length: 4 }, (_, index) => ({ ...file, name: `copy-${index}.jpg` }));
    const { job, progress } = await app.runJob(items, undefined, TIMEOUT);
    expect(progress.status).toBe('done');
    expect(progress.reconciliation).toMatchObject({ files: 4, duplicateFiles: 3, cards: 1, verified: 1, balanced: true });
    const files = await app.files(job.id);
    expect(files.filter((item) => item.stage === 'duplicate').every((item) => item.duplicateOfFileId === files[0]?.id)).toBe(true);
  }, TIMEOUT);

  it('all corrupt: every file listed as failed, nothing lost, and no model call wasted', async () => {
    const before = fake.stats().requests;
    const items = Array.from({ length: 3 }, (_, index) => ({ name: `bad-${index}.jpg`, bytes: Buffer.from(`not an image ${index}`) }));
    const { job, progress } = await app.runJob(items, undefined, TIMEOUT);
    expect(progress.status).toBe('done');
    expect(progress.reconciliation).toMatchObject({ files: 3, failedFiles: 3, cards: 0, balanced: true });
    expect((await app.files(job.id)).every((file) => file.error)).toBe(true);
    expect(fake.stats().requests).toBe(before);
  }, TIMEOUT);

  it('a single card', async () => {
    const card = testCard(3411);
    fake.addCards([card.fake]);
    const { job, progress } = await app.runJob([await cardFile(card)], undefined, TIMEOUT);
    expect(progress.reconciliation).toMatchObject({ files: 1, cards: 1, verified: 1, balanced: true });
    expect(app.copyable(job.id).map(({ row }) => row)).toEqual([card.row]);
  }, TIMEOUT);

  it('an upload with no content is refused', async () => {
    const job = await app.newJob();
    const response = await app.raw(`/api/jobs/${job.id}/files`, { method: 'POST', body: new Uint8Array(0), headers: { 'x-file-name': 'empty.jpg' } });
    expect(response.status).toBe(400);
  });

  it('takes exactly 1,000 files and turns down the 1,001st with a clear message', async () => {
    const job = await app.newJob();
    const limit = CONFIG.job.maxCardsPerJob;
    for (let index = 0; index < limit; index += 1) {
      await app.upload(job.id, { name: `f${index}.jpg`, bytes: Buffer.from(`file ${index}`) });
    }
    expect(await app.files(job.id)).toHaveLength(limit);
    const response = await app.raw(`/api/jobs/${job.id}/files`, {
      method: 'POST',
      body: new Uint8Array(Buffer.from('one too many')),
      headers: { 'x-file-name': 'f1000.jpg' },
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toMatch(/1000 files/);
    expect(await app.files(job.id)).toHaveLength(limit);
  }, TIMEOUT);

  it.runIf(THOUSAND_CARDS)('runs exactly 1,000 real cards to the end', async () => {
    const cards = Array.from({ length: 1_000 }, (_, index) => testCard(2000 + index));
    fake.addCards(cards.map((card) => card.fake));
    const items = [];
    for (const card of cards) items.push(await cardFile(card, [], 900));
    const { progress } = await app.runJob(items, undefined, 90 * 60_000);
    expect(progress.status).toBe('done');
    expect(progress.reconciliation).toMatchObject({ files: 1_000, cards: 1_000, verified: 1_000, cardsInProgress: 0, balanced: true });
  }, 95 * 60_000);
});
