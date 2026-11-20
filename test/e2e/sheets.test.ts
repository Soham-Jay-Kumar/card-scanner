/**
 * One image holding many cards. Each scenario is its own file in a shared job,
 * because fake rules apply per card. Sheets hold 6 cards by default for speed, and
 * 36 with RUN_FULL_SYNTH=1. The logic under test is the same at either size.
 *
 * Top reliability risk: a card missed by BOTH locate passes. The findings are
 * written to test/.artifacts/both-pass-miss.json and pinned as tests.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Card, CardRow, SourceFile } from '../../src/shared/contracts.ts';
import { startFakeOpenAI } from '../fake-openai/server.ts';
import type { FakeOpenAI, LocateRule } from '../fake-openai/server.ts';
import { FULL_SYNTH, installFakeDns, loadApp, spawnJobChild, startTestApp, tempDataDir } from '../helpers/app.ts';
import type { FakeDns, TestApp, UploadItem } from '../helpers/app.ts';
import { cardFile, sheetFile, testCard } from '../helpers/fixtures.ts';
import type { SheetFixture } from '../helpers/fixtures.ts';
import type { SheetLayout } from '../synth/sheets.ts';

const ARTIFACTS = resolve(import.meta.dirname, '..', '.artifacts');
const SIZE = FULL_SYNTH ? 36 : 6;
const CARD_WIDTH = 900;
const HOOK_TIMEOUT = 30 * 60_000;
const { createApp, skipReason } = await loadApp();

describe.skipIf(!createApp)(`sheets of ${SIZE} cards ${skipReason}`, () => {
  let fake: FakeOpenAI;
  let dns: FakeDns;
  let app: TestApp;
  let jobId: string;
  let files: SourceFile[];
  let cards: Card[];

  const fixtures = new Map<string, SheetFixture>();
  let singleBefore: UploadItem;
  let singleAfter: UploadItem;
  const singleA = testCard(3498);
  const singleB = testCard(3499);

  const ids = (name: string) => fixtures.get(name)!.cards.map((card) => card.markerId);
  const fileOf = (name: string) => files.find((file) => file.originalName === `${name}.jpg`)!;
  const cardsOf = (name: string) => cards.filter((card) => card.sourceFileIds.includes(fileOf(name).id)).sort((p, q) => p.indexInSource - q.indexInSource);
  const rowOf = (card: Card): CardRow | null => card.finalRow ?? card.decision?.row ?? null;

  beforeAll(async () => {
    dns = installFakeDns();
    fake = await startFakeOpenAI();
    app = await startTestApp(createApp!, { baseURL: fake.url });

    const plans: Array<[string, { layout?: SheetLayout; cardWidth?: number }]> = [
      ['clean', {}],
      ['missed-by-pass-1', {}],
      ['missed-by-pass-2', {}],
      ['missed-by-both', {}],
      ['pass-2-fails', {}],
      ['counts-differ', {}],
      ['low-res-sharp', { cardWidth: 300 }],
      ['fallback', {}],
      ['mixed-rotation', { layout: 'mixed_rotation' }],
      ['uneven', { layout: 'uneven' }],
      ['overlap', { layout: 'overlap' }],
    ];
    for (const [index, [name, options]] of plans.entries()) {
      const sheet = await sheetFile(3500 + index * 50, SIZE, { cardWidth: CARD_WIDTH, seed: index + 2, ...options });
      fixtures.set(name, { ...sheet, name: `${name}.jpg` });
      fake.addCards(sheet.cards.map((card) => card.fake));
    }
    fake.addCards([singleA.fake, singleB.fake]);
    singleBefore = { ...(await cardFile(singleA)), name: 'single-before.jpg' };
    singleAfter = { ...(await cardFile(singleB)), name: 'single-after.jpg' };

    const middle = SIZE >> 1;
    const rule = (name: string, patch: Omit<LocateRule, 'cardIds'>): LocateRule => ({ cardIds: ids(name), ...patch });
    const fail = (pass: 1 | 2) => ({ pass, fault: 'server_500' as const });
    fake.configure({
      locate: [
        rule('missed-by-pass-1', { missInPass1: [ids('missed-by-pass-1')[middle]!] }),
        rule('missed-by-pass-2', { missInPass2: [ids('missed-by-pass-2')[middle]!] }),
        rule('missed-by-both', { missInPass1: [ids('missed-by-both')[middle]!], missInPass2: [ids('missed-by-both')[middle]!] }),
        rule('pass-2-fails', { failPass: fail(2) }),
        rule('counts-differ', { missInPass1: ids('counts-differ').slice(0, 2), missInPass2: [ids('counts-differ')[3]!] }),
        rule('fallback', { failPass: fail(1) }),
        rule('fallback', { failPass: fail(2) }),
      ],
    });

    const job = await app.newJob({ name: 'sheets' });
    jobId = job.id;
    await app.upload(jobId, singleBefore);
    for (const name of fixtures.keys()) await app.upload(jobId, fixtures.get(name)!);
    await app.upload(jobId, singleAfter);
    await app.post(`/api/jobs/${jobId}/start`);
    await app.waitForStatus(jobId, ['done', 'paused'], HOOK_TIMEOUT);
    files = await app.files(jobId);
    cards = app.app.store.listCards(jobId);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await app?.close();
    await fake?.close();
    dns?.restore();
  });

  it('finishes balanced, with no read image unidentified', async () => {
    const count = await app.reconciliation(jobId);
    expect(count.balanced).toBe(true);
    expect(count.cardsInProgress).toBe(0);
    expect(count.failedCards).toBe(0);
    expect(count.failedFiles).toBe(0);
    expect(fake.stats().unidentifiedReads).toBe(0);
    expect(fake.stats().violations).toEqual([]);
  });

  it('a clean sheet: no card lost, rows in reading order, count confirmed', () => {
    const fixture = fixtures.get('clean')!;
    expect(cardsOf('clean').map(rowOf)).toEqual(fixture.cards.map((card) => card.row));
    expect(cardsOf('clean').every((card) => card.status === 'verified')).toBe(true);
    expect(fileOf('clean').locate?.countConfirmed).toBe(true);
  });

  it('the job mixes 1-card and many-card files, in upload then reading order', () => {
    const rows = app.copyable(jobId).map(({ row }) => row.email);
    expect(rows[0]).toBe(singleA.row.email);
    expect(rows.at(-1)).toBe(singleB.row.email);
    const cleanRows = fixtures.get('clean')!.cards.map((card) => card.row.email);
    expect(rows.slice(1, 1 + cleanRows.length)).toEqual(cleanRows);
  });

  for (const name of ['missed-by-pass-1', 'missed-by-pass-2']) {
    it(`${name}: the card still arrives, in order, and the count is left unconfirmed`, () => {
      const fixture = fixtures.get(name)!;
      expect(cardsOf(name).map(rowOf)).toEqual(fixture.cards.map((card) => card.row));
      expect(fileOf(name).locate?.countConfirmed).toBe(false);
      expect(fileOf(name).locate?.note).toMatch(/differ/i);
    });
  }

  it('counts differ between passes: the union survives and the count stays unconfirmed', () => {
    expect(cardsOf('counts-differ').map(rowOf)).toEqual(fixtures.get('counts-differ')!.cards.map((card) => card.row));
    expect(fileOf('counts-differ').locate?.countConfirmed).toBe(false);
  });

  it('one pass fails: the other pass’s cards are kept and the count stays unconfirmed', () => {
    expect(cardsOf('pass-2-fails').map(rowOf)).toEqual(fixtures.get('pass-2-fails')!.cards.map((card) => card.row));
    expect(fileOf('pass-2-fails').locate?.countConfirmed).toBe(false);
  });

  it('an unconfirmed count reaches the API, so the Photos screen can show it', async () => {
    const listed = await app.files(jobId);
    const unconfirmed = listed.filter((file) => file.locate && !file.locate.countConfirmed).map((file) => file.originalName);
    expect(unconfirmed).toEqual(expect.arrayContaining(['missed-by-pass-1.jpg', 'missed-by-pass-2.jpg', 'pass-2-fails.jpg', 'counts-differ.jpg', 'fallback.jpg']));
    expect(unconfirmed).not.toContain('clean.jpg');
  });

  it('low-resolution cards from a sharp photo all go to review, none verified', () => {
    const found = cardsOf('low-res-sharp');
    expect(found).toHaveLength(SIZE);
    expect(found.map((card) => card.status)).toEqual(found.map(() => 'needs_review'));
    for (const card of found) expect(card.crops[0]?.quality.issues).toContain('low_resolution');
  });

  it('a full-image fallback on a sheet goes to review and never gives a verified row', () => {
    const found = cardsOf('fallback');
    expect(fileOf('fallback').locate).toMatchObject({ fellBackToFullImage: true, countConfirmed: false });
    expect(found).toHaveLength(1);
    expect(found[0]?.status).toBe('needs_review');
    expect(found[0]?.finalRow).toBeNull();
    expect(found[0]?.crops[0]?.quality.issues).toContain('location_uncertain');
    expect(fake.stats().multiCardReads).toBeGreaterThan(0);
  });

  for (const name of ['mixed-rotation', 'uneven', 'overlap']) {
    it(`${name}: every card found, in reading order, turned upright`, () => {
      expect(cardsOf(name).map(rowOf)).toEqual(fixtures.get(name)!.cards.map((card) => card.row));
      expect(fake.stats().notUprightReads).toBe(0);
    });
  }

  /**
   * TOP RELIABILITY RISK. Two passes that miss the same card agree with each other,
   * so the passes alone cannot tell a card is gone. The pixel check can: the missed
   * card's outline sits right beside the boxes of its neighbours, so those boxes look
   * cut short. The card is still not found, but the count is no longer confirmed, so
   * a person checks the sheet. These tests pin what really happens today.
   */
  describe('a card missed by BOTH passes', () => {
    it('is still lost, but the pixel check leaves the count unconfirmed for a person', async () => {
      const fixture = fixtures.get('missed-by-both')!;
      const missing = fixture.cards[SIZE >> 1]!;
      const found = cardsOf('missed-by-both');
      const file = fileOf('missed-by-both');
      const count = await app.reconciliation(jobId);

      await mkdir(ARTIFACTS, { recursive: true });
      await writeFile(
        join(ARTIFACTS, 'both-pass-miss.json'),
        JSON.stringify(
          {
            onSheet: SIZE,
            rowsProduced: found.length,
            lostCard: missing.row,
            countConfirmed: file.locate?.countConfirmed,
            note: file.locate?.note,
            fileStage: file.stage,
            reconciliationBalanced: count.balanced,
            anythingFlaggedTheLoss: file.locate?.countConfirmed === false,
          },
          null,
          2,
        ),
      );

      expect(found.map(rowOf)).toEqual(fixture.cards.filter((card) => card !== missing).map((card) => card.row));
      expect(file.locate?.countConfirmed).toBe(false);
      expect(file.locate?.note).toMatch(/did not match the pixels/);
      expect(file.stage).toBe('cropped');
      expect(count.balanced).toBe(true);
    });
  });
});

/** A hard crash between two cards of one sheet. The child kills itself at an exact point. */
describe.skipIf(!createApp)('crash partway through creating cards from a sheet', () => {
  it('resumes with every card exactly once, in order, and pays for no second locate', async () => {
    const dns = installFakeDns();
    const fake = await startFakeOpenAI();
    const dataDir = await tempDataDir();
    const sheet = await sheetFile(3450, SIZE, { cardWidth: CARD_WIDTH });
    fake.addCards(sheet.cards.map((card) => card.fake));

    const setup = await startTestApp(createApp!, { baseURL: fake.url, dataDir, keepData: true });
    const job = await setup.newJob({ name: 'crash' });
    await setup.upload(job.id, sheet);
    await setup.close();

    const killAt = Math.max(2, SIZE >> 1);
    const first = spawnJobChild({ dataDir, baseURL: fake.url, jobId: job.id, flags: ['--start', '--kill-after-cards', String(killAt)] });
    const firstEnd = await first.ended;
    expect(firstEnd.signal, firstEnd.output.slice(-800)).toBe('SIGKILL');

    const partway = await startTestApp(createApp!, { baseURL: fake.url, dataDir, keepData: true });
    const stranded = partway.app.store.listCards(job.id);
    const stage = partway.app.store.listFiles(job.id)[0]?.stage;
    await partway.app.shutdown();
    expect(stranded).toHaveLength(killAt);
    expect(stage).toBe('located');
    const locatesBefore = fake.stats().log.filter((entry) => entry.purpose === 'locate' && entry.delivered).length;

    const second = spawnJobChild({ dataDir, baseURL: fake.url, jobId: job.id, flags: ['--recover'] });
    const secondEnd = await second.ended;
    expect(secondEnd.code, secondEnd.output.slice(-800)).toBe(0);

    const final = await startTestApp(createApp!, { baseURL: fake.url, dataDir });
    const cards = final.app.store.listCards(job.id).sort((p, q) => p.indexInSource - q.indexInSource);
    expect(cards.map((card) => card.indexInSource)).toEqual(Array.from({ length: SIZE }, (_, index) => index));
    expect(cards.map((card) => card.finalRow)).toEqual(sheet.cards.map((card) => card.row));
    expect(final.app.store.getReconciliation(job.id).balanced).toBe(true);
    expect(fake.stats().log.filter((entry) => entry.purpose === 'locate' && entry.delivered)).toHaveLength(locatesBefore);
    await final.close();
    await fake.close();
    dns.restore();
  }, HOOK_TIMEOUT);
});
