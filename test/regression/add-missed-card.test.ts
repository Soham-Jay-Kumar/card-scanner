/**
 * The safety net for a card missed by both locate passes: a person spots it on the
 * Photos screen and draws a box round it. That usually happens after the job has
 * finished, so that is the case tested.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SourceFile } from '../../src/shared/contracts.ts';
import { startFakeOpenAI } from '../fake-openai/server.ts';
import type { FakeOpenAI } from '../fake-openai/server.ts';
import { installFakeDns, loadApp, startTestApp } from '../helpers/app.ts';
import type { FakeDns, TestApp } from '../helpers/app.ts';
import { sheetFile } from '../helpers/fixtures.ts';
import type { SheetFixture } from '../helpers/fixtures.ts';

const { createApp, skipReason } = await loadApp();

describe.skipIf(!createApp)(`adding a missed card ${skipReason}`, () => {
  let fake: FakeOpenAI;
  let dns: FakeDns;
  let app: TestApp;
  let sheet: SheetFixture;
  let jobId: string;
  let file: SourceFile;
  const size = 4;

  beforeAll(async () => {
    dns = installFakeDns();
    fake = await startFakeOpenAI();
    app = await startTestApp(createApp!, { baseURL: fake.url });
    sheet = await sheetFile(3430, size, { cardWidth: 900 });
    fake.addCards(sheet.cards.map((card) => card.fake));
    const lost = sheet.cards[2]!.markerId;
    fake.configure({ locate: [{ missInPass1: [lost], missInPass2: [lost] }] });
    const { job } = await app.runJob([sheet], undefined, 10 * 60_000);
    jobId = job.id;
    file = (await app.files(jobId))[0]!;
  }, 10 * 60_000);
  afterAll(async () => {
    await app?.close();
    await fake?.close();
    dns?.restore();
  });

  it('starts one card short, with the job done', async () => {
    expect((await app.cards(jobId)).length).toBe(size - 1);
    expect((await app.api<{ status: string }>(`/api/jobs/${jobId}/progress`)).status).toBe('done');
  });

  it('confirm-count records that a person checked the file', async () => {
    const updated = await app.post<SourceFile>(`/api/files/${file.id}/confirm-count`);
    expect(updated.locate?.countConfirmed).toBe(true);
  });

  it('a card added after the job finished gets read and arrives with the right row', async () => {
    const missing = sheet.cards[2]!;
    const added = await app.post<{ id: string }>(`/api/files/${file.id}/cards`, { box: missing.place.box, rotation: 0 });
    const deadline = Date.now() + 120_000;
    let status = 'pending';
    while (status === 'pending' && Date.now() < deadline) {
      status = (await app.cardDetail(added.id)).card.status;
      await new Promise((done) => setTimeout(done, 100));
    }
    const { card } = await app.cardDetail(added.id);
    expect(card.status).toBe('verified');
    expect(card.finalRow).toEqual(missing.row);
    expect(app.copyable(jobId).map(({ row }) => row.email)).toContain(missing.row.email);
    const count = await app.reconciliation(jobId);
    expect(count).toMatchObject({ cards: size, cardsInProgress: 0, balanced: true });
  }, 150_000);
});
