import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createVisionService } from './index.ts';
import { cardsAnswer, cornersMatch, cornersRaw, fakeLlm, gridBoxes, LOCATE_CTX, rawPixels, tiltedAwayBy, toWire, withTempDir } from './testFixtures.ts';
import type { Rotation } from '../shared/contracts.ts';

let dir: string;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ dir, cleanup } = await withTempDir('service'));
});
afterAll(() => cleanup());

it('takes a 36-card photo with mixed rotations from upload to read images', async () => {
  const cardWidth = 180;
  const cardHeight = 100;
  const grid = gridBoxes({ columns: 6, rows: 6, cardWidth, cardHeight, gap: 90, margin: 50 });
  // The colours sit inside a plain border, as printing does. Colours running to the very edge would put a
  // line right across the middle of every card, which the pixel check would take for a seam between two.
  const borderX = 24;
  const borderY = 12;
  const artWidth = cardWidth - borderX * 2;
  const artHeight = cardHeight - borderY * 2;
  const art = await sharp(cornersRaw(artWidth, artHeight), { raw: { width: artWidth, height: artHeight, channels: 3 } }).png().toBuffer();
  const cardPng = await sharp({ create: { width: cardWidth, height: cardHeight, channels: 3, background: '#f2f2f2' } })
    .composite([{ input: art, left: borderX, top: borderY }])
    .png()
    .toBuffer();
  const rotations = grid.boxes.map((_, index) => ([0, 90, 180, 270] as Rotation[])[index % 4]!);

  // Rotated cards are drawn turned on their centre, so their boxes differ from the grid's.
  const cards = await Promise.all(
    grid.boxes.map(async (cell, index) => {
      const rotation = rotations[index]!;
      const turned = rotation % 180 !== 0;
      const width = turned ? cardHeight : cardWidth;
      const height = turned ? cardWidth : cardHeight;
      const box = { x: cell.x + (cardWidth - width) / 2, y: cell.y + (cardHeight - height) / 2, width, height };
      return { box, rotation, input: await tiltedAwayBy(rotation, cardPng) };
    }),
  );
  const photo = await sharp({ create: { width: grid.width, height: grid.height, channels: 3, background: '#3c3c3c' } })
    .composite(cards.map(({ input, box }) => ({ input, left: box.x, top: box.y })))
    .jpeg({ quality: 95 })
    .toBuffer();
  const sourcePath = path.join(dir, 'table.jpg');
  await sharp(photo).toFile(sourcePath);

  const wire = cards.map(({ box, rotation }) => toWire(box, grid, rotation));
  const vision = createVisionService({ llm: fakeLlm(cardsAnswer(wire), cardsAnswer([...wire].reverse())) });

  const normalized = await vision.normalize({ sourcePath, originalName: 'table.jpg', outDir: dir });
  const quality = await vision.assessQuality(normalized);
  const located = await vision.locate(normalized, LOCATE_CTX);
  const crops = await vision.crop(normalized, located, path.join(dir, 'crops'));

  expect(quality.width).toBe(grid.width);
  expect(located).toMatchObject({ noCard: false, fellBackToFullImage: false, countConfirmed: true });
  expect(crops).toHaveLength(36);
  for (const crop of crops) {
    expect(crop.side).toBe('single');
    expect(crop.quality.issues).toContain('low_resolution');
    expect(crop.width).toBeGreaterThan(crop.height);
    expect(cornersMatch(await rawPixels(crop.path))).toBe(true);
  }

  const reads = await vision.prepareReadImages(crops[0]!, path.join(dir, 'reads'));
  const [natural, enlarged] = await Promise.all([sharp(reads.A).metadata(), sharp(reads.C).metadata()]);
  expect(enlarged.width).toBeGreaterThan(natural.width);
  expect(cornersMatch(await rawPixels(reads.A))).toBe(true);
  expect(cornersMatch(await rawPixels(reads.C))).toBe(true);
});
