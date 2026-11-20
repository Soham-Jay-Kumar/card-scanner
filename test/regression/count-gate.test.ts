/**
 * A card missed by both locate passes can't be caught automatically, so for any
 * image with several cards a person must confirm the count before anything can
 * be copied or exported. This pins that gate, including the silent-loss case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFakeOpenAI } from '../fake-openai/server.ts';
import type { FakeOpenAI } from '../fake-openai/server.ts';
import { installFakeDns, loadApp, startTestApp } from '../helpers/app.ts';
import type { FakeDns, TestApp } from '../helpers/app.ts';
import { cardFile, sheetFile, testCard } from '../helpers/fixtures.ts';

const { createApp, skipReason } = await loadApp();

const exportStatus = async (app: TestApp, jobId: string) => (await app.raw(`/api/jobs/${jobId}/export.xlsx`)).status;

describe.skipIf(!createApp)(`card count gate ${skipReason}`, () => {
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

  it('a sheet missed by both passes blocks export until a person checks it, and adding the card re-opens the check', async () => {
    const sheet = await sheetFile(3470, 6, { cardWidth: 900 });
    fake.addCards(sheet.cards.map((card) => card.fake));
    const lost = sheet.cards[3]!.markerId;
    fake.configure({ locate: [{ missInPass1: [lost], missInPass2: [lost] }] });

    const { job } = await app.runJob([sheet], undefined, 10 * 60_000);
    const [file] = await app.files(job.id);
    // Both passes agreed, so nothing automatic flags it: only the person can.
    expect(file!.locate?.countConfirmed).toBe(true);
    expect(file!.locate?.locations).toHaveLength(5);

    expect(await exportStatus(app, job.id)).toBe(409);
    const copy = await app.raw(`/api/jobs/${job.id}/copy`, {
      method: 'POST',
      body: JSON.stringify({ includeHeader: true }),
      headers: { 'content-type': 'application/json' },
    });
    expect(copy.status).toBe(409);
    expect((await copy.json()).error).toMatch(/Photos tab/);

    // The person spots the gap and adds the card: the count must be confirmed again.
    const { box } = sheet.cards[3]!.place;
    const scale = (file!.normalized?.width ?? sheet.width) / sheet.width;
    await app.post(`/api/files/${file!.id}/cards`, {
      box: {
        x: Math.round(box.x * scale),
        y: Math.round(box.y * scale),
        width: Math.round(box.width * scale),
        height: Math.round(box.height * scale),
      },
      rotation: 0,
    });
    await app.waitForStatus(job.id, ['done'], 5 * 60_000);
    expect(await exportStatus(app, job.id)).toBe(409);

    await app.post(`/api/files/${file!.id}/confirm-count`);
    expect(await exportStatus(app, job.id)).toBe(200);
    expect(await app.reconciliation(job.id)).toMatchObject({ cards: 6, balanced: true });
  }, 15 * 60_000);

  it('single-card images need no count check', async () => {
    const card = testCard(3480);
    fake.addCards([card.fake]);
    fake.configure({ locate: [] });
    const { job } = await app.runJob([await cardFile(card)], undefined, 5 * 60_000);
    expect(await exportStatus(app, job.id)).toBe(200);
  }, 10 * 60_000);
});
