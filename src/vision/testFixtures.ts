/** Fixtures generated at test time, so no binary images are checked in. Used by tests only. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type {
  CardLocation,
  LlmCallContext,
  LlmClient,
  LlmParseRequest,
  LlmParseResult,
  LlmUsage,
  LocateWireResult,
  NormalizedImage,
  Rotation,
} from '../shared/contracts.ts';

export const CARD_ASPECT = 3.5 / 2;
export const LOCATE_CTX: LlmCallContext = { jobId: 'job-1', purpose: 'locate', fileId: 'file-1' };

const NO_USAGE: LlmUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 };

export async function withTempDir(prefix: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), `vision-${prefix}-`));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface CardStyle {
  background: string;
  ink: string;
  accent: string;
  name: string;
  title: string;
  company: string;
  email: string;
  phone: string;
  website: string;
}

export const LIGHT_CARD: CardStyle = {
  background: '#ffffff',
  ink: '#1a1a1a',
  accent: '#0b5cad',
  name: 'Priya Raghunathan',
  title: 'Director of Engineering',
  company: 'Northwind Trading Co.',
  email: 'priya.r@northwind.example',
  phone: '+91 98765 43210',
  website: 'www.northwind.example',
};

export const DARK_CARD: CardStyle = {
  ...LIGHT_CARD,
  background: '#14171c',
  ink: '#f2f2f2',
  accent: '#e8b64c',
};

/** Card sized in real points: a 3.5in wide card is 252pt, and contact lines are 7pt. */
export function cardSvg(style: CardStyle, width: number): string {
  const height = Math.round(width / CARD_ASPECT);
  const pt = width / 252;
  const line = (y: number, size: number, text: string, fill: string, weight = 'normal') =>
    `<text x="${14 * pt}" y="${y * pt}" font-family="Helvetica, Arial, sans-serif" font-size="${size * pt}" font-weight="${weight}" fill="${fill}">${text}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="${style.background}"/>
    ${line(34, 14, style.name, style.ink, 'bold')}
    ${line(48, 8, style.title, style.accent)}
    ${line(62, 8, style.company, style.ink)}
    ${line(100, 7, style.email, style.ink)}
    ${line(111, 7, style.phone, style.ink)}
    ${line(122, 7, style.website, style.ink)}
  </svg>`;
}

export function renderCard(style: CardStyle, width: number): Promise<Buffer> {
  return sharp(Buffer.from(cardSvg(style, width))).png().toBuffer();
}

/** The upright image behind every orientation test: four differently coloured corners. */
export const CORNERS = {
  topLeft: [220, 30, 30],
  topRight: [30, 200, 30],
  bottomLeft: [30, 30, 220],
  bottomRight: [240, 240, 240],
} as const;
export type Rgb = readonly [number, number, number];

export function cornerColourAt(x: number, y: number, width: number, height: number): Rgb {
  const right = x >= width / 2;
  const bottom = y >= height / 2;
  if (bottom) return right ? CORNERS.bottomRight : CORNERS.bottomLeft;
  return right ? CORNERS.topRight : CORNERS.topLeft;
}

export function cornersRaw(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      pixels.set(cornerColourAt(x, y, width, height), (y * width + x) * 3);
    }
  }
  return pixels;
}

export async function rawPixels(input: string | Buffer) {
  const { data, info } = await sharp(input).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

export type RawImage = Awaited<ReturnType<typeof rawPixels>>;

export function pixelAt(image: RawImage, x: number, y: number): Rgb {
  const at = (y * image.width + x) * image.channels;
  return [image.data[at]!, image.data[at + 1]!, image.data[at + 2]!];
}

export function isNear(actual: Rgb, expected: Rgb, tolerance = 40): boolean {
  return actual.every((value, index) => Math.abs(value - expected[index]!) <= tolerance);
}

/** Asserts-friendly: which corner colours sit where, sampled well inside each quadrant. */
export function cornersMatch(image: RawImage): boolean {
  const { width, height } = image;
  const near = (fx: number, fy: number) => pixelAt(image, Math.floor(width * fx), Math.floor(height * fy));
  return (
    isNear(near(0.2, 0.2), CORNERS.topLeft) &&
    isNear(near(0.8, 0.2), CORNERS.topRight) &&
    isNear(near(0.2, 0.8), CORNERS.bottomLeft) &&
    isNear(near(0.8, 0.8), CORNERS.bottomRight)
  );
}

/** Pixels turned anticlockwise, so that turning them `rotation` clockwise makes them upright. */
export function tiltedAwayBy(rotation: Rotation, image: Buffer): Promise<Buffer> {
  return sharp(image).rotate((360 - rotation) % 360).png().toBuffer();
}

export async function saveNormalized(image: Buffer, filePath: string): Promise<NormalizedImage> {
  const info = await sharp(image).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(filePath);
  return { path: filePath, width: info.width, height: info.height, sourceFormat: 'jpeg' };
}

/** Solid-coloured cards in a grid, touching when gap is 0. Returns where each card really is. */
export function gridBoxes(options: {
  columns: number;
  rows: number;
  cardWidth: number;
  cardHeight: number;
  gap: number;
  margin: number;
}) {
  const { columns, rows, cardWidth, cardHeight, gap, margin } = options;
  const boxes: Array<CardLocation['box']> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      boxes.push({ x: margin + column * (cardWidth + gap), y: margin + row * (cardHeight + gap), width: cardWidth, height: cardHeight });
    }
  }
  return {
    boxes,
    width: margin * 2 + columns * cardWidth + (columns - 1) * gap,
    height: margin * 2 + rows * cardHeight + (rows - 1) * gap,
  };
}

/** A pixel box as the 0-1000 coordinates the model reports. */
export function toWire(box: CardLocation['box'], image: { width: number; height: number }, rotation: Rotation = 0) {
  return {
    x_min: (box.x / image.width) * 1000,
    y_min: (box.y / image.height) * 1000,
    x_max: ((box.x + box.width) / image.width) * 1000,
    y_max: ((box.y + box.height) / image.height) * 1000,
    rotation,
  };
}

export const NO_CARD_ANSWER: LocateWireResult = { contains_card: false, cards: [] };

export function cardsAnswer(cards: LocateWireResult['cards']): LocateWireResult {
  return { contains_card: true, cards };
}

type PassAnswer = LocateWireResult | { failure: 'refused' | 'incomplete' | 'schema_invalid' | 'retries_exhausted' } | Error | unknown;

export interface RecordedCall {
  request: LlmParseRequest<unknown>;
  ctx: LlmCallContext;
}

/**
 * Fake model. Answers each locate pass in turn. Passing one answer uses it for
 * both passes. Passing an Error makes that call throw.
 */
export function fakeLlm(...answers: PassAnswer[]): LlmClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const parse = async <T>(request: LlmParseRequest<T>, ctx: LlmCallContext): Promise<LlmParseResult<T>> => {
    const answer = answers[Math.min(calls.length, answers.length - 1)];
    calls.push({ request: request as LlmParseRequest<unknown>, ctx });
    if (answer instanceof Error) throw answer;
    const base = { usage: NO_USAGE, latencyMs: 1, attempts: 1 };
    if (answer && typeof answer === 'object' && 'failure' in answer) {
      return { ok: false, failure: (answer as { failure: 'refused' }).failure, detail: 'fake failure', ...base };
    }
    return { ok: true, value: answer as T, model: 'gpt-6-luna', ...base };
  };
  return { calls, parse };
}
