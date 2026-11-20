import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QualityIssue } from '../shared/contracts.ts';
import { assessImageQuality, buildReport, measurePixels, MIN_BLUR_SCORE, MIN_LONG_EDGE_PX } from './quality.ts';
import type { PixelMeasure } from './quality.ts';
import { DARK_CARD, LIGHT_CARD, renderCard, saveNormalized, withTempDir } from './testFixtures.ts';

let dir: string;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ dir, cleanup } = await withTempDir('quality'));
});
afterAll(() => cleanup());

let counter = 0;
async function assess(image: Buffer) {
  counter += 1;
  return assessImageQuality(await saveNormalized(image, path.join(dir, `q${counter}.jpg`)));
}
const measureOf = (image: Buffer) => measurePixels(sharp(image));

const FINE: PixelMeasure = { blurScore: MIN_BLUR_SCORE * 4, meanLuminance: 180, shadowLevel: 20, highlightLevel: 250 };

describe('blur', () => {
  it('passes a sharp card and flags a defocused one', async () => {
    const card = await renderCard(LIGHT_CARD, 1200);
    const sharpReport = await assess(card);
    const softReport = await assess(await sharp(card).blur(6).png().toBuffer());

    expect(sharpReport.issues).not.toContain('blurry');
    expect(softReport.issues).toContain('blurry');
    expect(softReport.ok).toBe(false);
    expect(sharpReport.blurScore).toBeGreaterThan(softReport.blurScore * 5);
  });

  it('gets steadily lower as blur grows', async () => {
    const card = await renderCard(LIGHT_CARD, 1000);
    const scores: number[] = [];
    for (const sigma of [0.6, 1.5, 3, 6]) scores.push((await measureOf(await sharp(card).blur(sigma).png().toBuffer())).blurScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('scores the same card alike at different sizes, so scores can be compared', async () => {
    const small = await measureOf(await renderCard(LIGHT_CARD, 1400));
    const large = await measureOf(await renderCard(LIGHT_CARD, 2800));
    expect(large.blurScore / small.blurScore).toBeGreaterThan(0.5);
    expect(large.blurScore / small.blurScore).toBeLessThan(2);
  });

  it('is not fooled by plain background around the card', async () => {
    const card = await renderCard(LIGHT_CARD, 500);
    const mostlyTable = await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#7a6a58' } })
      .composite([{ input: card, left: 250, top: 250 }])
      .png()
      .toBuffer();
    expect((await assess(mostlyTable)).issues).not.toContain('blurry');
  });

  it('does not call a card with very little printed on it blurry', async () => {
    const sparse = { ...LIGHT_CARD, title: '', company: '', phone: '', website: '' };
    expect((await assess(await renderCard(sparse, 1000))).issues).not.toContain('blurry');
  });

  it('is measured without enlarging, so a small sharp card is not marked blurry for being small', async () => {
    const report = await assess(await renderCard(LIGHT_CARD, 500));
    expect(report.issues).toEqual(['low_resolution']);
  });
});

describe('exposure', () => {
  it('does not treat a dark card as a bad photo', async () => {
    const report = await assess(await renderCard(DARK_CARD, 1000));
    expect(report.meanLuminance).toBeLessThan(60);
    expect(report.issues).toEqual([]);
  });

  it('does not treat a white card on a white scanner as overexposed', async () => {
    const sparse = { ...LIGHT_CARD, title: '', company: '' };
    const report = await assess(await renderCard(sparse, 1000));
    expect(report.meanLuminance).toBeGreaterThan(235);
    expect(report.issues).toEqual([]);
  });

  it('flags an underexposed card', async () => {
    const dim = await sharp(await renderCard(LIGHT_CARD, 1000)).linear(0.12, 0).png().toBuffer();
    expect((await assess(dim)).issues).toContain('too_dark');
  });

  it('flags a washed-out card', async () => {
    const washed = await sharp(await renderCard(LIGHT_CARD, 1000)).linear(0.1, 255 * 0.9).png().toBuffer();
    expect((await assess(washed)).issues).toContain('too_bright');
  });

  it('reports mean luminance on the 0-255 scale', async () => {
    const grey = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#808080' } }).png().toBuffer();
    expect((await assess(grey)).meanLuminance).toBeCloseTo(128, -1);
  });
});

describe('report', () => {
  it('uses the long edge for low_resolution, right at the limit', () => {
    expect(buildReport(MIN_LONG_EDGE_PX, 400, FINE).issues).toEqual([]);
    expect(buildReport(MIN_LONG_EDGE_PX - 1, 400, FINE).issues).toEqual(['low_resolution']);
    expect(buildReport(400, MIN_LONG_EDGE_PX, FINE).issues).toEqual([]);
  });

  it('is ok only with no issues, and lists every issue found', () => {
    expect(buildReport(2000, 1200, FINE).ok).toBe(true);
    const poor = buildReport(300, 200, { ...FINE, blurScore: 0 });
    expect(poor.ok).toBe(false);
    expect(poor.issues).toEqual(['low_resolution', 'blurry']);
  });

  it('adds issues from the caller, which also fail the report', () => {
    const extra: QualityIssue[] = ['location_uncertain'];
    const report = buildReport(2000, 1200, FINE, extra);
    expect(report.issues).toEqual(['location_uncertain']);
    expect(report.ok).toBe(false);
  });

  it('flags a poor image without ever throwing', async () => {
    const blank = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000000' } }).png().toBuffer();
    const report = await assess(blank);
    expect(report.ok).toBe(false);
    expect(report).toMatchObject({ width: 8, height: 8 });
    expect(report.issues).toEqual(expect.arrayContaining(['low_resolution', 'too_dark']));
  });
});
