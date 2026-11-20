import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { zodTextFormat } from 'openai/helpers/zod';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../shared/config.ts';
import { JobPauseError, SCHEMA_NAMES } from '../shared/contracts.ts';
import type { CardLocation, NormalizedImage, Rotation } from '../shared/contracts.ts';
import { locateCards, LocateWireSchema, readingOrder } from './locate.ts';
import {
  cardsAnswer,
  cornersRaw,
  fakeLlm,
  gridBoxes,
  LOCATE_CTX,
  NO_CARD_ANSWER,
  saveNormalized,
  toWire,
  withTempDir,
} from './testFixtures.ts';

let dir: string;
let cleanup: () => Promise<void>;
let image: NormalizedImage;

/** A plain 500x500 frame, so one wire unit is half a pixel. Small, because every test encodes two pass images. */
beforeAll(async () => {
  ({ dir, cleanup } = await withTempDir('locate'));
  const png = await sharp({ create: { width: 500, height: 500, channels: 3, background: '#6a6f75' } }).png().toBuffer();
  image = await saveNormalized(png, path.join(dir, 'frame.jpg'));
});
afterAll(() => cleanup());

const box = (x_min: number, y_min: number, x_max: number, y_max: number, rotation: Rotation = 0) => ({ x_min, y_min, x_max, y_max, rotation });
const CARD_A = box(100, 100, 400, 280);
const CARD_B = box(550, 100, 850, 280);
const CARD_C = box(100, 500, 400, 680);
const WHOLE_IMAGE = { x: 0, y: 0, width: 500, height: 500 };

function expectFallback(result: Awaited<ReturnType<typeof locateCards>>) {
  expect(result).toMatchObject({ noCard: false, fellBackToFullImage: true, countConfirmed: false });
  expect(result.locations).toEqual([{ box: WHOLE_IMAGE, rotation: 0 }]);
  expect(result.note).toBeTruthy();
}

describe('two passes', () => {
  it('sends two different images with the right schema, effort and limit', async () => {
    const detailed = await saveNormalized(
      await sharp(cornersRaw(400, 300), { raw: { width: 400, height: 300, channels: 3 } }).linear(0.5, 40).png().toBuffer(),
      path.join(dir, 'detailed.jpg'),
    );
    const llm = fakeLlm(cardsAnswer([CARD_A]));
    const seen: Array<{ bytes: Buffer; width: number }> = [];
    const spying = {
      parse: async (request: Parameters<typeof llm.parse>[0], ctx: Parameters<typeof llm.parse>[1]) => {
        const { data, info } = await sharp(request.imagePaths[0]!).raw().toBuffer({ resolveWithObject: true });
        seen.push({ bytes: data, width: info.width });
        return llm.parse(request, ctx);
      },
    };

    await locateCards(spying as typeof llm, detailed, LOCATE_CTX);

    expect(llm.calls).toHaveLength(2);
    for (const { request, ctx } of llm.calls) {
      expect(request.schemaName).toBe(SCHEMA_NAMES.locate);
      expect(request.reasoningEffort).toBe(CONFIG.reasoningEffort.locate);
      expect(request.maxOutputTokens).toBe(CONFIG.maxOutputTokens.locate);
      expect(request.imagePaths).toHaveLength(1);
      expect(ctx).toBe(LOCATE_CTX);
    }
    expect(llm.calls[0]!.request.imagePaths[0]).not.toBe(llm.calls[1]!.request.imagePaths[0]);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.bytes.equals(seen[1]!.bytes)).toBe(false);
  });

  it('downscales a large image to the locate size and never enlarges a small one', async () => {
    const big = await sharp({ create: { width: 3200, height: 400, channels: 3, background: '#777777' } }).png().toBuffer();
    const large = await saveNormalized(big, path.join(dir, 'big.jpg'));
    const widths: number[] = [];
    const parse = async (request: { imagePaths: string[] }) => {
      widths.push((await sharp(request.imagePaths[0]!).metadata()).width);
      return { ok: false as const, failure: 'refused' as const, detail: 'x', usage: null, latencyMs: 0, attempts: 1 };
    };
    await locateCards({ parse } as never, large, LOCATE_CTX);
    expect(widths).toEqual([CONFIG.image.locateLongEdge, CONFIG.image.locateLongEdge]);

    widths.length = 0;
    await locateCards({ parse } as never, image, LOCATE_CTX);
    expect(widths).toEqual([500, 500]);
  });

  it('removes its pass images afterwards, even when a call fails', async () => {
    const before = await readdir(dir);
    await locateCards(fakeLlm(new Error('boom'), cardsAnswer([CARD_A])), image, LOCATE_CTX);
    expect(await readdir(dir)).toEqual(before);
  });

  it('has a schema the OpenAI SDK accepts as strict structured output', () => {
    const format = zodTextFormat(LocateWireSchema, SCHEMA_NAMES.locate);
    expect(format.name).toBe('card_locations');
    expect(format.strict).toBe(true);
    expect(JSON.stringify(format.schema)).toContain('x_min');
  });
});

describe('agreement', () => {
  it('confirms one card found by both passes', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer([CARD_A])), image, LOCATE_CTX);
    expect(result).toMatchObject({ noCard: false, fellBackToFullImage: false, countConfirmed: true, note: null });
    expect(result.locations).toEqual([{ box: { x: 50, y: 50, width: 150, height: 90 }, rotation: 0 }]);
  });

  it('treats small differences between the passes as the same card, keeping the box that encloses both', async () => {
    const nudged = box(106, 94, 410, 286);
    const result = await locateCards(fakeLlm(cardsAnswer([CARD_A]), cardsAnswer([nudged])), image, LOCATE_CTX);
    expect(result.countConfirmed).toBe(true);
    expect(result.locations).toEqual([{ box: { x: 50, y: 47, width: 155, height: 96 }, rotation: 0 }]);
  });

  it('matches cards whatever order each pass lists them in', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer([CARD_A, CARD_B, CARD_C]), cardsAnswer([CARD_C, CARD_A, CARD_B])), image, LOCATE_CTX);
    expect(result.countConfirmed).toBe(true);
    expect(result.locations).toHaveLength(3);
  });

  it.each([0, 90, 180, 270] as Rotation[])('carries rotation %i through', async (rotation) => {
    const result = await locateCards(fakeLlm(cardsAnswer([{ ...CARD_A, rotation }])), image, LOCATE_CTX);
    expect(result.locations[0]!.rotation).toBe(rotation);
    expect(result.countConfirmed).toBe(true);
  });

  it('flags a rotation disagreement and uses the natural image pass', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer([{ ...CARD_A, rotation: 90 }]), cardsAnswer([{ ...CARD_A, rotation: 180 }])), image, LOCATE_CTX);
    expect(result.countConfirmed).toBe(false);
    expect(result.locations[0]!.rotation).toBe(90);
    expect(result.note).toMatch(/rotation/);
  });
});

describe('disagreement', () => {
  it('rescues a card only pass 1 found', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer([CARD_A, CARD_B]), cardsAnswer([CARD_A])), image, LOCATE_CTX);
    expect(result.countConfirmed).toBe(false);
    expect(result.locations).toHaveLength(2);
    expect(result.fellBackToFullImage).toBe(false);
    expect(result.note).toMatch(/pass 1 found 2 cards and pass 2 found 1 card/);
    expect(result.note).toMatch(/1 seen only by pass 1/);
  });

  it('rescues a card only pass 2 found', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer([CARD_A]), cardsAnswer([CARD_A, CARD_B])), image, LOCATE_CTX);
    expect(result.countConfirmed).toBe(false);
    expect(result.locations.map(({ box: { x } }) => x)).toEqual([50, 275]);
    expect(result.note).toMatch(/1 seen only by pass 2/);
  });

  it('keeps the union when the passes each miss a different card, even with equal counts', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer([CARD_A, CARD_B]), cardsAnswer([CARD_A, CARD_C])), image, LOCATE_CTX);
    expect(result.countConfirmed).toBe(false);
    expect(result.locations).toHaveLength(3);
    expect(result.note).toMatch(/same number in different places/);
  });

  it('never confirms when both passes disagree on a big count, and loses nothing', async () => {
    const grid = gridBoxes({ columns: 6, rows: 6, cardWidth: 120, cardHeight: 120, gap: 6, margin: 16 });
    const wholeGrid = await saveNormalized(await sharp({ create: { width: grid.width, height: grid.height, channels: 3, background: '#555555' } }).png().toBuffer(), path.join(dir, 'count.jpg'));
    const wire = grid.boxes.map((cardBox) => toWire(cardBox, grid));
    const missingThree = wire.filter((_, index) => ![4, 17, 30].includes(index));
    const missingTwo = wire.filter((_, index) => ![9, 22].includes(index));

    const result = await locateCards(fakeLlm(cardsAnswer(missingThree), cardsAnswer(missingTwo)), wholeGrid, LOCATE_CTX);

    expect(result.countConfirmed).toBe(false);
    expect(result.locations).toHaveLength(36);
    expect(result.note).toMatch(/pass 1 found 33 cards and pass 2 found 34 cards/);
  });

  it('keeps cards when one pass says there are none', async () => {
    for (const answers of [[NO_CARD_ANSWER, cardsAnswer([CARD_A])], [cardsAnswer([CARD_A]), NO_CARD_ANSWER]]) {
      const result = await locateCards(fakeLlm(...answers), image, LOCATE_CTX);
      expect(result).toMatchObject({ noCard: false, fellBackToFullImage: false, countConfirmed: false });
      expect(result.locations).toHaveLength(1);
      expect(result.note).toMatch(/saw no card/);
    }
  });

  it('does not let a whole-image box from one pass swallow the cards found by the other', async () => {
    const whole = box(0, 0, 1000, 1000);
    const result = await locateCards(fakeLlm(cardsAnswer([whole]), cardsAnswer([CARD_A, CARD_B, CARD_C])), image, LOCATE_CTX);
    expect(result.countConfirmed).toBe(false);
    expect(result.locations).toHaveLength(3);
  });
});

describe('no card', () => {
  it('says no card only when both passes agree', async () => {
    const result = await locateCards(fakeLlm(NO_CARD_ANSWER), image, LOCATE_CTX);
    expect(result).toMatchObject({ noCard: true, locations: [], fellBackToFullImage: false, countConfirmed: true });
  });

  it('falls back when the only opinion left says no card, because one pass is not enough', async () => {
    for (const answers of [[NO_CARD_ANSWER, { failure: 'refused' }], [{ failure: 'incomplete' }, NO_CARD_ANSWER]]) {
      expectFallback(await locateCards(fakeLlm(...answers), image, LOCATE_CTX));
    }
  });

  it('does not trust an answer that contradicts itself', async () => {
    const saysNoneButBoxes = { contains_card: false, cards: [CARD_A] };
    const result = await locateCards(fakeLlm(saysNoneButBoxes, NO_CARD_ANSWER), image, LOCATE_CTX);
    expect(result.noCard).toBe(false);
    expectFallback(result);
  });
});

describe('failed passes', () => {
  it.each([
    ['pass 1', { failure: 'incomplete' }, cardsAnswer([CARD_A, CARD_B])],
    ['pass 2', cardsAnswer([CARD_A, CARD_B]), { failure: 'schema_invalid' }],
  ])('uses the other pass when %s fails, without confirming', async (_label, first, second) => {
    const result = await locateCards(fakeLlm(first, second), image, LOCATE_CTX);
    expect(result).toMatchObject({ noCard: false, fellBackToFullImage: false, countConfirmed: false });
    expect(result.locations).toHaveLength(2);
    expect(result.note).toMatch(/could not be confirmed/);
  });

  it('uses the other pass when one call throws unexpectedly', async () => {
    const result = await locateCards(fakeLlm(new Error('socket hang up'), cardsAnswer([CARD_A])), image, LOCATE_CTX);
    expect(result).toMatchObject({ fellBackToFullImage: false, countConfirmed: false });
    expect(result.note).toMatch(/socket hang up/);
  });

  it.each(['refused', 'incomplete', 'schema_invalid', 'retries_exhausted'])('falls back when both passes fail with %s', async (failure) => {
    const result = await locateCards(fakeLlm({ failure }), image, LOCATE_CTX);
    expectFallback(result);
    expect(result.note).toContain(failure);
  });

  it('falls back when both calls throw', async () => {
    expectFallback(await locateCards(fakeLlm(new Error('down')), image, LOCATE_CTX));
  });

  it.each([
    ['missing fields', { contains_card: true }],
    ['wrong types', { contains_card: 'yes', cards: 'many' }],
    ['a rotation that is not a right angle', { contains_card: true, cards: [{ ...CARD_A, rotation: 45 }] }],
    ['null', null],
    ['says cards but gives none', { contains_card: true, cards: [] }],
  ])('falls back on %s', async (_label, answer) => {
    expectFallback(await locateCards(fakeLlm(answer), image, LOCATE_CTX));
  });
});

describe('JobPauseError', () => {
  const pause = new JobPauseError('out_of_credit', 'No credit left');

  it.each([
    ['both passes', [pause, pause]],
    ['pass 1 only', [pause, cardsAnswer([CARD_A])]],
    ['pass 2 only', [cardsAnswer([CARD_A]), pause]],
    ['alongside an ordinary failure', [new Error('boom'), pause]],
  ])('propagates from %s', async (_label, answers) => {
    await expect(locateCards(fakeLlm(...answers), image, LOCATE_CTX)).rejects.toBe(pause);
  });

  it('still cleans up its pass images', async () => {
    const before = await readdir(dir);
    await locateCards(fakeLlm(pause), image, LOCATE_CTX).catch(() => {});
    expect(await readdir(dir)).toEqual(before);
  });

  it('stops a cancelled job rather than recording a fallback', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const ctx = { ...LOCATE_CTX, signal: controller.signal };
    await expect(locateCards(fakeLlm(new Error('aborted')), image, ctx)).rejects.toThrow('cancelled');
  });
});

describe('bad boxes', () => {
  const inverted = box(400, 100, 100, 280);
  const flat = box(100, 100, 400, 100);
  const tiny = box(100, 100, 104, 104);
  const strip = box(0, 500, 1000, 540);
  const offScale = box(1500, 1500, 2500, 2200);
  const wholeBadSet = [inverted, flat, tiny, strip, offScale];

  it.each([
    ['inverted', inverted],
    ['zero height', flat],
    ['tiny', tiny],
    ['implausibly shaped', strip],
    ['off the scale', offScale],
    ['entirely outside the image', box(1005, 1005, 1020, 1020)],
  ])('falls back when the only box in both passes is %s', async (_label, bad) => {
    expectFallback(await locateCards(fakeLlm(cardsAnswer([bad])), image, LOCATE_CTX));
  });

  it('names every kind of bad box in the note', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer(wholeBadSet)), image, LOCATE_CTX);
    expectFallback(result);
    expect(result.note).toMatch(/2 inverted/);
    expect(result.note).toMatch(/1 tiny/);
    expect(result.note).toMatch(/1 implausibly shaped/);
    expect(result.note).toMatch(/1 off the 0-1000 scale/);
  });

  it('clamps a box that slightly overshoots the image', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer([box(-8, -5, 420, 300)])), image, LOCATE_CTX);
    expect(result.locations[0]!.box).toEqual({ x: 0, y: 0, width: 210, height: 150 });
    expect(result.countConfirmed).toBe(true);
  });

  it('drops one bad box and keeps the good ones, but will not confirm the count', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer([CARD_A, CARD_B, tiny]), cardsAnswer([CARD_A, CARD_B])), image, LOCATE_CTX);
    expect(result.locations).toHaveLength(2);
    expect(result).toMatchObject({ fellBackToFullImage: false, countConfirmed: false });
    expect(result.note).toMatch(/Pass 1 rejected boxes: 1 tiny/);
  });

  it('uses a card the other pass placed properly when one pass gave a broken box for it', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer([CARD_A, inverted]), cardsAnswer([CARD_A, CARD_B])), image, LOCATE_CTX);
    expect(result.locations).toHaveLength(2);
    expect(result.countConfirmed).toBe(false);
  });

  it('removes a card reported twice, without weakening the count', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer([CARD_A, box(102, 101, 402, 281), CARD_B]), cardsAnswer([CARD_A, CARD_B])), image, LOCATE_CTX);
    expect(result.locations).toHaveLength(2);
    expect(result.countConfirmed).toBe(true);
    expect(result.note).toMatch(/Pass 1 repeated 1 card/);
  });

  it('removes a box inside a card, such as a logo, and keeps the card', async () => {
    const logo = box(120, 120, 220, 200);
    const result = await locateCards(fakeLlm(cardsAnswer([CARD_A, logo]), cardsAnswer([CARD_A])), image, LOCATE_CTX);
    expect(result.locations).toEqual([{ box: { x: 50, y: 50, width: 150, height: 90 }, rotation: 0 }]);
    expect(result.countConfirmed).toBe(false);
    expect(result.note).toMatch(/1 inside another box/);
  });

  it('removes a box around a group of cards and keeps the cards', async () => {
    const group = box(80, 80, 900, 700);
    const answer = cardsAnswer([group, CARD_A, CARD_B, CARD_C]);
    const result = await locateCards(fakeLlm(answer), image, LOCATE_CTX);
    expect(result.locations).toHaveLength(3);
    expect(result.note).toMatch(/1 covering several cards/);
    expect(result.countConfirmed).toBe(false);
  });

  it('keeps fanned cards that overlap by a moderate amount', async () => {
    const fanned = [box(100, 100, 400, 280), box(220, 100, 520, 280)];
    const result = await locateCards(fakeLlm(cardsAnswer(fanned)), image, LOCATE_CTX);
    expect(result.locations).toHaveLength(2);
    expect(result.countConfirmed).toBe(true);
  });
});

describe('many cards', () => {
  const countOf = (columns: number, rows: number) => columns * rows;

  it('finds all 36 cards in a touching 6x6 grid, confirmed despite box jitter', async () => {
    const grid = gridBoxes({ columns: 6, rows: 6, cardWidth: 150, cardHeight: 86, gap: 0, margin: 0 });
    const png = await sharp({ create: { width: grid.width, height: grid.height, channels: 3, background: '#808080' } }).png().toBuffer();
    const sheet = await saveNormalized(png, path.join(dir, 'grid36.jpg'));
    // Each pass is off by up to 0.5% of the image, so neighbours' boxes overlap slightly.
    const jitter = (value: number, seed: number) => value + Math.sin(seed * 7.3) * 5;
    const wire = (shift: number) =>
      grid.boxes.map((cardBox, index) => {
        const { x_min, y_min, x_max, y_max, rotation } = toWire(cardBox, sheet);
        return box(jitter(x_min, index + shift), jitter(y_min, index + 1 + shift), jitter(x_max, index + 2 + shift), jitter(y_max, index + 3 + shift), rotation);
      });

    const result = await locateCards(fakeLlm(cardsAnswer(wire(0)), cardsAnswer(wire(50))), sheet, LOCATE_CTX);

    expect(result.locations).toHaveLength(countOf(6, 6));
    expect(result).toMatchObject({ noCard: false, fellBackToFullImage: false, countConfirmed: true });
  });

  it('has no cap on the count: a 12x12 grid gives 144 cards', async () => {
    const grid = gridBoxes({ columns: 12, rows: 12, cardWidth: 70, cardHeight: 40, gap: 2, margin: 6 });
    const png = await sharp({ create: { width: grid.width, height: grid.height, channels: 3, background: '#808080' } }).png().toBuffer();
    const sheet = await saveNormalized(png, path.join(dir, 'grid144.jpg'));
    const answer = cardsAnswer(grid.boxes.map((cardBox) => toWire(cardBox, sheet)));

    const result = await locateCards(fakeLlm(answer), sheet, LOCATE_CTX);

    expect(result.locations).toHaveLength(countOf(12, 12));
    expect(result.countConfirmed).toBe(true);
  });

  it('keeps an 8-card sheet as 8 cards', async () => {
    const grid = gridBoxes({ columns: 2, rows: 4, cardWidth: 170, cardHeight: 96, gap: 8, margin: 6 });
    const png = await sharp({ create: { width: grid.width, height: grid.height, channels: 3, background: '#f4f4f4' } }).png().toBuffer();
    const sheet = await saveNormalized(png, path.join(dir, 'sheet8.jpg'));
    const answer = cardsAnswer(grid.boxes.map((cardBox) => toWire(cardBox, sheet)));

    const result = await locateCards(fakeLlm(answer), sheet, LOCATE_CTX);

    expect(result.locations).toHaveLength(8);
    expect(result.countConfirmed).toBe(true);
  });
});

describe('readingOrder', () => {
  const at = (x: number, y: number, width = 300, height = 180): CardLocation => ({ box: { x, y, width, height }, rotation: 0 });
  const order = (locations: CardLocation[]) => readingOrder(locations).map((location) => locations.indexOf(location));

  it('reads a neat grid left to right, top to bottom, from any starting order', () => {
    const grid = [at(400, 300), at(0, 0), at(800, 300), at(400, 0), at(0, 300), at(800, 0)];
    expect(readingOrder(grid).map(({ box: { x, y } }) => [x, y])).toEqual([
      [0, 0], [400, 0], [800, 0],
      [0, 300], [400, 300], [800, 300],
    ]);
  });

  it('tolerates uneven rows, where a later card starts slightly higher', () => {
    const row1 = [at(0, 40), at(400, 0), at(800, 60)];
    const row2 = [at(0, 330), at(400, 280), at(800, 300)];
    const shuffled = [row2[2]!, row1[1]!, row2[0]!, row1[2]!, row2[1]!, row1[0]!];
    expect(readingOrder(shuffled)).toEqual([...row1, ...row2]);
  });

  it('copes with a photo tilted a few degrees', () => {
    const drop = Math.tan((3 * Math.PI) / 180) * 320;
    const rows = [0, 1, 2].flatMap((row) => [0, 1, 2, 3, 4].map((column) => at(column * 320, row * 300 + column * drop)));
    const reversed = [...rows].reverse();
    expect(readingOrder(reversed)).toEqual(rows);
  });

  it('keeps cards of different sizes in sensible rows', () => {
    const tall = at(0, 0, 180, 320);
    const wide = at(300, 60, 320, 180);
    const below = at(0, 420, 320, 180);
    expect(order([below, wide, tall])).toEqual([2, 1, 0]);
  });

  it('handles none and one', () => {
    expect(readingOrder([])).toEqual([]);
    const only = at(5, 5);
    expect(readingOrder([only])).toEqual([only]);
  });

  it('is applied to what locate returns', async () => {
    const result = await locateCards(fakeLlm(cardsAnswer([CARD_C, CARD_B, CARD_A])), image, LOCATE_CTX);
    expect(result.locations.map(({ box: { x, y } }) => [x, y])).toEqual([[50, 50], [275, 50], [50, 250]]);
  });
});

