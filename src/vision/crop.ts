import path from 'node:path';
import sharp from 'sharp';
import { CONFIG } from '../shared/config.ts';
import type { CardCrop, CardLocation, LocateResult, NormalizedImage, QualityIssue } from '../shared/contracts.ts';
import { stemOf, writeFileAtomic } from './files.ts';
import { overlapOfSmaller } from './locate.ts';
import { MASTER_JPEG } from './normalize.ts';
import { buildReport, measurePixels } from './quality.ts';

/**
 * Blur and exposure are judged inside the card. Its outline against the table is
 * the strongest edge in the crop, so including it makes a blurred card look sharp,
 * and the table would be counted as the card's exposure.
 */
const CARD_INTERIOR_INSET = 0.1;
/** Flat grey painted over neighbouring cards, so their print can't reach this card's row. */
const MASK_LEVEL = 128;
/**
 * Above this share of the smaller card, two boxes are cards lying on each other and
 * not just imprecise boxes. Simulated on touching grids with both passes' edges off
 * by up to 0.5% of the image, 10% flagged no card up to 10x10, where 8% flagged 14%.
 */
const MAX_BOX_OVERLAP = 0.1;

type Box = CardLocation['box'];
type Region = ReturnType<typeof withMargin>;

function withMargin(box: Box, imageWidth: number, imageHeight: number) {
  const marginX = box.width * CONFIG.image.cropMarginRatio;
  const marginY = box.height * CONFIG.image.cropMarginRatio;
  const left = Math.max(0, Math.floor(box.x - marginX));
  const top = Math.max(0, Math.floor(box.y - marginY));
  const right = Math.min(imageWidth, Math.ceil(box.x + box.width + marginX));
  const bottom = Math.min(imageHeight, Math.ceil(box.y + box.height + marginY));
  return { left, top, width: right - left, height: bottom - top };
}

/** Paints the part of a neighbouring card inside this crop. Pixels in the card's own box are never touched. */
function maskNeighbour(pixels: Buffer, region: Region, channels: number, own: Box, neighbour: Box): void {
  const right = Math.min(neighbour.x + neighbour.width, region.left + region.width);
  const bottom = Math.min(neighbour.y + neighbour.height, region.top + region.height);
  for (let y = Math.max(neighbour.y, region.top); y < bottom; y += 1) {
    const inOwnRow = y >= own.y && y < own.y + own.height;
    for (let x = Math.max(neighbour.x, region.left); x < right; x += 1) {
      if (inOwnRow && x >= own.x && x < own.x + own.width) continue;
      const at = ((y - region.top) * region.width + (x - region.left)) * channels;
      pixels.fill(MASK_LEVEL, at, at + channels);
    }
  }
}

/**
 * Cuts each card out whole and turns it upright, in the order locate gave.
 * The image is decoded once: one photo can hold 30+ cards, and decoding it again
 * for every card would be most of the work. Neighbouring cards are removed from the
 * pixels, because a neighbour's print in the margin can otherwise be read into this
 * card's row by all three reads at once.
 */
export async function cropCards(image: NormalizedImage, locate: LocateResult, outDir: string): Promise<CardCrop[]> {
  if (locate.noCard) return [];
  const wholeImage: CardLocation = { box: { x: 0, y: 0, width: image.width, height: image.height }, rotation: 0 };
  const locations = locate.locations.length > 0 ? locate.locations : [wholeImage];

  const { data, info } = await sharp(image.path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = () => sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });

  const crops: CardCrop[] = [];
  for (const [index, location] of locations.entries()) {
    const region = withMargin(location.box, info.width, info.height);
    const others = locations.filter((other) => other !== location);

    const pixels = await decoded().extract(region).raw().toBuffer();
    for (const other of others) maskNeighbour(pixels, region, info.channels, location.box, other.box);
    const { data: jpeg, info: output } = await sharp(pixels, { raw: { width: region.width, height: region.height, channels: info.channels } })
      .rotate(location.rotation)
      .jpeg(MASTER_JPEG)
      .toBuffer({ resolveWithObject: true });

    const outPath = path.join(outDir, `${stemOf(image.path)}-card-${String(index + 1).padStart(3, '0')}.jpg`);
    await writeFileAtomic(outPath, jpeg);

    // Measured on the unmasked native pixels: enlarging for the reads would hide a lack of them.
    const measure = await measurePixels(decoded().extract(region), CARD_INTERIOR_INSET);
    // Masking stops at the card's own box, so a card lying on this one can't be removed. A person checks it.
    const overlapped = others.some((other) => overlapOfSmaller(location.box, other.box) > MAX_BOX_OVERLAP);
    const issues: QualityIssue[] = locate.fellBackToFullImage || overlapped ? ['location_uncertain'] : [];
    crops.push({
      path: outPath,
      width: output.width,
      height: output.height,
      side: 'single',
      quality: buildReport(output.width, output.height, measure, issues),
    });
  }
  return crops;
}
