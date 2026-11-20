import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../shared/config.ts';
import type { CardCrop, QualityReport } from '../shared/contracts.ts';
import { prepareCardReadImages } from './readImages.ts';
import { DARK_CARD, rawPixels, renderCard, withTempDir } from './testFixtures.ts';
import type { RawImage } from './testFixtures.ts';

const { cropMinLongEdge, cropMaxLongEdge, jpegQuality, maxPatchesPerImage } = CONFIG.image;
const PATCH = 32;

let dir: string;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ dir, cleanup } = await withTempDir('read'));
});
afterAll(() => cleanup());

const NO_ISSUES: QualityReport = { ok: true, width: 0, height: 0, blurScore: 500, meanLuminance: 128, issues: [] };

async function cropFrom(image: Buffer, name: string): Promise<CardCrop> {
  const filePath = path.join(dir, `${name}.jpg`);
  const { width, height } = await sharp(image).jpeg({ quality: 95 }).toFile(filePath);
  return { path: filePath, width, height, side: 'single', quality: NO_ISSUES };
}

function solid(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#4a6d8c' } }).png({ compressionLevel: 1 }).toBuffer();
}

const longEdgeOf = async (filePath: string) => {
  const { width, height } = await sharp(filePath).metadata();
  return Math.max(width, height);
};

/** Spread between the dark and light ends of an image's luminance, ignoring stray pixels. */
function contrastOf(image: RawImage): { low: number; high: number; mean: number } {
  const levels: number[] = [];
  for (let at = 0; at < image.data.length; at += image.channels * 7) {
    levels.push(0.299 * image.data[at]! + 0.587 * image.data[at + 1]! + 0.114 * image.data[at + 2]!);
  }
  levels.sort((a, b) => a - b);
  const pick = (fraction: number) => levels[Math.floor((levels.length - 1) * fraction)]!;
  return { low: pick(0.02), high: pick(0.98), mean: levels.reduce((sum, level) => sum + level, 0) / levels.length };
}

describe('sizes', () => {
  it.each([
    ['tiny scan', 120, 70],
    ['small scan', 600, 343],
    ['at the minimum', 1600, 914],
    ['at the maximum', 3000, 1714],
    ['huge photo', 4200, 2400],
    ['portrait', 900, 1575],
    ['square', 1000, 1000],
    ['slim', 2000, 500],
  ])('stays in bounds with C larger than A: %s', async (name, width, height) => {
    const crop = await cropFrom(await solid(width, height), `size-${name.replaceAll(' ', '-')}`);
    const { A, B, C } = await prepareCardReadImages(crop, path.join(dir, 'sizes'));

    const [edgeA, edgeB, edgeC] = await Promise.all([A, B, C].map(longEdgeOf));
    for (const edge of [edgeA!, edgeB!, edgeC!]) {
      expect(edge).toBeGreaterThanOrEqual(cropMinLongEdge);
      expect(edge).toBeLessThanOrEqual(cropMaxLongEdge);
    }
    expect(edgeC).toBeGreaterThan(edgeA!);

    for (const filePath of [A, B, C]) {
      const metadata = await sharp(filePath).metadata();
      const patches = Math.ceil(metadata.width / PATCH) * Math.ceil(metadata.height / PATCH);
      expect(patches).toBeLessThan(maxPatchesPerImage / 2);
      expect(metadata.format).toBe('jpeg');
      expect(metadata.width / metadata.height).toBeCloseTo(width / height, 1);
    }
  });

  it('stays comfortably under the patch limit even at the worst case, a square at maximum size', () => {
    expect((Math.ceil(cropMaxLongEdge / PATCH) ** 2)).toBeLessThan(maxPatchesPerImage / 2);
  });

  it('saves at the configured JPEG quality', async () => {
    const crop = await cropFrom(await solid(1000, 600), 'jpeg-quality');
    const { A } = await prepareCardReadImages(crop, path.join(dir, 'quality'));
    const atConfigured = await sharp(crop.path).resize({ width: 1600, height: 1600, fit: 'inside' }).jpeg({ quality: jpegQuality, chromaSubsampling: '4:4:4' }).toBuffer();
    expect(await readFile(A)).toEqual(atConfigured);
  });
});

describe('content', () => {
  it('keeps A natural: colours match the crop', async () => {
    const crop = await cropFrom(await solid(1000, 600), 'natural');
    const { A } = await prepareCardReadImages(crop, path.join(dir, 'natural'));
    const { dominant } = await sharp(A).stats();
    expect(Math.abs(dominant.r - 0x4a)).toBeLessThanOrEqual(16);
    expect(Math.abs(dominant.g - 0x6d)).toBeLessThanOrEqual(16);
    expect(Math.abs(dominant.b - 0x8c)).toBeLessThanOrEqual(16);
  });

  it('keeps a dark card dark with light text in B, with text at least as strong as A', async () => {
    const crop = await cropFrom(await renderCard(DARK_CARD, 1000), 'dark');
    const { A, B } = await prepareCardReadImages(crop, path.join(dir, 'dark'));

    const natural = contrastOf(await rawPixels(A));
    const enhanced = contrastOf(await rawPixels(B));

    // Same polarity: the background stays dark and the text stays light.
    expect(enhanced.mean).toBeLessThan(90);
    expect(enhanced.low).toBeLessThan(60);
    expect(enhanced.high).toBeGreaterThan(190);
    expect(enhanced.high - enhanced.low).toBeGreaterThanOrEqual(natural.high - natural.low - 10);
  });

  it('lifts faint text in B', async () => {
    const faint = { ...DARK_CARD, background: '#22262b', ink: '#5e646b', accent: '#5e646b' };
    const crop = await cropFrom(await renderCard(faint, 1000), 'faint');
    const { A, B } = await prepareCardReadImages(crop, path.join(dir, 'faint'));

    const natural = contrastOf(await rawPixels(A));
    const enhanced = contrastOf(await rawPixels(B));

    expect(enhanced.high - enhanced.low).toBeGreaterThan((natural.high - natural.low) * 1.5);
  });

  it('keeps hue in B, because coloured print still has to read as that colour', async () => {
    const coloured = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#ffffff' } })
      .composite([
        { input: { create: { width: 300, height: 200, channels: 3, background: '#d01818' } }, left: 40, top: 100 },
        { input: { create: { width: 300, height: 200, channels: 3, background: '#000000' } }, left: 460, top: 100 },
      ])
      .png()
      .toBuffer();
    const crop = await cropFrom(coloured, 'hue');
    const { B } = await prepareCardReadImages(crop, path.join(dir, 'hue'));
    const image = await rawPixels(B);
    const at = (Math.floor(image.height / 2) * image.width + Math.floor(image.width * 0.2)) * image.channels;
    const [red, green, blue] = [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!];
    expect(red).toBeGreaterThan(green + 80);
    expect(red).toBeGreaterThan(blue + 80);
  });

  it('survives a completely flat crop', async () => {
    const crop = await cropFrom(await solid(400, 240), 'flat');
    await expect(prepareCardReadImages(crop, path.join(dir, 'flat'))).resolves.toBeDefined();
  });
});

describe('safe re-runs', () => {
  it('uses deterministic names, overwrites them and leaves no temp files', async () => {
    const crop = await cropFrom(await solid(800, 450), 'rerun');
    const outDir = path.join(dir, 'rerun');
    const first = await prepareCardReadImages(crop, outDir);
    const second = await prepareCardReadImages(crop, outDir);
    expect(second).toEqual(first);
    expect(path.basename(first.A)).toBe('rerun-A.jpg');
    expect(path.basename(first.B)).toBe('rerun-B.jpg');
    expect(path.basename(first.C)).toBe('rerun-C.jpg');
    expect((await readdir(outDir)).sort()).toEqual(['rerun-A.jpg', 'rerun-B.jpg', 'rerun-C.jpg']);
  });
});
