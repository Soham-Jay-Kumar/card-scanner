/**
 * The coloured strip printed on every synthetic card, which is how the fake
 * OpenAI server knows which card an image shows.
 *
 * Why a strip: read images are cropped, resized, sharpened and re-encoded, so
 * no hash of the file survives. The strip is the only thing that does.
 *
 * How it stays readable:
 *  - Magenta starts the strip and cyan ends it, so direction is known whatever
 *    way up the card is. Locate gets the card's rotation from this.
 *  - Between them are 11 cells in red, yellow, green and blue. No two neighbours
 *    match (each cell's value is its step from the previous colour), so the
 *    decoder only counts colour changes along the line. It never needs cell
 *    positions, which is what makes it immune to scale and perspective.
 *  - 12 bits of ID carry a 5-bit check, so random colours cannot pass as a card.
 *  - Hue survives dimming and contrast changes far better than brightness does.
 */
import sharp from 'sharp';

/** Strip position and size, as fractions of the card's width. */
export const MARKER_GEOMETRY = {
  left: 0.08,
  right: 0.92,
  top: 0.022,
  height: 0.055,
  cells: 13,
  gap: 0.2,
} as const;

/**
 * Who uses which IDs: the generated set counts up from 1, the 1,000-card job takes
 * 2000-3200, pipeline tests 3100-3350, regression 3400-3440, sheets 3450 upwards.
 */
export const MAX_MARKER_ID = 4095;
const DATA_CELLS = 11;
const CHECK_RANGE = 32;

const NONE = 0;
const RED = 1;
const YELLOW = 2;
const GREEN = 3;
const CYAN = 4;
const BLUE = 5;
const MAGENTA = 6;

/** Colour order used by the step code. Sentinels are not part of it. */
const DATA_COLOURS = [RED, YELLOW, GREEN, BLUE];
const HEX: Record<number, string> = {
  [RED]: '#ff0000',
  [YELLOW]: '#ffe000',
  [GREEN]: '#00c000',
  [CYAN]: '#00ffff',
  [BLUE]: '#0000ff',
  [MAGENTA]: '#ff00ff',
};

function checkOf(id: number): number {
  return (Math.imul(id + 1, 0x9e3779b1) >>> 27) % CHECK_RANGE;
}

/** Colour classes for the whole strip, magenta first. */
export function encodeCells(id: number): number[] {
  if (!Number.isInteger(id) || id < 0 || id > MAX_MARKER_ID) {
    throw new RangeError(`marker id ${id} is outside 0-${MAX_MARKER_ID}`);
  }
  let value = id * CHECK_RANGE + checkOf(id);
  const cells = [MAGENTA];
  let previous = 0;
  for (let index = 0; index < DATA_CELLS; index += 1) {
    const step = value % 3;
    value = Math.floor(value / 3);
    previous = (previous + 1 + step) % 4;
    cells.push(DATA_COLOURS[previous]!);
  }
  cells.push(CYAN);
  return cells;
}

export function decodeCells(cells: number[]): number | null {
  if (cells.length !== DATA_CELLS + 2 || cells[0] !== MAGENTA || cells[cells.length - 1] !== CYAN) return null;
  let previous = 0;
  let value = 0;
  let scale = 1;
  for (let index = 1; index <= DATA_CELLS; index += 1) {
    const current = DATA_COLOURS.indexOf(cells[index]!);
    if (current < 0) return null;
    const step = (current - previous - 1 + 4) % 4;
    if (step > 2) return null;
    value += step * scale;
    scale *= 3;
    previous = current;
  }
  const id = Math.floor(value / CHECK_RANGE);
  if (id > MAX_MARKER_ID || value % CHECK_RANGE !== checkOf(id)) return null;
  return id;
}

/**
 * SVG fragment drawing the strip on a white band, for a card of the given
 * width. Works inside HTML or any SVG whose units are pixels.
 */
export function markerSvg(id: number, cardWidth: number): string {
  const { left, right, top, height, cells, gap } = MARKER_GEOMETRY;
  const pitch = ((right - left) * cardWidth) / cells;
  const cellWidth = pitch * (1 - gap);
  const y = top * cardWidth;
  const h = height * cardWidth;
  const pad = 0.012 * cardWidth;
  const rects = encodeCells(id)
    .map((cell, index) => {
      const x = left * cardWidth + index * pitch + (pitch - cellWidth) / 2;
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellWidth.toFixed(2)}" height="${h.toFixed(2)}" fill="${HEX[cell]}"/>`;
    })
    .join('');
  const band = `<rect x="${((left - 0.012) * cardWidth).toFixed(2)}" y="${(y - pad).toFixed(2)}" width="${((right - left + 0.024) * cardWidth).toFixed(2)}" height="${(h + 2 * pad).toFixed(2)}" fill="#ffffff"/>`;
  return `<g shape-rendering="crispEdges">${band}${rects}</g>`;
}

/** Height in pixels a layout must keep clear at the top of a card. */
export function markerClearance(cardWidth: number): number {
  const { top, height } = MARKER_GEOMETRY;
  return Math.ceil((top + height + 0.03) * cardWidth);
}

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

export interface DecodedMarker {
  id: number;
  /** Centre of the magenta and cyan cells, in pixels of the analysed frame. */
  start: { x: number; y: number };
  end: { x: number; y: number };
  frameWidth: number;
  frameHeight: number;
  /** Direction the strip runs: 0 is rightwards and positive is clockwise. */
  angleDeg: number;
}

function classifyPixel(red: number, green: number, blue: number): number {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const chroma = max - min;
  if (max < 24 || chroma < 16 || chroma / max < 0.32) return NONE;
  let hue: number;
  if (max === red) hue = ((green - blue) / chroma + 6) % 6;
  else if (max === green) hue = (blue - red) / chroma + 2;
  else hue = (red - green) / chroma + 4;
  hue *= 60;
  if (hue < 27 || hue >= 330) return RED;
  if (hue < 90) return YELLOW;
  if (hue < 150) return GREEN;
  if (hue < 210) return CYAN;
  if (hue < 270) return BLUE;
  return MAGENTA;
}

interface Blob {
  x: number;
  y: number;
  area: number;
}

/** Four-connected flood fill over one colour class. */
function findBlobs(classes: Uint8Array, width: number, height: number, target: number, minArea: number): Blob[] {
  const seen = new Uint8Array(classes.length);
  const stack = new Int32Array(classes.length);
  const blobs: Blob[] = [];
  for (let start = 0; start < classes.length; start += 1) {
    if (classes[start] !== target || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let sumX = 0;
    let sumY = 0;
    let area = 0;
    while (top > 0) {
      const at = stack[--top]!;
      const x = at % width;
      const y = (at - x) / width;
      sumX += x;
      sumY += y;
      area += 1;
      const visit = (next: number) => {
        if (!seen[next] && classes[next] === target) {
          seen[next] = 1;
          stack[top++] = next;
        }
      };
      if (x > 0) visit(at - 1);
      if (x < width - 1) visit(at + 1);
      if (y > 0) visit(at - width);
      if (y < height - 1) visit(at + width);
    }
    if (area >= minArea) blobs.push({ x: sumX / area, y: sumY / area, area });
  }
  return blobs;
}

/** Colour sequence along a straight line, with faint and narrow runs removed. */
function runsAlong(classes: Uint8Array, width: number, height: number, a: Blob, b: Blob): number[] {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.ceil(length);
  if (steps < 26) return [];
  const unitX = (b.x - a.x) / length;
  const unitY = (b.y - a.y) / length;
  const spread = Math.max(1, (length / 13) * 0.12);
  const sample = (x: number, y: number) => {
    const px = Math.round(x);
    const py = Math.round(y);
    return px < 0 || py < 0 || px >= width || py >= height ? NONE : classes[py * width + px]!;
  };

  const runs: Array<{ cell: number; length: number }> = [];
  for (let step = 0; step <= steps; step += 1) {
    const x = a.x + unitX * step;
    const y = a.y + unitY * step;
    const centre = sample(x, y);
    const left = sample(x - unitY * spread, y + unitX * spread);
    const right = sample(x + unitY * spread, y - unitX * spread);
    const cell = left === right && left !== NONE ? left : centre;
    if (cell === NONE) continue;
    const last = runs[runs.length - 1];
    if (last && last.cell === cell) last.length += 1;
    else runs.push({ cell, length: 1 });
  }
  if (runs.length < DATA_CELLS + 2) return [];

  const middle = runs.slice(1, -1).map((run) => run.length).sort((p, q) => p - q);
  const typical = middle[Math.floor(middle.length / 2)] ?? 1;
  const kept = runs.filter((run, index) => index === 0 || index === runs.length - 1 || run.length >= typical * 0.3);
  const merged: number[] = [];
  for (const run of kept) if (merged[merged.length - 1] !== run.cell) merged.push(run.cell);
  return merged;
}

function decodeFrame(pixels: Buffer, width: number, height: number, channels: number): DecodedMarker[] {
  const classes = new Uint8Array(width * height);
  for (let index = 0; index < classes.length; index += 1) {
    const at = index * channels;
    classes[index] = classifyPixel(pixels[at]!, pixels[at + 1]!, pixels[at + 2]!);
  }
  const minArea = Math.max(6, (width * height) / 400_000);
  const starts = findBlobs(classes, width, height, MAGENTA, minArea);
  const ends = findBlobs(classes, width, height, CYAN, minArea);

  // Nearest cyan first, and each cyan is used once, so a sheet needs only a few lines per card.
  const found = new Map<number, DecodedMarker>();
  const usedEnds = new Set<Blob>();
  const byArea = [...starts].sort((p, q) => q.area - p.area);
  for (const start of byArea) {
    const nearest = ends
      .filter((end) => !usedEnds.has(end))
      .sort((p, q) => Math.hypot(p.x - start.x, p.y - start.y) - Math.hypot(q.x - start.x, q.y - start.y));
    for (const end of nearest) {
      const id = decodeCells(runsAlong(classes, width, height, start, end));
      if (id === null) continue;
      usedEnds.add(end);
      if (found.has(id)) break;
      const angle = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
      found.set(id, {
        id,
        start: { x: start.x, y: start.y },
        end: { x: end.x, y: end.y },
        frameWidth: width,
        frameHeight: height,
        angleDeg: (angle + 360) % 360,
      });
      break;
    }
  }
  return [...found.values()].sort((p, q) => p.id - q.id);
}

/**
 * Every marker in an image. Tries a smaller frame first because almost every
 * call is a single card and that frame decodes in milliseconds, then widens.
 */
export async function decodeMarkers(image: Buffer, frames: number[] = [1000, 1600, 2600]): Promise<DecodedMarker[]> {
  for (const edge of frames) {
    const { data, info } = await sharp(image, { failOn: 'none' })
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const markers = decodeFrame(data, info.width, info.height, info.channels);
    if (markers.length > 0) return markers;
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Where is the card, given its strip?                                 */
/* ------------------------------------------------------------------ */

export interface MarkerBox {
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  rotation: 0 | 90 | 180 | 270;
}

/** Smallest upright box around a card, in the 0-1000 coordinates locate returns. */
export function markerToBox(marker: DecodedMarker, aspect: number): MarkerBox {
  const { left, right, top, height, cells } = MARKER_GEOMETRY;
  const pitch = (right - left) / cells;
  const spanFraction = pitch * (cells - 1);
  const dx = marker.end.x - marker.start.x;
  const dy = marker.end.y - marker.start.y;
  const span = Math.hypot(dx, dy);
  const cardWidth = span / spanFraction;
  const cardHeight = cardWidth / aspect;
  const across = { x: dx / span, y: dy / span };
  const down = { x: -across.y, y: across.x };
  const fromLeft = (left + pitch / 2) * cardWidth;
  const fromTop = (top + height / 2) * cardWidth;
  const origin = {
    x: marker.start.x - across.x * fromLeft - down.x * fromTop,
    y: marker.start.y - across.y * fromLeft - down.y * fromTop,
  };
  const corners = [
    origin,
    { x: origin.x + across.x * cardWidth, y: origin.y + across.y * cardWidth },
    { x: origin.x + down.x * cardHeight, y: origin.y + down.y * cardHeight },
    { x: origin.x + across.x * cardWidth + down.x * cardHeight, y: origin.y + across.y * cardWidth + down.y * cardHeight },
  ];
  const clamp = (value: number) => Math.max(0, Math.min(1000, Math.round(value)));
  const xs = corners.map((corner) => (corner.x / marker.frameWidth) * 1000);
  const ys = corners.map((corner) => (corner.y / marker.frameHeight) * 1000);
  const quarter = Math.round(marker.angleDeg / 90) % 4;
  return {
    x_min: clamp(Math.min(...xs)),
    y_min: clamp(Math.min(...ys)),
    x_max: clamp(Math.max(...xs)),
    y_max: clamp(Math.max(...ys)),
    rotation: ((360 - quarter * 90) % 360) as MarkerBox['rotation'],
  };
}

/** Share of the frame this card covers, 0-1, once anything outside the frame is cut off. */
export function visibleShare(marker: DecodedMarker, aspect: number): number {
  const box = markerToBox(marker, aspect);
  return ((box.x_max - box.x_min) * (box.y_max - box.y_min)) / 1_000_000;
}

/**
 * The card an image is really of. A tight sheet can leave a neighbour's whole
 * strip inside a crop, but that neighbour's card runs out of the frame, so the
 * card covering the most of the frame wins.
 */
export function primaryMarker(markers: DecodedMarker[], aspectOf: (id: number) => number): DecodedMarker | null {
  let best: DecodedMarker | null = null;
  let bestShare = -1;
  for (const marker of markers) {
    const share = visibleShare(marker, aspectOf(marker.id));
    if (share > bestShare) {
      best = marker;
      bestShare = share;
    }
  }
  return best;
}
