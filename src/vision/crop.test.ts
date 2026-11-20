import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../shared/config.ts';
import type { LocateResult, NormalizedImage, Rotation } from '../shared/contracts.ts';
import { cropCards } from './crop.ts';
import { MASTER_JPEG } from './normalize.ts';
import { assessImageQuality, MIN_LONG_EDGE_PX } from './quality.ts';
import { prepareCardReadImages } from './readImages.ts';
import {
  CARD_ASPECT,
  cornersMatch,
  cornersRaw,
  DARK_CARD,
  gridBoxes,
  isNear,
  LIGHT_CARD,
  pixelAt,
  rawPixels,
  renderCard,
  saveNormalized,
  tiltedAwayBy,
  withTempDir,
} from './testFixtures.ts';
import type { RawImage, Rgb } from './testFixtures.ts';

/** Counts every image sharp opens from disk, to prove one photo is decoded once however many cards it holds. */
const openedPaths = vi.hoisted(() => [] as string[]);
vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sharp')>();
  const counted = (...args: unknown[]) => {
    if (typeof args[0] === 'string') openedPaths.push(args[0]);
    return (actual.default as unknown as (...inner: unknown[]) => unknown)(...args);
  };
  return { ...actual, default: Object.assign(counted, actual.default) };
});

let dir: string;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ dir, cleanup } = await withTempDir('crop'));
});
afterAll(() => cleanup());

function located(locations: LocateResult['locations'], extra: Partial<LocateResult> = {}): LocateResult {
  return { noCard: false, locations, fellBackToFullImage: false, countConfirmed: true, note: null, ...extra };
}

const canvas = (width: number, height: number, background = '#505050') =>
  sharp({ create: { width, height, channels: 3, background } });

function cornersCard(width: number, height: number) {
  return sharp(cornersRaw(width, height), { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe('cutting', () => {
  it('cuts the card whole with the configured margin on every side', async () => {
    const card = await canvas(300, 200, '#e02020').png().toBuffer();
    const png = await canvas(800, 600).composite([{ input: card, left: 200, top: 150 }]).png().toBuffer();
    const image = await saveNormalized(png, path.join(dir, 'margin.jpg'));

    const [crop] = await cropCards(image, located([{ box: { x: 200, y: 150, width: 300, height: 200 }, rotation: 0 }]), path.join(dir, 'margin'));

    const marginX = 300 * CONFIG.image.cropMarginRatio;
    const marginY = 200 * CONFIG.image.cropMarginRatio;
    expect(crop!.width).toBe(300 + 2 * marginX);
    expect(crop!.height).toBe(200 + 2 * marginY);
    expect(crop!.side).toBe('single');

    const pixels = await rawPixels(crop!.path);
    expect(isNear(pixelAt(pixels, 2, 2), [80, 80, 80], 30)).toBe(true);
    expect(isNear(pixelAt(pixels, marginX + 4, marginY + 4), [224, 32, 32], 40)).toBe(true);
    expect(isNear(pixelAt(pixels, crop!.width - marginX - 4, crop!.height - marginY - 4), [224, 32, 32], 40)).toBe(true);
    expect(isNear(pixelAt(pixels, crop!.width - 3, crop!.height - 3), [80, 80, 80], 30)).toBe(true);
  });

  it('stops the margin at the edge of the image', async () => {
    const image = await saveNormalized(await canvas(400, 300).png().toBuffer(), path.join(dir, 'edge.jpg'));
    const [crop] = await cropCards(image, located([{ box: { x: 0, y: 0, width: 400, height: 300 }, rotation: 0 }]), path.join(dir, 'edge'));
    expect([crop!.width, crop!.height]).toEqual([400, 300]);
  });

  it.each([0, 90, 180, 270] as Rotation[])('turns a card needing %i degrees upright, checked by pixels', async (rotation) => {
    const tilted = await tiltedAwayBy(rotation, await cornersCard(320, 180));
    const { width, height } = await sharp(tilted).metadata();
    const png = await canvas(800, 600).composite([{ input: tilted, left: 100, top: 90 }]).png().toBuffer();
    const image = await saveNormalized(png, path.join(dir, `turn-${rotation}.jpg`));

    const [crop] = await cropCards(image, located([{ box: { x: 100, y: 90, width, height }, rotation }]), path.join(dir, 'turn'));

    expect(crop!.width).toBeGreaterThan(crop!.height);
    expect(cornersMatch(await rawPixels(crop!.path))).toBe(true);
  });

  it('keeps cards in the order locate gave, so rows follow reading order', async () => {
    const colours = ['#e02020', '#20c020', '#2040e0', '#e0c020', '#20c0c0', '#c020c0', '#ffffff', '#101010'];
    const grid = gridBoxes({ columns: 2, rows: 4, cardWidth: 280, cardHeight: 160, gap: 20, margin: 30 });
    const layers = await Promise.all(
      grid.boxes.map(async (box, index) => ({
        input: await canvas(box.width, box.height, colours[index]).png().toBuffer(),
        left: box.x,
        top: box.y,
      })),
    );
    const sheet = await saveNormalized(await canvas(grid.width, grid.height, '#808080').composite(layers).png().toBuffer(), path.join(dir, 'sheet.jpg'));

    const crops = await cropCards(sheet, located(grid.boxes.map((box) => ({ box, rotation: 0 }))), path.join(dir, 'sheet'));

    expect(crops).toHaveLength(8);
    for (const [index, crop] of crops.entries()) {
      const hex = colours[index]!;
      const expected = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
      expect(isNear(pixelAt(await rawPixels(crop.path), crop.width >> 1, crop.height >> 1), expected, 30)).toBe(true);
    }
  });

  it('gives each card its own file with stable names', async () => {
    const image = await saveNormalized(await canvas(600, 300).png().toBuffer(), path.join(dir, 'names.jpg'));
    const locations = [
      { box: { x: 10, y: 10, width: 200, height: 120 }, rotation: 0 as const },
      { box: { x: 300, y: 10, width: 200, height: 120 }, rotation: 0 as const },
    ];
    const outDir = path.join(dir, 'names');
    const first = await cropCards(image, located(locations), outDir);
    const firstBytes = await readFile(first[1]!.path);
    const second = await cropCards(image, located(locations), outDir);

    expect(first.map((crop) => path.basename(crop.path))).toEqual(['names-card-001.jpg', 'names-card-002.jpg']);
    expect(second.map((crop) => crop.path)).toEqual(first.map((crop) => crop.path));
    expect(await readFile(second[1]!.path)).toEqual(firstBytes);
    expect((await readdir(outDir)).sort()).toEqual(['names-card-001.jpg', 'names-card-002.jpg']);
  });

  it('returns nothing for a no-card result', async () => {
    const image = await saveNormalized(await canvas(200, 100).png().toBuffer(), path.join(dir, 'none.jpg'));
    expect(await cropCards(image, located([], { noCard: true }), path.join(dir, 'none'))).toEqual([]);
  });

  it('never loses a file: an empty result that is not "no card" still gives the whole image', async () => {
    const image = await saveNormalized(await canvas(200, 100).png().toBuffer(), path.join(dir, 'empty.jpg'));
    const crops = await cropCards(image, located([]), path.join(dir, 'empty'));
    expect(crops).toHaveLength(1);
    expect([crops[0]!.width, crops[0]!.height]).toEqual([200, 100]);
  });
});

describe('location_uncertain', () => {
  const whole = (image: NormalizedImage) => ({ box: { x: 0, y: 0, width: image.width, height: image.height }, rotation: 0 as const });

  it('sends every full-image fallback to a person, however good the image', async () => {
    const image = await saveNormalized(await renderCard(LIGHT_CARD, 900), path.join(dir, 'fallback.jpg'));
    const result = located([whole(image)], { fellBackToFullImage: true, countConfirmed: false, note: 'both passes failed' });

    const [crop] = await cropCards(image, result, path.join(dir, 'fallback'));

    expect(crop!.quality.issues).toEqual(['location_uncertain']);
    expect(crop!.quality.ok).toBe(false);
  });

  it('is not used just because the count is unconfirmed: that is a file-level warning', async () => {
    const image = await saveNormalized(await renderCard(LIGHT_CARD, 900), path.join(dir, 'unconfirmed.jpg'));
    const [crop] = await cropCards(image, located([whole(image)], { countConfirmed: false }), path.join(dir, 'unconfirmed'));
    expect(crop!.quality.issues).toEqual([]);
    expect(crop!.quality.ok).toBe(true);
  });
});

describe('per-card quality', () => {
  /** A photo tiled edge to edge with cards. Same sharp artwork in every cell. */
  async function photoOfCards(columns: number, rows: number, cardWidth: number, style = LIGHT_CARD) {
    const cardHeight = Math.round(cardWidth / CARD_ASPECT);
    const grid = gridBoxes({ columns, rows, cardWidth, cardHeight, gap: 12, margin: 12 });
    const card = await renderCard(style, cardWidth);
    const layers = grid.boxes.map((box) => ({ input: card, left: box.x, top: box.y }));
    const png = await canvas(grid.width, grid.height, '#6a5a48').composite(layers).png().toBuffer();
    return { grid, png };
  }

  it('flags a sharp many-card photo per card, though the photo as a whole looks fine', async () => {
    const { grid, png } = await photoOfCards(6, 5, 560);
    const photo = await saveNormalized(png, path.join(dir, 'thirty.jpg'));
    expect(grid.boxes).toHaveLength(30);
    expect((await assessImageQuality(photo)).issues).not.toContain('low_resolution');

    const crops = await cropCards(photo, located(grid.boxes.map((box) => ({ box, rotation: 0 }))), path.join(dir, 'thirty'));

    expect(crops).toHaveLength(30);
    for (const crop of crops) {
      expect(crop.quality.width).toBe(crop.width);
      expect(crop.quality.height).toBe(crop.height);
      expect(Math.max(crop.width, crop.height)).toBeLessThan(MIN_LONG_EDGE_PX);
      expect(crop.quality.issues).toEqual(['low_resolution']);
      expect(crop.quality.ok).toBe(false);
    }
  }, 60_000);

  it('passes the same layout when each card has enough pixels of its own', async () => {
    const { grid, png } = await photoOfCards(2, 2, 900);
    const photo = await saveNormalized(png, path.join(dir, 'four.jpg'));
    const crops = await cropCards(photo, located(grid.boxes.map((box) => ({ box, rotation: 0 }))), path.join(dir, 'four'));
    expect(crops.map((crop) => crop.quality.issues)).toEqual([[], [], [], []]);
  });

  it('judges blur and exposure on each card, ignoring its sharp outline against the table', async () => {
    const sharpCard = await renderCard(LIGHT_CARD, 1000);
    const softCard = await sharp(sharpCard).blur(5).png().toBuffer();
    const dimCard = await sharp(sharpCard).linear(0.12, 0).png().toBuffer();
    const washedCard = await sharp(sharpCard).linear(0.1, 255 * 0.9).png().toBuffer();
    const darkCard = await renderCard(DARK_CARD, 1000);
    const cards = [sharpCard, softCard, dimCard, washedCard, darkCard];
    const png = await canvas(2100, 1800).composite(cards.map((input, index) => ({ input, left: 20 + (index % 2) * 1040, top: 10 + Math.floor(index / 2) * 590 }))).png().toBuffer();
    const photo = await saveNormalized(png, path.join(dir, 'mixed.jpg'));
    const boxes = cards.map((_, index) => ({ x: 20 + (index % 2) * 1040, y: 10 + Math.floor(index / 2) * 590, width: 1000, height: 571 }));

    const [good, soft, dim, washed, dark] = await cropCards(photo, located(boxes.map((box) => ({ box, rotation: 0 }))), path.join(dir, 'mixed'));

    expect(good!.quality.issues).toEqual([]);
    expect(soft!.quality.issues).toContain('blurry');
    expect(dim!.quality.issues).toContain('too_dark');
    expect(washed!.quality.issues).toContain('too_bright');
    expect(dark!.quality.issues).toEqual([]);
  });
});

describe('neighbouring cards', () => {
  const MAGENTA = [255, 0, 255] as const;
  const GREEN = [0, 200, 0] as const;
  const MARGIN = Math.ceil(400 * CONFIG.image.cropMarginRatio);

  function contains(image: RawImage, colour: Rgb): boolean {
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        if (isNear(pixelAt(image, x, y), colour, 70)) return true;
      }
    }
    return false;
  }

  const block = (width: number, height: number, [r, g, b]: Rgb, left: number, top: number) => ({
    input: { create: { width, height, channels: 3 as const, background: { r, g, b } } },
    left,
    top,
  });

  /**
   * Two white cards 4 px apart. The right card has a magenta line of "print" just
   * inside its left edge, which falls in the left card's margin. The left card has
   * green print right up to its own right edge, which must survive.
   */
  async function twoCards() {
    const left = { x: 20, y: 20, width: 400, height: 228 };
    const right = { x: 424, y: 20, width: 400, height: 228 };
    const png = await canvas(844, 268, '#202020')
      .composite([
        block(left.width, left.height, [255, 255, 255], left.x, left.y),
        block(right.width, right.height, [255, 255, 255], right.x, right.y),
        block(8, 180, GREEN, left.x + left.width - 8, 40),
        block(6, 180, MAGENTA, right.x + 3, 40),
      ])
      .png()
      .toBuffer();
    const image = await saveNormalized(png, path.join(dir, 'pair.jpg'));
    return { image, left, right };
  }

  it('removes a neighbour from the crop and from all three read images', async () => {
    const { image, left, right } = await twoCards();
    const alone = await cropCards(image, located([{ box: left, rotation: 0 }]), path.join(dir, 'pair-alone'));
    expect(contains(await rawPixels(alone[0]!.path), MAGENTA)).toBe(true);

    const [crop] = await cropCards(image, located([{ box: left, rotation: 0 }, { box: right, rotation: 0 }]), path.join(dir, 'pair'));

    expect(contains(await rawPixels(crop!.path), MAGENTA)).toBe(false);
    const reads = await prepareCardReadImages(crop!, path.join(dir, 'pair-reads'));
    for (const readImage of [reads.A, reads.B, reads.C]) {
      expect(contains(await rawPixels(readImage), MAGENTA)).toBe(false);
    }
  });

  it('masks before rotating, so a turned card is clean too', async () => {
    const { image, left, right } = await twoCards();
    const [crop] = await cropCards(image, located([{ box: left, rotation: 90 }, { box: right, rotation: 0 }]), path.join(dir, 'pair-turned'));
    expect(crop!.height).toBeGreaterThan(crop!.width);
    const pixels = await rawPixels(crop!.path);
    expect(contains(pixels, MAGENTA)).toBe(false);
    expect(contains(pixels, GREEN)).toBe(true);
  });

  it('leaves every pixel of the card\'s own box untouched', async () => {
    const { image, left, right } = await twoCards();
    const [alone] = await cropCards(image, located([{ box: left, rotation: 0 }]), path.join(dir, 'own-alone'));
    const [masked] = await cropCards(image, located([{ box: left, rotation: 0 }, { box: right, rotation: 0 }]), path.join(dir, 'own-masked'));

    const before = await rawPixels(alone!.path);
    const after = await rawPixels(masked!.path);
    expect(contains(after, GREEN)).toBe(true);
    for (let y = MARGIN; y < after.height - MARGIN; y += 1) {
      for (let x = MARGIN; x < MARGIN + left.width; x += 1) {
        expect(isNear(pixelAt(after, x, y), pixelAt(before, x, y), 30)).toBe(true);
      }
    }
  });

  it('cleans all four sides in a tight grid, and paints only what belongs to a neighbour', async () => {
    const colours: Rgb[] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 255, 255], [0, 255, 255], [255, 0, 255], [255, 128, 0], [128, 0, 255]];
    const grid = gridBoxes({ columns: 3, rows: 3, cardWidth: 300, cardHeight: 170, gap: 2, margin: 20 });
    const layers = grid.boxes.map((box, index) => block(box.width, box.height, colours[index]!, box.x, box.y));
    const sheet = await saveNormalized(await canvas(grid.width, grid.height, '#000000').composite(layers).png().toBuffer(), path.join(dir, 'tight.jpg'));

    const crops = await cropCards(sheet, located(grid.boxes.map((box) => ({ box, rotation: 0 }))), path.join(dir, 'tight'));

    const middle = await rawPixels(crops[4]!.path);
    for (const [index, colour] of colours.entries()) {
      if (index !== 4) expect(contains(middle, colour)).toBe(false);
    }
    expect(crops.some((crop) => crop.quality.issues.includes('location_uncertain'))).toBe(false);
    // The card's corner is outside every neighbour's box but the diagonal one, so it is painted too.
    expect(isNear(pixelAt(middle, 2, 2), [128, 128, 128], 30)).toBe(true);
    expect(isNear(pixelAt(middle, middle.width >> 1, middle.height >> 1), [255, 255, 255], 12)).toBe(true);
  }, 60_000);

  it('does not mask or flag when a card has no neighbour', async () => {
    const { image, left } = await twoCards();
    const [crop] = await cropCards(image, located([{ box: left, rotation: 0 }]), path.join(dir, 'single'));
    const region = { left: left.x - 16, top: left.y - 10, width: 432, height: 248 };
    const untouched = await sharp(image.path).extract(region).jpeg(MASTER_JPEG).toBuffer();

    expect(await readFile(crop!.path)).toEqual(untouched);
    expect(crop!.quality.issues).not.toContain('location_uncertain');
  });

  it('measures quality before masking: painting the margin changes no score', async () => {
    const { image, left, right } = await twoCards();
    const [alone] = await cropCards(image, located([{ box: left, rotation: 0 }]), path.join(dir, 'score-alone'));
    const [masked] = await cropCards(image, located([{ box: left, rotation: 0 }, { box: right, rotation: 0 }]), path.join(dir, 'score-masked'));
    expect(masked!.quality).toEqual(alone!.quality);
  });

  describe('physically overlapping cards', () => {
    const under = { x: 100, y: 100, width: 300, height: 180 };
    const top = { x: 280, y: 130, width: 300, height: 180 };

    it('flags both cards for a person and keeps the box intact', async () => {
      const png = await canvas(800, 500).composite([block(300, 180, [255, 255, 255], under.x, under.y), block(300, 180, MAGENTA, top.x, top.y)]).png().toBuffer();
      const image = await saveNormalized(png, path.join(dir, 'overlap.jpg'));

      const crops = await cropCards(image, located([{ box: under, rotation: 0 }, { box: top, rotation: 0 }]), path.join(dir, 'overlap'));

      for (const crop of crops) {
        expect(crop.quality.issues).toContain('location_uncertain');
        expect(crop.quality.ok).toBe(false);
      }
      // The top card still shows inside this card's own box, because masking there could hide its print.
      const marginX = Math.ceil(300 * CONFIG.image.cropMarginRatio);
      const marginY = Math.ceil(180 * CONFIG.image.cropMarginRatio);
      const inOwnBox = pixelAt(await rawPixels(crops[0]!.path), marginX + 290, marginY + 90);
      expect(isNear(inOwnBox, MAGENTA, 40)).toBe(true);
    });

    it('still paints the neighbour outside the box', async () => {
      const png = await canvas(800, 500).composite([block(300, 180, [255, 255, 255], under.x, under.y), block(300, 180, MAGENTA, top.x, top.y)]).png().toBuffer();
      const image = await saveNormalized(png, path.join(dir, 'overlap-mask.jpg'));
      const [crop] = await cropCards(image, located([{ box: under, rotation: 0 }, { box: top, rotation: 0 }]), path.join(dir, 'overlap-mask'));
      const pixels = await rawPixels(crop!.path);
      expect(isNear(pixelAt(pixels, pixels.width - 3, pixels.height >> 1), [128, 128, 128], 30)).toBe(true);
    });

    it.each([
      ['touching boxes', 400],
      ['boxes overlapping by 5%, as imprecise boxes in a tidy grid do', 385],
      ['boxes overlapping by exactly the tolerance', 370],
    ])('does not flag %s', async (_label, x) => {
      const image = await saveNormalized(await canvas(800, 400).png().toBuffer(), path.join(dir, `tidy-${x}.jpg`));
      const crops = await cropCards(image, located([{ box: { x: 100, y: 100, width: 300, height: 180 }, rotation: 0 }, { box: { x, y: 100, width: 300, height: 180 }, rotation: 0 }]), path.join(dir, `tidy-${x}`));
      expect(crops.map((crop) => crop.quality.issues.includes('location_uncertain'))).toEqual([false, false]);
    });

    it('flags boxes just past the tolerance', async () => {
      const image = await saveNormalized(await canvas(800, 400).png().toBuffer(), path.join(dir, 'tidy-over.jpg'));
      const crops = await cropCards(image, located([{ box: { x: 100, y: 100, width: 300, height: 180 }, rotation: 0 }, { box: { x: 368, y: 100, width: 300, height: 180 }, rotation: 0 }]), path.join(dir, 'tidy-over'));
      expect(crops.map((crop) => crop.quality.issues.includes('location_uncertain'))).toEqual([true, true]);
    });

    it('catches a small card lying on a large one, for the large card too', async () => {
      const image = await saveNormalized(await canvas(800, 500).png().toBuffer(), path.join(dir, 'small-on-large.jpg'));
      const crops = await cropCards(image, located([{ box: { x: 50, y: 50, width: 600, height: 400 }, rotation: 0 }, { box: { x: 500, y: 300, width: 100, height: 100 }, rotation: 0 }]), path.join(dir, 'small-on-large'));
      expect(crops.map((crop) => crop.quality.issues.includes('location_uncertain'))).toEqual([true, true]);
    });
  });
});

describe('decoding', () => {
  it('decodes the photo once, however many cards it holds', async () => {
    const grid = gridBoxes({ columns: 6, rows: 6, cardWidth: 120, cardHeight: 70, gap: 4, margin: 4 });
    const photo = await saveNormalized(await canvas(grid.width, grid.height).png().toBuffer(), path.join(dir, 'once.jpg'));

    openedPaths.length = 0;
    const crops = await cropCards(photo, located(grid.boxes.map((box) => ({ box, rotation: 0 }))), path.join(dir, 'once'));

    expect(crops).toHaveLength(36);
    expect(openedPaths).toEqual([photo.path]);
  });
});
