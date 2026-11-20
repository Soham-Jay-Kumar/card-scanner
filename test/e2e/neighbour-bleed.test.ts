/**
 * Tight sheets leave part of a neighbouring card inside a crop. A read that picks up
 * a neighbour's email could do so in all three reads, which agreement cannot see.
 *
 * The rule: no card ever reaches Verified, or a copy or an export, holding another
 * person's email. Two defences must hold it, and each is tested alone:
 *  1. Vision masks other cards out of each crop's margin, so the text is never seen.
 *  2. A leak that gets into all three reads anyway is caught by shared_on_sheet.
 */
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONFIG } from '../../src/shared/config.ts';
import { MULTI_VALUE_SEPARATOR } from '../../src/shared/contracts.ts';
import type { Card } from '../../src/shared/contracts.ts';
import { decodeMarkers } from '../fake-openai/marker.ts';
import { startFakeOpenAI } from '../fake-openai/server.ts';
import type { FakeOpenAI } from '../fake-openai/server.ts';
import { installFakeDns, loadApp, startTestApp } from '../helpers/app.ts';
import type { FakeDns, TestApp } from '../helpers/app.ts';
import { sheetFile } from '../helpers/fixtures.ts';
import type { SheetFixture } from '../helpers/fixtures.ts';

const TIMEOUT = 15 * 60_000;
/** Wide enough that a whole neighbouring strip sits in the margin, with no card overlapping. */
const WIDE_MARGIN = 0.12;
const { createApp, skipReason } = await loadApp();

const rowOf = (card: Card) => card.finalRow ?? card.decision?.row ?? null;
const holdsLeak = (card: Card) => (rowOf(card)?.email ?? '').includes(MULTI_VALUE_SEPARATOR);
const emailsOf = (cards: Card[]) => cards.map((card) => rowOf(card)?.email);

describe.skipIf(!createApp)(`a neighbour's text in every read ${skipReason}`, () => {
  let dns: FakeDns;
  let fake: FakeOpenAI;
  let app: TestApp;
  const margin = CONFIG.image.cropMarginRatio;

  /** Runs the job, then an export, which is one of the moments the sheet check must run. */
  async function runSheet(sheet: SheetFixture) {
    fake.addCards(sheet.cards.map((card) => card.fake));
    const { job } = await app.runJob([sheet], undefined, TIMEOUT);
    const exported = await (await app.raw(`/api/jobs/${job.id}/export.csv`)).text();
    const cards = app.app.store.listCards(job.id).sort((p, q) => p.indexInSource - q.indexInSource);
    return { job, cards, exported };
  }

  beforeAll(async () => {
    dns = installFakeDns();
    fake = await startFakeOpenAI();
    app = await startTestApp(createApp!, { baseURL: fake.url });
  });
  afterAll(async () => {
    (CONFIG.image as { cropMarginRatio: number }).cropMarginRatio = margin;
    await app?.close();
    await fake?.close();
    dns?.restore();
  });

  it('overlapping cards: no card reaches Verified with a neighbour’s email', async () => {
    fake.configure({ neighbourBleed: true, misreads: [] });
    const sheet = await sheetFile(3460, 12, { layout: 'overlap', cardWidth: 900 });
    const { cards, exported } = await runSheet(sheet);
    expect(cards).toHaveLength(12);
    expect(emailsOf(cards.filter(holdsLeak).filter((card) => card.status === 'verified'))).toEqual([]);
    for (const card of cards.filter(holdsLeak)) expect(exported).not.toContain(rowOf(card)?.email);
  }, TIMEOUT);

  it('masking: a neighbour inside a crop’s margin is hidden, so its text can’t be read at all', async () => {
    (CONFIG.image as { cropMarginRatio: number }).cropMarginRatio = WIDE_MARGIN;
    fake.reset();
    fake.configure({ neighbourBleed: true });
    const sheet = await sheetFile(3472, 12, { layout: 'tight', cardWidth: 900 });

    // Proves the test can bite: without masking, this crop really does show the neighbour below.
    const upper = sheet.cards[0]!;
    const lower = sheet.cards.find((card) => card.place.box.y > upper.place.box.y + upper.place.box.height / 2 && Math.abs(card.place.box.x - upper.place.box.x) < 40)!;
    const { box } = upper.place;
    const unmasked = await sharp(sheet.bytes)
      .extract({ left: box.x, top: box.y, width: box.width, height: Math.ceil(box.height * (1 + WIDE_MARGIN)) })
      .jpeg({ quality: 92 })
      .toBuffer();
    expect((await decodeMarkers(unmasked)).map((marker) => marker.id)).toContain(lower.markerId);

    const { cards } = await runSheet(sheet);
    (CONFIG.image as { cropMarginRatio: number }).cropMarginRatio = margin;
    expect(cards).toHaveLength(12);
    expect(fake.stats().unidentifiedReads).toBe(0);
    expect(fake.stats().neighbourStripReads).toBe(0);
    expect(emailsOf(cards.filter(holdsLeak))).toEqual([]);
    expect(cards.map(rowOf)).toEqual(sheet.cards.map((card) => card.row));
  }, TIMEOUT);

  it('shared_on_sheet: a leak in all three reads stays out of Verified, copies and exports', async () => {
    fake.reset();
    const sheet = await sheetFile(3484, 6, { cardWidth: 900 });
    const [holder, owner] = sheet.cards as [SheetFixture['cards'][number], SheetFixture['cards'][number]];
    const leakedEmail = owner.row.email;
    fake.configure({ misreads: [{ cardIds: [holder.markerId], field: 'email', append: leakedEmail }] });

    const { job, cards, exported } = await runSheet(sheet);
    const leaked = cards.filter(holdsLeak);
    expect(leaked).toHaveLength(1);
    expect(emailsOf(leaked.filter((card) => card.status === 'verified'))).toEqual([]);
    expect(leaked[0]?.status).toBe('needs_review');
    expect(leaked[0]?.decision?.checks.filter((check) => !check.passed).map((check) => check.check)).toContain('shared_on_sheet');

    const copyable = app.copyable(job.id).map(({ row }) => row.email);
    expect(copyable.filter((email) => email.includes(MULTI_VALUE_SEPARATOR))).toEqual([]);
    expect(exported).not.toContain(`${holder.row.email}${MULTI_VALUE_SEPARATOR}${leakedEmail}`);
  }, TIMEOUT);
});
