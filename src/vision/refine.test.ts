import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CardLocation, NormalizedImage } from '../shared/contracts.ts';
import { refineBoxes } from './refine.ts';
import { gridBoxes, saveNormalized, withTempDir } from './testFixtures.ts';

type Box = CardLocation['box'];

let dir: string;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ dir, cleanup } = await withTempDir('refine'));
});
afterAll(() => cleanup());

let counter = 0;
/** Light cards on a dark table. Where cards touch, a thin dark line stays between them, as a real seam does. */
async function scene(width: number, height: number, cards: Box[]): Promise<NormalizedImage> {
  const png = await sharp({ create: { width, height, channels: 3, background: '#4a4a4a' } })
    .composite(cards.map((card) => ({ input: { create: { width: card.width, height: card.height, channels: 3 as const, background: '#f0f0f0' } }, left: card.x, top: card.y })))
    .png()
    .toBuffer();
  counter += 1;
  return saveNormalized(png, path.join(dir, `scene-${counter}.jpg`));
}

const at = (box: Box): CardLocation => ({ box, rotation: 0 });
const near = (actual: Box, expected: Box, tolerance = 3) => {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.height - expected.height)).toBeLessThanOrEqual(tolerance);
};

const GRID = gridBoxes({ columns: 2, rows: 2, cardWidth: 300, cardHeight: 170, gap: 3, margin: 80 });

describe('refineBoxes', () => {
  it('returns nothing for no boxes', async () => {
    const image = await scene(400, 300, []);
    expect(await refineBoxes(image, [])).toEqual([]);
  });

  it('leaves boxes that match the cards alone, and flags nothing', async () => {
    const image = await scene(GRID.width, GRID.height, GRID.boxes);
    const refined = await refineBoxes(image, GRID.boxes.map(at));
    expect(refined.map(({ suspect }) => suspect)).toEqual([null, null, null, null]);
    refined.forEach(({ location }, index) => near(location.box, GRID.boxes[index]!));
  });

  it('flags nothing on a lone card', async () => {
    const card = { x: 150, y: 120, width: 300, height: 170 };
    const image = await scene(600, 420, [card]);
    const [only] = await refineBoxes(image, [at(card)]);
    expect(only!.suspect).toBeNull();
  });

  it('snaps edges that are a little off onto the card outline', async () => {
    const card = { x: 150, y: 120, width: 300, height: 170 };
    const image = await scene(600, 420, [card]);
    const off = { x: card.x + 9, y: card.y - 6, width: card.width - 14, height: card.height + 12 };
    const [only] = await refineBoxes(image, [at(off)]);
    near(only!.location.box, card, 4);
    expect(only!.suspect).toBeNull();
  });

  it('flags a box that holds half of each of two touching cards', async () => {
    const image = await scene(GRID.width, GRID.height, GRID.boxes);
    const [left, right] = GRID.boxes;
    const straddler = { x: left!.x + left!.width / 2, y: left!.y, width: left!.width, height: left!.height };
    expect(straddler.x + straddler.width).toBeGreaterThan(right!.x);
    const [only] = await refineBoxes(image, [at(straddler)]);
    expect(only!.suspect).toBe('contains_seam');
  });

  it('flags a box that stops short of the card it is on', async () => {
    const card = { x: 150, y: 120, width: 300, height: 170 };
    const image = await scene(700, 420, [card]);
    const clipped = { x: card.x, y: card.y, width: Math.round(card.width * 0.75), height: card.height };
    const [only] = await refineBoxes(image, [at(clipped)]);
    expect(only!.suspect).toBe('clipped');
  });

  it('does not take a neighbour card for the edge of a clipped box', async () => {
    const image = await scene(GRID.width, GRID.height, GRID.boxes);
    const refined = await refineBoxes(image, GRID.boxes.map(at));
    // Neighbours sit within the search reach of every side, but their outlines are theirs.
    expect(refined.filter(({ suspect }) => suspect === 'clipped')).toHaveLength(0);
  });

  it('flags a box far from the size of the rest', async () => {
    const cards = gridBoxes({ columns: 4, rows: 1, cardWidth: 200, cardHeight: 114, gap: 40, margin: 60 });
    const image = await scene(cards.width, cards.height + 200, cards.boxes);
    const boxes = cards.boxes.map(at);
    boxes[3] = at({ ...boxes[3]!.box, width: 520, height: 320 });
    const refined = await refineBoxes(image, boxes);
    expect(refined[3]!.suspect).not.toBeNull();
    expect(refined.slice(0, 3).map(({ suspect }) => suspect)).toEqual([null, null, null]);
  });
});
