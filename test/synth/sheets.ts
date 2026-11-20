/**
 * Many cards on one image: scanner sheets and table photos. Truth records where
 * each card landed, its rotation and its place in reading order.
 */
import sharp from 'sharp';
import type { OverlayOptions } from 'sharp';

import type { Rotation } from '../../src/shared/contracts.ts';

export type SheetLayout = 'grid' | 'uneven' | 'mixed_rotation' | 'overlap' | 'tight';

/**
 * high: a scan where every card keeps about 1,000 px. phone: a 12 MP phone photo.
 * phone_low: the same photo after a messaging app shrinks it. Sharp to look at,
 * but each card has too few pixels.
 */
export type SheetResolution = 'high' | 'phone' | 'phone_low';

const CANVAS: Record<Exclude<SheetResolution, 'high'>, { width: number; height: number; quality: number }> = {
  phone: { width: 4032, height: 3024, quality: 85 },
  phone_low: { width: 2048, height: 1536, quality: 85 },
};
const HIGH_CARD_WIDTH = 1050;
const HIGH_QUALITY = 92;
const BACKGROUND = '#6f7377';
const ASPECT = 1.75;

export interface PlacedCard {
  /** Index into the cards passed in. */
  index: number;
  box: { x: number; y: number; width: number; height: number };
  rotationNeeded: Rotation;
  /** 0-based position in reading order. */
  readingOrder: number;
}

export interface Sheet {
  image: Buffer;
  width: number;
  height: number;
  cardWidth: number;
  /** Listed in reading order. */
  placed: PlacedCard[];
}

/** A repeatable number from 0 up to 1. */
function seeded(seed: number, index: number): number {
  const value = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function rowCounts(count: number, layout: SheetLayout): number[] {
  const columns: number = count > 36 ? 7 : 6;
  const rows = Math.ceil(count / columns);
  if (layout !== 'uneven') {
    const counts = Array.from({ length: rows }, () => columns);
    counts[rows - 1] = count - columns * (rows - 1);
    return counts;
  }
  // Long and short rows in turn, which is how cards end up laid out by hand.
  const counts = Array.from({ length: rows }, (_, row) => (row % 2 === 0 ? columns + 1 : columns - 1));
  let total = counts.reduce((sum, value) => sum + value, 0);
  for (let row = rows - 1; total !== count; row = (row + rows - 1) % rows) {
    const step = total < count ? 1 : -1;
    counts[row]! += step;
    total += step;
  }
  return counts;
}

interface Cell {
  index: number;
  row: number;
  centreX: number;
  centreY: number;
  rotation: 0 | 90 | 180 | 270;
  skew: number;
}

/**
 * Cards go down in rows, so a card's position in `cells` is its reading order.
 * Tight leaves cards nearly touching but not overlapping.
 * Overlap paints later cards over earlier ones, so a card only ever loses its
 * right and bottom edges, which layouts keep clear of text and of the strip.
 */
export async function buildSheet(
  cards: Buffer[],
  options: { layout: SheetLayout; resolution: SheetResolution; seed?: number; cardWidth?: number },
): Promise<Sheet> {
  const { layout, resolution, seed = 1 } = options;
  const counts = rowCounts(cards.length, layout);
  const widest = Math.max(...counts);
  const rows = counts.length;

  const rotates = layout === 'mixed_rotation';
  const overlap = layout === 'overlap';
  // A cell must hold the card however it is turned, and overlap tightens the grid.
  const tight = layout === 'tight';
  const pitchRatioX = rotates ? 1.08 : overlap ? 0.95 : tight ? 1.02 : 1.1;
  const pitchRatioY = rotates ? 1.08 : overlap ? 0.92 / ASPECT : tight ? 1.03 / ASPECT : 1.18 / ASPECT;

  let canvasWidth: number;
  let canvasHeight: number;
  let quality: number;
  let cardWidth: number;
  if (resolution === 'high') {
    cardWidth = options.cardWidth ?? HIGH_CARD_WIDTH;
    canvasWidth = Math.ceil(cardWidth * (pitchRatioX * widest + 0.5));
    canvasHeight = Math.ceil(cardWidth * (pitchRatioY * rows + 0.5));
    quality = HIGH_QUALITY;
  } else {
    ({ width: canvasWidth, height: canvasHeight, quality } = CANVAS[resolution]);
    cardWidth = Math.floor(Math.min(canvasWidth / (pitchRatioX * widest + 0.2), canvasHeight / (pitchRatioY * rows + 0.2)));
  }
  const cardHeight = Math.round(cardWidth / ASPECT);
  const pitchX = cardWidth * pitchRatioX;
  const pitchY = cardWidth * pitchRatioY;
  const originY = (canvasHeight - pitchY * rows) / 2 + pitchY / 2;

  const cells: Cell[] = [];
  let index = 0;
  for (const [row, columns] of counts.entries()) {
    const originX = (canvasWidth - pitchX * columns) / 2 + pitchX / 2;
    for (let column = 0; column < columns; column += 1) {
      const wobble = layout === 'uneven';
      const roll = seeded(seed, index);
      cells.push({
        index,
        row,
        centreX: originX + column * pitchX + (wobble ? (seeded(seed + 1, index) - 0.5) * pitchX * 0.04 : 0),
        centreY: originY + row * pitchY + (wobble ? (seeded(seed + 2, index) - 0.5) * pitchY * 0.08 : 0),
        rotation: rotates ? ([0, 90, 180, 270] as const)[Math.floor(roll * 4)]! : 0,
        skew: wobble ? (roll - 0.5) * 3 : 0,
      });
      index += 1;
    }
  }

  const overlays: OverlayOptions[] = [];
  const placed: PlacedCard[] = [];
  for (const [order, cell] of cells.entries()) {
    let piece = sharp(cards[cell.index]).resize(cardWidth, cardHeight).ensureAlpha();
    if (cell.rotation !== 0) piece = sharp(await piece.png().toBuffer()).rotate(cell.rotation);
    if (cell.skew !== 0) piece = sharp(await piece.png().toBuffer()).rotate(cell.skew, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    const { data, info } = await piece.png().toBuffer({ resolveWithObject: true });
    const left = Math.round(cell.centreX - info.width / 2);
    const top = Math.round(cell.centreY - info.height / 2);
    overlays.push({ input: data, left, top });
    placed.push({
      index: cell.index,
      box: { x: left, y: top, width: info.width, height: info.height },
      rotationNeeded: ((360 - cell.rotation) % 360) as Rotation,
      readingOrder: order,
    });
  }

  const image = await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: BACKGROUND } })
    .composite(overlays)
    .jpeg({ quality })
    .toBuffer();
  return { image, width: canvasWidth, height: canvasHeight, cardWidth, placed };
}
