import sharp from 'sharp';
import type { CardLocation, NormalizedImage } from '../shared/contracts.ts';

/**
 * Checks the model's boxes against the pixels. The model is good at finding cards and
 * poor at placing edges exactly, so a box can run through two touching cards or stop
 * short of a card's real edge. A card's outline is a long, unbroken straight edge, and
 * that is what is measured here, so nothing needs the model.
 *
 * Every number below is a starting value, tuned on synthetic sheets only.
 */

type Box = CardLocation['box'];

export type Suspect = 'contains_seam' | 'clipped' | 'size_outlier';

export interface RefinedLocation {
  location: CardLocation;
  suspect: Suspect | null;
}

/** Edges are measured on a copy this big, however large the photo. */
const WORK_LONG_EDGE = 1600;
/** A step in brightness this big across two pixels counts as an edge pixel. */
const EDGE_STEP = 24;
/** Share of a card side's length that must be edge, for that line to be the card's outline. */
const OUTLINE_SHARE = 0.6;
/** The strongest line in a search window is the outline. Lines nearly as strong further out still count as it. */
const NEAR_BEST = 0.9;
/** An edge may move this far, as a share of the box's size, without the model being asked again. */
const SNAP_WINDOW = 0.08;
/** Past the snap window, a strong line up to this far outside the box means it was clipped. */
const CLIP_SEARCH = 0.5;
/**
 * The search stops this far short of a neighbouring box, as a share of the box's size. Right
 * beside the box is the neighbour's own outline, which is not this card's.
 */
const NEIGHBOUR_BUFFER = 0.06;
/** Small snaps stop this many pixels (of the working copy) short of a neighbouring box, since lines are matched a pixel either side. */
const SNAP_NEIGHBOUR_GAP = 4;
/** A clip is only believed when the line outside is this unbroken. */
const CLIP_SHARE = 0.85;
/** Card corners are rounded and often damaged, so the middle of each side is measured. */
const SIDE_INSET = 0.1;
/**
 * A seam between two cards runs edge to edge, while a rule printed on one card stops short of its
 * borders. So the line is measured nearly across the whole box, and must be nearly unbroken.
 */
const SEAM_SPAN_INSET = 0.03;
const SEAM_SHARE = 0.9;
/** A seam this close to a side is that card's own edge. Halves of a straddler sit well inside. */
const SEAM_RANGE = { from: 0.2, to: 0.8 } as const;
/** Cards in one photo are usually one size. Outside this range of the median, a box is queried. */
const SIZE_HIGH = 1.6;
const SIZE_LOW = 0.55;
const SIZE_MIN_BOXES = 4;

interface EdgeMap {
  width: number;
  height: number;
  scale: number;
  /** 1 where a vertical edge passes (brightness changes left to right). */
  vertical: Uint8Array;
  /** 1 where a horizontal edge passes. */
  horizontal: Uint8Array;
}

export async function buildEdgeMap(image: NormalizedImage): Promise<EdgeMap> {
  const { data, info } = await sharp(image.path)
    .grayscale()
    .resize({ width: WORK_LONG_EDGE, height: WORK_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const vertical = new Uint8Array(width * height);
  const horizontal = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = y * width + x;
      if (Math.abs(data[at + 1]! - data[at - 1]!) >= EDGE_STEP) vertical[at] = 1;
      if (Math.abs(data[at + width]! - data[at - width]!) >= EDGE_STEP) horizontal[at] = 1;
    }
  }
  return { width, height, scale: width / image.width, vertical, horizontal };
}

/**
 * Share of the span along which a straight line at `position` is edge. A line a pixel
 * either side counts, because a card tilted a degree or two is not perfectly vertical.
 */
function lineShare(map: EdgeMap, orientation: 'vertical' | 'horizontal', position: number, from: number, to: number): number {
  const edges = orientation === 'vertical' ? map.vertical : map.horizontal;
  const across = orientation === 'vertical' ? map.width : map.height;
  const along = orientation === 'vertical' ? map.height : map.width;
  const first = Math.max(0, Math.round(from));
  const last = Math.min(along, Math.round(to));
  if (last <= first || position < 1 || position > across - 2) return 0;

  let hits = 0;
  for (let step = first; step < last; step += 1) {
    for (let offset = -1; offset <= 1; offset += 1) {
      const at = orientation === 'vertical' ? step * map.width + position + offset : (position + offset) * map.width + step;
      if (edges[at]) {
        hits += 1;
        break;
      }
    }
  }
  return hits / (last - first);
}

interface Side {
  orientation: 'vertical' | 'horizontal';
  /** -1 for the left and top sides, +1 for the right and bottom. Moving this way grows the box. */
  outward: -1 | 1;
}
const SIDES = {
  left: { orientation: 'vertical', outward: -1 },
  right: { orientation: 'vertical', outward: 1 },
  top: { orientation: 'horizontal', outward: -1 },
  bottom: { orientation: 'horizontal', outward: 1 },
} as const satisfies Record<string, Side>;
type SideName = keyof typeof SIDES;

/** Working-scale box: left, top, right, bottom. */
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const toRect = (box: Box, scale: number): Rect => ({
  left: box.x * scale,
  top: box.y * scale,
  right: (box.x + box.width) * scale,
  bottom: (box.y + box.height) * scale,
});

const fromRect = (rect: Rect, scale: number): Box => {
  const x = Math.round(rect.left / scale);
  const y = Math.round(rect.top / scale);
  return { x, y, width: Math.round(rect.right / scale) - x, height: Math.round(rect.bottom / scale) - y };
};

const positionOf = (rect: Rect, side: SideName) => rect[side];

/** The span along a side that is measured: the middle of it. */
function spanOf(rect: Rect, side: SideName): [number, number] {
  const [start, end] = SIDES[side].orientation === 'vertical' ? [rect.top, rect.bottom] : [rect.left, rect.right];
  const inset = (end - start) * SIDE_INSET;
  return [start + inset, end - inset];
}

function sizeAcross(rect: Rect, side: SideName): number {
  return SIDES[side].orientation === 'vertical' ? rect.right - rect.left : rect.bottom - rect.top;
}

/**
 * How far this side can grow before reaching a neighbouring box beside it. Without
 * this a search would find the edge of the next card and call it this card's.
 */
function roomOutward(rect: Rect, side: SideName, others: Rect[], limit: number): number {
  const { orientation, outward } = SIDES[side];
  const at = positionOf(rect, side);
  let room = limit;
  for (const other of others) {
    const [start, end] = orientation === 'vertical' ? [other.top, other.bottom] : [other.left, other.right];
    const [mine0, mine1] = orientation === 'vertical' ? [rect.top, rect.bottom] : [rect.left, rect.right];
    const shared = Math.min(end, mine1) - Math.max(start, mine0);
    if (shared < 0.5 * (mine1 - mine0)) continue; // not beside this side
    const nearEdge = outward === 1 ? (orientation === 'vertical' ? other.left : other.top) : orientation === 'vertical' ? other.right : other.bottom;
    const distance = (nearEdge - at) * outward;
    if (distance >= 0) room = Math.min(room, distance);
  }
  return Math.max(0, room);
}

/** The outline in a window of positions: the strongest line, or the outermost nearly as strong. */
function bestLine(
  map: EdgeMap,
  side: SideName,
  rect: Rect,
  from: number,
  to: number,
): { position: number; share: number } | null {
  const { orientation, outward } = SIDES[side];
  const [spanFrom, spanTo] = spanOf(rect, side);
  const found: Array<{ position: number; share: number }> = [];
  for (let position = Math.round(from); position <= Math.round(to); position += 1) {
    found.push({ position, share: lineShare(map, orientation, position, spanFrom, spanTo) });
  }
  const strongest = Math.max(0, ...found.map(({ share }) => share));
  if (strongest < OUTLINE_SHARE) return null;
  const candidates = found.filter(({ share }) => share >= NEAR_BEST * strongest);
  return candidates.reduce((best, next) => (next.position * outward > best.position * outward ? next : best));
}

/** Window of positions for a side: `inward` back into the box, `out` beyond it. */
function searchWindow(rect: Rect, side: SideName, inward: number, out: number): [number, number] {
  const at = positionOf(rect, side);
  const { outward } = SIDES[side];
  const [a, b] = [at - outward * inward, at + outward * out];
  return a < b ? [a, b] : [b, a];
}

interface SnapResult {
  rect: Rect;
  clipped: boolean;
}

/** Moves each side onto the outline within a small window, and spots sides with a strong line well outside. */
function snapBox(map: EdgeMap, rect: Rect, others: Rect[]): SnapResult {
  const next: Rect = { ...rect };
  let clipped = false;
  for (const side of Object.keys(SIDES) as SideName[]) {
    const size = sizeAcross(rect, side);
    const reach = CLIP_SEARCH * size;
    const room = roomOutward(rect, side, others, reach);

    const near = Math.min(SNAP_WINDOW * size, room < reach ? Math.max(0, room - SNAP_NEIGHBOUR_GAP) : room);
    const [from, to] = searchWindow(rect, side, SNAP_WINDOW * size, near);
    const line = bestLine(map, side, rect, from, to);
    if (line) next[side] = line.position;

    const clipRoom = room < reach ? room - NEIGHBOUR_BUFFER * size : room;
    if (clipRoom > SNAP_WINDOW * size) {
      const [outerFrom, outerTo] = searchWindow(rect, side, -SNAP_WINDOW * size, clipRoom);
      const outer = bestLine(map, side, rect, outerFrom, outerTo);
      if (outer && outer.share >= CLIP_SHARE) clipped = true;
    }
  }
  const valid = next.right - next.left > 2 && next.bottom - next.top > 2;
  return { rect: valid ? next : rect, clipped: valid ? clipped : false };
}

/** Whether a straight, edge-to-edge line crosses the box away from its own sides. */
function hasSeam(map: EdgeMap, rect: Rect): boolean {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  const spanOver = (start: number, size: number): [number, number] => [start + size * SEAM_SPAN_INSET, start + size * (1 - SEAM_SPAN_INSET)];

  const [rowFrom, rowTo] = spanOver(rect.top, height);
  for (let x = rect.left + width * SEAM_RANGE.from; x <= rect.left + width * SEAM_RANGE.to; x += 1) {
    if (lineShare(map, 'vertical', Math.round(x), rowFrom, rowTo) >= SEAM_SHARE) return true;
  }
  const [columnFrom, columnTo] = spanOver(rect.left, width);
  for (let y = rect.top + height * SEAM_RANGE.from; y <= rect.top + height * SEAM_RANGE.to; y += 1) {
    if (lineShare(map, 'horizontal', Math.round(y), columnFrom, columnTo) >= SEAM_SHARE) return true;
  }
  return false;
}

function medianArea(boxes: Box[]): number {
  const areas = boxes.map(({ width, height }) => width * height).sort((a, b) => a - b);
  const middle = Math.floor(areas.length / 2);
  return areas.length % 2 === 1 ? areas[middle]! : (areas[middle - 1]! + areas[middle]!) / 2;
}

/**
 * Snaps each box onto the card outline it was aiming at, and marks boxes that look wrong:
 * a card boundary inside the box, a strong outline well beyond it, or a size far from the rest.
 * A box with no sign of trouble comes back as it was, apart from small edge corrections.
 */
export async function refineBoxes(image: NormalizedImage, locations: CardLocation[]): Promise<RefinedLocation[]> {
  if (locations.length === 0) return [];
  const map = await buildEdgeMap(image);
  const rects = locations.map(({ box }) => toRect(box, map.scale));

  const snapped = rects.map((rect, index) =>
    snapBox(
      map,
      rect,
      rects.filter((_, other) => other !== index),
    ),
  );
  const boxes = snapped.map(({ rect }) => fromRect(rect, map.scale));
  const median = boxes.length >= SIZE_MIN_BOXES ? medianArea(boxes) : null;

  return locations.map((location, index) => {
    const box = boxes[index]!;
    const area = box.width * box.height;
    let suspect: Suspect | null = null;
    if (hasSeam(map, snapped[index]!.rect)) suspect = 'contains_seam';
    else if (snapped[index]!.clipped) suspect = 'clipped';
    else if (median !== null && (area > SIZE_HIGH * median || area < SIZE_LOW * median)) suspect = 'size_outlier';
    return { location: { ...location, box }, suspect };
  });
}
