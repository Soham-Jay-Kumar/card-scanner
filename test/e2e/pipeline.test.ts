/**
 * The full pipeline through the real HTTP API, with the fake server and a real
 * SQLite file. RUN_FULL_SYNTH=1 also runs the whole generated known-answer set.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CardRow, FieldKey } from '../../src/shared/contracts.ts';
import { startFakeOpenAI } from '../fake-openai/server.ts';
import type { FakeOpenAI, Misread } from '../fake-openai/server.ts';
import { FULL_SYNTH, installFakeDns, loadApp, startTestApp, tempDataDir } from '../helpers/app.ts';
import type { CardSummary, FakeDns, TestApp, UploadItem } from '../helpers/app.ts';
import { cardFile, testCard } from '../helpers/fixtures.ts';
import type { TestCard } from '../helpers/fixtures.ts';
import { noCardPhoto } from '../synth/degrade.ts';
import type { Degradation } from '../synth/degrade.ts';

const run = promisify(execFile);
const ARTIFACTS = resolve(import.meta.dirname, '..', '.artifacts');
const { createApp, skipReason } = await loadApp();
const table: Degradation = { kind: 'table' };
const HOOK_TIMEOUT = 15 * 60_000;

describe.skipIf(!createApp)(`pipeline ${skipReason}`, () => {
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

  describe('happy path and every degraded type', () => {
    const recipes: Array<[string, Degradation[], boolean]> = [
      ['clean', [], false],
      ['clean-2', [], false],
      ['rotate-90', [table, { kind: 'rotate', angle: 90 }], false],
      ['rotate-180', [table, { kind: 'rotate', angle: 180 }], false],
      ['rotate-270', [table, { kind: 'rotate', angle: 270 }], false],
      ['skew', [table, { kind: 'skew', degrees: 4 }], false],
      ['perspective', [table, { kind: 'perspective', strength: 0.1 }], false],
      ['glare', [table, { kind: 'glare' }], false],
      ['blur-heavy', [table, { kind: 'blur', sigma: 6 }], true],
      ['dim-heavy', [table, { kind: 'dim', factor: 0.2 }], true],
    ];
    const byName = new Map<string, { card: TestCard; mustReview: boolean }>();
    const wrongExtension = testCard(3120);
    const heic = testCard(3121);
    const exif = testCard(3122);
    let cards: CardSummary[];
    let jobId: string;

    beforeAll(async () => {
      const items: UploadItem[] = [];
      for (const [index, [name, steps, mustReview]] of recipes.entries()) {
        const card = testCard(3100 + index);
        const file = await cardFile(card, steps);
        items.push({ ...file, name: `${name}.jpg` });
        byName.set(`${name}.jpg`, { card, mustReview });
      }

      const scratch = await tempDataDir();
      const png = await sharp((await cardFile(heic)).bytes).png().toFile(join(scratch, 'in.png'));
      await run('sips', ['-s', 'format', 'heic', join(scratch, 'in.png'), '--out', join(scratch, 'out.heic')]);
      expect(png.size).toBeGreaterThan(0);
      items.push({ name: 'iphone.heic', bytes: await readFile(join(scratch, 'out.heic')) });
      byName.set('iphone.heic', { card: heic, mustReview: false });
      await rm(scratch, { recursive: true, force: true });

      items.push({ ...(await cardFile(wrongExtension)), name: 'jpeg-named.png' });
      byName.set('jpeg-named.png', { card: wrongExtension, mustReview: false });

      const sideways = await sharp((await cardFile(exif)).bytes).rotate(270).withMetadata({ orientation: 6 }).jpeg({ quality: 92 }).toBuffer();
      items.push({ name: 'exif.jpg', bytes: sideways });
      byName.set('exif.jpg', { card: exif, mustReview: false });

      items.push({ name: 'no-card.jpg', bytes: await noCardPhoto(1200, 900) });
      items.push({ name: 'truncated.jpg', bytes: items[0]!.bytes.subarray(0, 200) });
      items.push({ name: 'not-an-image.png', bytes: Buffer.from('this is not an image, at all, not even slightly') });
      items.push({ name: 'copy-of-clean.jpg', bytes: items[0]!.bytes });

      fake.addCards([...byName.values()].map(({ card }) => card.fake));
      const { job } = await app.runJob(items, undefined, HOOK_TIMEOUT);
      jobId = job.id;
      cards = await app.cards(job.id);
    }, HOOK_TIMEOUT);

    it('finishes with every file and card accounted for', async () => {
      const progress = await app.api<{ status: string }>(`/api/jobs/${jobId}/progress`);
      expect(progress.status).toBe('done');
      const count = await app.reconciliation(jobId);
      const ended = (await app.files(jobId)).map((file) => `${file.originalName}: ${file.stage} ${file.error ?? ''} ${file.locate?.note ?? ''}`);
      console.info(ended.join('\n'));
      expect(count, ended.join('\n')).toMatchObject({ files: 17, duplicateFiles: 1, noCardFiles: 1, failedFiles: 2, cards: 13, cardsInProgress: 0, filesInProgress: 0, failedCards: 0, balanced: true });
    });

    it('sends both passes for every image, and each request obeys the API rules', () => {
      const stats = fake.stats();
      expect(stats.violations).toEqual([]);
      expect(stats.log.some((entry) => entry.pass === 1)).toBe(true);
      expect(stats.log.some((entry) => entry.pass === 2)).toBe(true);
    });

    it('identifies every read image, one card each, all upright', () => {
      const stats = fake.stats();
      expect(stats.unidentifiedReads).toBe(0);
      expect(stats.multiCardReads).toBe(0);
      expect(stats.notUprightReads).toBe(0);
    });

    it('makes all three reads of every card, from three different images', () => {
      for (const { card } of byName.values()) {
        expect(fake.stats().delivered[card.markerId], `card ${card.markerId}`).toMatchObject({ A: 1, B: 1, C: 1 });
      }
    });

    it('gets every row exactly right, degraded or not', () => {
      expect(cards.map((card) => card.sourceName).sort()).toEqual([...byName.keys()].sort());
      for (const card of cards) expect(card.row, card.sourceName).toEqual(byName.get(card.sourceName)?.card.row);
    });

    it('verifies good images and sends poor ones to a person', () => {
      for (const card of cards) {
        const wanted = byName.get(card.sourceName)!.mustReview ? 'needs_review' : 'verified';
        expect(`${card.sourceName}: ${card.status}`).toBe(`${card.sourceName}: ${wanted}`);
      }
    });

    it('offers only verified rows for copying', () => {
      expect(app.copyable(jobId)).toHaveLength(cards.filter((card) => card.status === 'verified').length);
    });
  });

  describe('misreads', () => {
    const cases: Array<{ label: string; card: TestCard; misread: Omit<Misread, 'cardIds'>; flagged: FieldKey; check: string }> = [
      { label: 'one read wrong', card: testCard(3200), misread: { field: 'position', variants: ['B'], replace: { from: 'a', to: 'o' } }, flagged: 'position', check: 'agreement' },
      { label: 'two reads wrong', card: testCard(3201), misread: { field: 'company', variants: ['A', 'C'], replace: { from: 'r', to: 'n' } }, flagged: 'company', check: 'agreement' },
      { label: 'invented website in all reads', card: testCard(3202, { websites: [] }), misread: { field: 'website', value: 'www.invented-site.com' }, flagged: 'website', check: 'verbatim' },
      { label: 'corrected spelling in all reads', card: testCard(3203), misread: { field: 'name', replace: { from: 'a', to: 'e' }, inTranscript: false }, flagged: 'name', check: 'verbatim' },
      { label: 'field flagged unreadable', card: testCard(3204), misread: { field: 'phone', unreadable: true }, flagged: 'phone', check: 'unreadable' },
      { label: 'one read left it blank', card: testCard(3205), misread: { field: 'email', variants: ['C'], blank: true }, flagged: 'email', check: 'agreement' },
    ];
    let cards: CardSummary[];

    beforeAll(async () => {
      fake.addCards(cases.map(({ card }) => card.fake));
      fake.configure({ misreads: cases.map(({ card, misread }) => ({ ...misread, cardIds: [card.markerId] })) });
      const { job } = await app.runJob(await Promise.all(cases.map(({ card }) => cardFile(card))), undefined, HOOK_TIMEOUT);
      cards = await app.cards(job.id);
      fake.configure({ misreads: [] });
    }, HOOK_TIMEOUT);

    for (const { label, card, flagged, check } of cases) {
      it(`${label} goes to a person, flagged on ${flagged}, by the ${check} check`, async () => {
        const summary = cards.find((item) => item.sourceName === `card-${card.markerId}.jpg`)!;
        expect(summary.status).toBe('needs_review');
        expect(summary.flaggedFields).toContain(flagged);
        const { card: detail } = await app.cardDetail(summary.id);
        const failed = detail.decision!.checks.filter((item) => !item.passed && item.field === flagged).map((item) => item.check);
        expect(failed).toContain(check);
      });
    }
  });

  /**
   * The same misread in all three reads, in the transcript too, so agreement and
   * verbatim both pass. Only the near-miss and domain checks can help. Each case
   * records whether it was caught, and ones that escape are pinned here by name:
   * they are the known limit of automatic checking, and a change either way fails.
   */
  describe('correlated misreads that agreement cannot see', () => {
    const base = { company: 'Acme Tools', emails: ['fern.barnes@acmetools.com'], websites: ['www.acmetools.com'], name: 'Fern Barnes' };
    // Replacements name the exact text, because they also apply to every transcript line.
    const freight = { emails: ['fern.barnes@acmefreight.com'], websites: ['www.acmefreight.com'] };
    const cases: Array<{ label: string; id: number; tweak?: object; missing?: string; misreads: Array<Omit<Misread, 'cardIds'>>; caughtBy: string | null }> = [
      { label: 'email local part differs from the name (rn to m)', id: 3300, misreads: [{ field: 'email', replace: { from: 'fern.barnes', to: 'fem.bames' } }], caughtBy: 'near_miss' },
      { label: 'name differs from the email (rn to m)', id: 3301, misreads: [{ field: 'name', replace: { from: 'Barnes', to: 'Bames' } }], caughtBy: 'near_miss' },
      { label: 'email domain misread, domain does not exist', id: 3302, missing: 'acrnetools.com', misreads: [{ field: 'email', replace: { from: '@acmetools.com', to: '@acrnetools.com' } }], caughtBy: 'real_domain' },
      { label: 'website domain misread, domain exists, email domain differs', id: 3303, tweak: freight, misreads: [{ field: 'website', replace: { from: 'www.acmefreight.com', to: 'www.acrnefreight.com' } }], caughtBy: 'near_miss' },
      { label: 'email domain misread, domain exists, website domain differs', id: 3304, tweak: freight, misreads: [{ field: 'email', replace: { from: '@acmefreight.com', to: '@acrnefreight.com' } }], caughtBy: 'near_miss' },
      { label: 'same domain misread in email and website, domain exists', id: 3305, tweak: freight, misreads: [{ field: 'email', replace: { from: '@acmefreight.com', to: '@acrnefreight.com' } }, { field: 'website', replace: { from: 'www.acmefreight.com', to: 'www.acrnefreight.com' } }], caughtBy: null },
      { label: 'name misread, no email to compare with', id: 3306, tweak: { emails: [] }, misreads: [{ field: 'name', replace: { from: 'Barnes', to: 'Bames' } }], caughtBy: null },
      { label: 'phone digit misread', id: 3307, misreads: [{ field: 'phone', replace: { from: '415 555', to: '415 556' } }], caughtBy: null },
      { label: 'company misread', id: 3308, misreads: [{ field: 'company', replace: { from: 'Tools', to: 'Tocls' } }], caughtBy: null },
      { label: 'position misread', id: 3309, tweak: { position: 'Senior Manager' }, misreads: [{ field: 'position', replace: { from: 'Manager', to: 'Manger' } }], caughtBy: null },
    ];
    const seen = new Map<number, { status: string; row: CardRow; failed: string[] }>();

    beforeAll(async () => {
      const cards = cases.map((item) => testCard(item.id, { ...base, ...item.tweak }));
      fake.addCards(cards.map((card) => card.fake));
      fake.configure({ misreads: cases.flatMap((item) => item.misreads.map((misread) => ({ ...misread, cardIds: [item.id] }))) });
      dns.setMissing(cases.flatMap((item) => (item.missing ? [item.missing] : [])));
      const { job } = await app.runJob(await Promise.all(cards.map((card) => cardFile(card))), undefined, HOOK_TIMEOUT);
      for (const summary of await app.cards(job.id)) {
        const id = Number(/card-(\d+)/.exec(summary.sourceName)?.[1]);
        const { card } = await app.cardDetail(summary.id);
        seen.set(id, { status: summary.status, row: summary.row!, failed: card.decision!.checks.filter((check) => !check.passed).map((check) => check.check) });
      }
      fake.configure({ misreads: [] });
      dns.setMissing([]);

      await mkdir(ARTIFACTS, { recursive: true });
      const record = cases.map((item) => ({ scenario: item.label, ...seen.get(item.id) }));
      await writeFile(join(ARTIFACTS, 'correlated-misreads.json'), JSON.stringify(record, null, 2));
    }, HOOK_TIMEOUT);

    for (const { label, id, caughtBy } of cases.filter((item) => item.caughtBy)) {
      it(`caught by ${caughtBy}: ${label}`, () => {
        const result = seen.get(id)!;
        expect(result.failed).toContain(caughtBy);
        expect(result.status).toBe('needs_review');
      });
    }

    const escapes = cases.filter((item) => !item.caughtBy);
    it(`these ${escapes.length} escape every check and reach Verified with a wrong value`, () => {
      const escaped = cases.filter((item) => seen.get(item.id)?.status === 'verified').map((item) => item.label);
      expect(escaped).toEqual(escapes.map((item) => item.label));
    });
  });
});

describe.skipIf(!createApp || !FULL_SYNTH)('full known-answer set (RUN_FULL_SYNTH=1)', () => {
  it('loses nothing and verifies no wrong value', async () => {
    const { generateSynthSet, SYNTH_TRUTH } = await import('../synth/generate.ts');
    await generateSynthSet();
    const { runAccuracy, REPORT_DIR } = await import('../accuracy/run.ts');
    const { formatReport } = await import('../accuracy/score.ts');
    const report = await runAccuracy({ truthPath: SYNTH_TRUTH, timeoutMs: 45 * 60_000 });
    await mkdir(REPORT_DIR, { recursive: true });
    await writeFile(join(REPORT_DIR, 'report-full-synth.txt'), formatReport(report));
    expect(report.cardsLost).toBe(0);
    expect(report.extraCards).toBe(0);
    expect(report.fileProblems).toEqual([]);
    expect(report.outOfOrderFiles).toEqual([]);
    expect(report.wrongVerified).toEqual([]);
    expect(report.inventedValues).toEqual([]);
    expect(report.statusProblems).toEqual([]);
  }, 50 * 60_000);
});
