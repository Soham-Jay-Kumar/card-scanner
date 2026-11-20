/** Small, fast card images for tests, with their exact answers. Needs no browser. */
import sharp from 'sharp';

import type { CardRow } from '../../src/shared/contracts.ts';
import type { FakeCard } from '../fake-openai/server.ts';
import { generatedPerson, perfectRead, rowOf } from '../synth/content.ts';
import type { CardContent } from '../synth/content.ts';
import { applyDegradations } from '../synth/degrade.ts';
import type { Degradation } from '../synth/degrade.ts';
import { bulkCardPng } from '../synth/render.ts';
import { buildSheet } from '../synth/sheets.ts';
import type { PlacedCard, SheetLayout, SheetResolution } from '../synth/sheets.ts';
import type { UploadItem } from './app.ts';

export interface TestCard {
  markerId: number;
  content: CardContent;
  row: CardRow;
  fake: FakeCard;
}

export function testCard(markerId: number, tweak: Partial<CardContent> = {}): TestCard {
  const content = { ...generatedPerson(markerId), ...tweak };
  return { markerId, content, row: rowOf(content), fake: { id: markerId, aspect: 1.75, read: perfectRead(content) } };
}

export async function cardFile(card: TestCard, steps: Degradation[] = [], width = 1100): Promise<UploadItem> {
  const png = await bulkCardPng(card.content, card.markerId, width);
  const bytes = await sharp(await applyDegradations(png, steps)).jpeg({ quality: 92 }).toBuffer();
  return { name: `card-${card.markerId}.jpg`, bytes };
}

export interface SheetFixture extends UploadItem {
  /** Reading order. */
  cards: Array<TestCard & { place: PlacedCard }>;
  width: number;
  height: number;
  cardWidth: number;
}

export async function sheetFile(
  firstId: number,
  count: number,
  options: { layout?: SheetLayout; resolution?: SheetResolution; cardWidth?: number; seed?: number; tweak?: (card: TestCard, index: number) => TestCard } = {},
): Promise<SheetFixture> {
  const { layout = 'grid', resolution = 'high', cardWidth, seed = 1, tweak } = options;
  const cards = Array.from({ length: count }, (_, index) => {
    const card = testCard(firstId + index);
    return tweak ? tweak(card, index) : card;
  });
  const pngs = await Promise.all(cards.map((card) => bulkCardPng(card.content, card.markerId, 900)));
  const sheet = await buildSheet(pngs, { layout, resolution, seed, ...(cardWidth ? { cardWidth } : {}) });
  return {
    name: `sheet-${firstId}-${count}.jpg`,
    bytes: sheet.image,
    width: sheet.width,
    height: sheet.height,
    cardWidth: sheet.cardWidth,
    cards: sheet.placed.map((place) => ({ ...cards[place.index]!, place })),
  };
}
