import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { CONFIG } from '../shared/config.ts';
import type { NormalizedImage, QualityIssue, QualityReport } from '../shared/contracts.ts';

/**
 * Every image is measured at this long edge at most, and never enlarged, because
 * enlarging would hide a lack of pixels. It sits at the low_resolution limit: any
 * card that isn't already flagged for size gets measured at exactly this scale, so
 * blur scores compare fairly. Measured at their own size, 650 px crops scored 7x
 * higher than 1000 px crops at the same blur.
 */
export const MEASURE_LONG_EDGE = 750;
/**
 * Blur is scored per tile, taking a high percentile, because text fills little of
 * a card. Averaged over the image, plain card stock or table would read as blur.
 */
const TILE_SIZE = 40;
const TILE_PERCENTILE = 0.98;
/**
 * Long edge a card needs for its 7pt print to be read reliably. Calibrated by
 * rendering 7pt lines in four designs (plain, light weight, serif, dark stock) with
 * camera softness and JPEG, then running OCR: 48 of 48 lines exact at 700 px, 47 at
 * 600, 42 at 500, 32 at 400. 700 is the lowest size tested with no misreads.
 */
const MIN_CARD_LONG_EDGE_PX = 700;
/** Crops carry a margin on both sides, which adds pixels but no card. */
export const MIN_LONG_EDGE_PX = Math.ceil(MIN_CARD_LONG_EDGE_PX * (1 + 2 * CONFIG.image.cropMarginRatio));
/**
 * Calibrated on 480 cards blurred to OCR's failure point. Sharp cards scored 879 or
 * more and were never flagged. Misreads began around 400 and the two ranges overlap
 * by print style, so this limit also sends some soft but readable cards to review.
 */
export const MIN_BLUR_SCORE = 300;
/**
 * Exposure is judged on the darkest and brightest 0.5% of pixels, not the mean,
 * which can't separate a dark card from a dark photo: both average low, but only
 * the card has bright print. Those fractions are small enough to find sparse print.
 */
const SHADOW_FRACTION = 0.005;
const HIGHLIGHT_FRACTION = 0.995;
/** Reads were clean with highlights at 78 and began failing at 52. */
export const MIN_HIGHLIGHT_LEVEL = 80;
/** Reads were clean with shadows at 191 and began failing at 213. */
export const MAX_SHADOW_LEVEL = 200;

export interface PixelMeasure {
  blurScore: number;
  meanLuminance: number;
  /** Luminance of the darkest pixels, 0-255. */
  shadowLevel: number;
  /** Luminance of the brightest pixels, 0-255. */
  highlightLevel: number;
}

function percentileOf(histogram: Uint32Array, total: number, fraction: number): number {
  const target = total * fraction;
  let seen = 0;
  for (let level = 0; level < histogram.length; level += 1) {
    seen += histogram[level]!;
    if (seen >= target) return level;
  }
  return histogram.length - 1;
}

function sharpness(grey: Uint8Array, width: number, height: number): number {
  const tilesAcross = Math.max(1, Math.floor(width / TILE_SIZE));
  const tilesDown = Math.max(1, Math.floor(height / TILE_SIZE));
  const sums = new Float64Array(tilesAcross * tilesDown);
  const counts = new Uint32Array(tilesAcross * tilesDown);
  for (let y = 1; y < height - 1; y += 1) {
    const tileY = Math.min(tilesDown - 1, Math.floor(y / TILE_SIZE));
    for (let x = 1; x < width - 1; x += 1) {
      const at = y * width + x;
      const laplacian = grey[at - width]! + grey[at + width]! + grey[at - 1]! + grey[at + 1]! - 4 * grey[at]!;
      const tile = tileY * tilesAcross + Math.min(tilesAcross - 1, Math.floor(x / TILE_SIZE));
      sums[tile]! += laplacian * laplacian;
      counts[tile]! += 1;
    }
  }
  const variances = [...sums].map((sum, tile) => sum / Math.max(1, counts[tile]!)).sort((a, b) => a - b);
  return variances[Math.floor((variances.length - 1) * TILE_PERCENTILE)] ?? 0;
}

/** Keeps the middle of a greyscale image, dropping `inset` of its size from every side. */
function middleOf(grey: Uint8Array, fullWidth: number, fullHeight: number, inset: number) {
  const left = Math.round(fullWidth * inset);
  const top = Math.round(fullHeight * inset);
  const width = fullWidth - 2 * left;
  const height = fullHeight - 2 * top;
  const middle = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const start = (y + top) * fullWidth + left;
    middle.set(grey.subarray(start, start + width), y * width);
  }
  return { grey: middle, width, height };
}

/** `inset` trims each side after resizing, so the measuring scale doesn't change with it. */
export async function measurePixels(image: Sharp, inset = 0): Promise<PixelMeasure> {
  const { data, info } = await image
    .resize({ width: MEASURE_LONG_EDGE, height: MEASURE_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { grey, width, height } = middleOf(data, info.width, info.height, inset);

  const histogram = new Uint32Array(256);
  let total = 0;
  for (const level of grey) {
    histogram[level]! += 1;
    total += level;
  }
  return {
    blurScore: sharpness(grey, width, height),
    meanLuminance: total / grey.length,
    shadowLevel: percentileOf(histogram, grey.length, SHADOW_FRACTION),
    highlightLevel: percentileOf(histogram, grey.length, HIGHLIGHT_FRACTION),
  };
}

export function buildReport(width: number, height: number, measure: PixelMeasure, extraIssues: QualityIssue[] = []): QualityReport {
  const { blurScore, meanLuminance, shadowLevel, highlightLevel } = measure;
  const issues: QualityIssue[] = [];
  if (Math.max(width, height) < MIN_LONG_EDGE_PX) issues.push('low_resolution');
  if (blurScore < MIN_BLUR_SCORE) issues.push('blurry');
  if (highlightLevel < MIN_HIGHLIGHT_LEVEL) issues.push('too_dark');
  if (shadowLevel > MAX_SHADOW_LEVEL) issues.push('too_bright');
  issues.push(...extraIssues);
  return { ok: issues.length === 0, width, height, blurScore, meanLuminance, issues };
}

export async function assessImageQuality(image: NormalizedImage): Promise<QualityReport> {
  return buildReport(image.width, image.height, await measurePixels(sharp(image.path)));
}
