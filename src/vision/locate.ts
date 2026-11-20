import { unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { CONFIG } from '../shared/config.ts';
import { JobPauseError, SCHEMA_NAMES } from '../shared/contracts.ts';
import type {
  CardLocation,
  LlmCallContext,
  LlmClient,
  LlmParseResult,
  LocateResult,
  LocateWireResult,
  NormalizedImage,
} from '../shared/contracts.ts';
import { enhanceContrast } from './enhance.ts';
import { stemOf, writeFileAtomic } from './files.ts';
import { refineBoxes } from './refine.ts';
import type { RefinedLocation, Suspect } from './refine.ts';

/** Coordinates in a locate answer run from 0 to this, across the image's width and height. */
const WIRE_SCALE = 1000;
/** Past this the model has used the wrong scale. It isn't a card touching the image's edge. */
const MAX_OVERSHOOT = 30;
/**
 * A box's short side must reach this fraction of the image's long edge. Junk
 * boxes (a logo, a QR code) fall below it, while a grid 40 cards across clears it.
 */
const MIN_SIDE_RATIO = 0.01;
/** Slim cards reach 2.5:1, and a card angled in the frame only gets squarer. */
const MAX_ASPECT_RATIO = 4;
/**
 * Share of the smaller box that must lie inside the larger one before the two
 * count as heavy overlap. It is measured on the smaller box, not by IoU, so a
 * logo inside a card is caught. Cards touching in a grid share only their edges.
 */
const HEAVY_OVERLAP = 0.8;
/** Heavily overlapping boxes this alike are one card reported twice. */
const DUPLICATE_IOU = 0.7;
/** Two passes' boxes are the same card at this IoU. A miss here keeps both, so no card is lost. */
const SAME_CARD_IOU = 0.5;
/** Cards share a row when their centres are within this fraction of a card's height. */
const ROW_TOLERANCE = 0.6;
/**
 * A box covering this share of each of two separate boxes, and about a card in size itself,
 * is half of one card plus half of another. It is no card of its own.
 */
const STRADDLE_COVER = 0.4;
/** The two boxes a straddler spans are separate cards when they share less than this of the smaller. */
const STRADDLE_NEIGHBOURS_APART = 0.15;
/** A straddler is about as big as a card, so a box far smaller than the boxes it overlaps is not one. */
const STRADDLE_MIN_SIZE_RATIO = 0.6;


export const LOCATE_INSTRUCTIONS = `You find business cards in an image, so that each one can be cut out and read.

The image may hold no card, one card, or many dozens of cards: on a scanner sheet, in a grid, spread on a table or in a loose pile. Cards are often touching.

Work through the whole image methodically, row by row, from top to bottom and left to right, including the edges and corners. Report every physical card once. Never stop early or summarise, and include cards that are small, dim, blank-looking, printed on dark stock or partly hidden.

For each card, give the smallest upright rectangle containing all of it, borders included:
- x_min, y_min, x_max, y_max are numbers from 0 to 1000. (0, 0) is the top-left corner of the image and (1000, 1000) is the bottom-right, whatever the image's shape.

Each rectangle must hold exactly one whole card:
- Never combine parts of two cards into one rectangle, even when they touch. Find the visible seam or edge between touching cards and put one rectangle on each side of it.
- Never cut a card short. Every rectangle edge sits on the card's own outer edge, so the card's whole width and height are inside it. A card is not smaller than the others around it just because part of it is dim or blank.
- Cards in one image are usually the same size. If one rectangle is much larger or smaller than its neighbours, check it again.

For each card, give rotation: how many degrees clockwise the card must be turned to make its main text upright.
- 0: text already reads normally, left to right.
- 90: text runs from the bottom of the image towards the top.
- 180: text is upside down.
- 270: text runs from the top of the image towards the bottom.
If a card is tilted, use the nearest of these values.

Set contains_card to false and leave cards empty only if no business card is visible anywhere in the image. A document, receipt or photo with no card in it counts as no card.`;

const PASS_PROMPTS = [
  'Find every business card in this image.',
  'This copy of the image has boosted contrast. Find every business card in it, checking dark and low-contrast areas closely.',
] as const;

export const LocateWireSchema = z.object({
  contains_card: z.boolean(),
  cards: z.array(
    z.object({
      x_min: z.number(),
      y_min: z.number(),
      x_max: z.number(),
      y_max: z.number(),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    }),
  ),
});

type Box = CardLocation['box'];
type WireCard = LocateWireResult['cards'][number];

interface LocatePass {
  status: 'cards' | 'no_card' | 'failed';
  locations: CardLocation[];
  /** Boxes rejected, or why the whole pass failed. Either way this pass can't confirm the count. */
  problems: string[];
  /** Same-card repeats removed. These don't weaken the count, because no card was lost. */
  duplicates: number;
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const areaOf = (box: Box) => box.width * box.height;
const centreY = ({ box }: CardLocation) => box.y + box.height / 2;

function intersectionArea(a: Box, b: Box): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function iou(a: Box, b: Box): number {
  const shared = intersectionArea(a, b);
  return shared / (areaOf(a) + areaOf(b) - shared);
}

/** Share of the smaller box that lies inside the larger. */
export function overlapOfSmaller(a: Box, b: Box): number {
  return intersectionArea(a, b) / Math.min(areaOf(a), areaOf(b));
}

function enclosing(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** Top to bottom, then left to right, without being thrown by slightly uneven rows. */
export function readingOrder(locations: CardLocation[]): CardLocation[] {
  const rows: CardLocation[][] = [];
  for (const location of [...locations].sort((a, b) => centreY(a) - centreY(b))) {
    const row = rows.at(-1);
    if (row && fitsRow(row, location)) row.push(location);
    else rows.push([location]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x));
}

function fitsRow(row: CardLocation[], location: CardLocation): boolean {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const rowCentre = mean(row.map(centreY));
  const rowHeight = mean(row.map(({ box }) => box.height));
  return centreY(location) - rowCentre < ROW_TOLERANCE * Math.min(rowHeight, location.box.height);
}

/* ------------------------------------------------------------------ */
/* Checking one pass                                                   */
/* ------------------------------------------------------------------ */

function toLocation(card: WireCard, image: NormalizedImage): CardLocation | string {
  const { x_min, y_min, x_max, y_max, rotation } = card;
  const onScale = (value: number) => value >= -MAX_OVERSHOOT && value <= WIRE_SCALE + MAX_OVERSHOOT;
  if (![x_min, y_min, x_max, y_max].every(onScale)) return 'off the 0-1000 scale';
  if (x_max <= x_min || y_max <= y_min) return 'inverted';

  const clamp = (value: number) => Math.min(WIRE_SCALE, Math.max(0, value));
  const left = Math.floor((clamp(x_min) * image.width) / WIRE_SCALE);
  const top = Math.floor((clamp(y_min) * image.height) / WIRE_SCALE);
  const width = Math.ceil((clamp(x_max) * image.width) / WIRE_SCALE) - left;
  const height = Math.ceil((clamp(y_max) * image.height) / WIRE_SCALE) - top;

  const shortSide = Math.min(width, height);
  if (shortSide < MIN_SIDE_RATIO * Math.max(image.width, image.height)) return 'tiny';
  if (Math.max(width, height) / shortSide > MAX_ASPECT_RATIO) return 'implausibly shaped';
  return { box: { x: left, y: top, width, height }, rotation };
}

/**
 * Removes boxes that cannot be cards of their own. A box covering several others
 * is a group of cards, so the group goes and the cards stay. A box inside one
 * other goes, because the larger box still holds all of its pixels.
 */
function dropOverlaps(locations: CardLocation[]): { kept: CardLocation[]; problems: string[]; duplicates: number } {
  const largestFirst = [...locations].sort((a, b) => areaOf(b.box) - areaOf(a.box));
  const isInside = (inner: CardLocation, outer: CardLocation) =>
    inner !== outer &&
    areaOf(inner.box) <= areaOf(outer.box) &&
    overlapOfSmaller(inner.box, outer.box) >= HEAVY_OVERLAP &&
    iou(inner.box, outer.box) < DUPLICATE_IOU;

  /** Two boxes that each lie about half inside this one, while barely touching each other. */
  const isStraddler = (location: CardLocation) => {
    const covered = largestFirst.filter(
      (other) =>
        other !== location &&
        intersectionArea(other.box, location.box) / areaOf(other.box) >= STRADDLE_COVER &&
        areaOf(location.box) >= STRADDLE_MIN_SIZE_RATIO * areaOf(other.box),
    );
    return covered.some((first, index) =>
      covered.slice(index + 1).some((second) => overlapOfSmaller(first.box, second.box) < STRADDLE_NEIGHBOURS_APART),
    );
  };

  const problems: string[] = [];
  const kept: CardLocation[] = [];
  let duplicates = 0;
  for (const location of largestFirst) {
    if (largestFirst.filter((other) => isInside(other, location)).length >= 2) {
      problems.push('covering several cards');
      continue;
    }
    if (isStraddler(location)) {
      problems.push('straddling two cards');
      continue;
    }
    const twin = kept.find((other) => overlapOfSmaller(location.box, other.box) >= HEAVY_OVERLAP);
    if (!twin) kept.push(location);
    else if (iou(location.box, twin.box) >= DUPLICATE_IOU) duplicates += 1;
    else problems.push('inside another box');
  }
  return { kept, problems, duplicates };
}

function failedPass(problem: string): LocatePass {
  return { status: 'failed', locations: [], problems: [problem], duplicates: 0 };
}

function checkAnswer(answer: unknown, image: NormalizedImage): LocatePass {
  const parsed = LocateWireSchema.safeParse(answer);
  if (!parsed.success) return failedPass('malformed answer');
  const { contains_card: containsCard, cards } = parsed.data;
  if (!containsCard && cards.length === 0) return { status: 'no_card', locations: [], problems: [], duplicates: 0 };
  if (!containsCard) return failedPass('said no card but gave boxes');
  if (cards.length === 0) return failedPass('said there were cards but gave no boxes');

  const results = cards.map((card) => toLocation(card, image));
  const locations = results.filter((result) => typeof result !== 'string');
  const rejected = results.filter((result) => typeof result === 'string');
  const { kept, problems, duplicates } = dropOverlaps(locations);
  const allProblems = [...rejected, ...problems];
  if (kept.length === 0) return failedPass(`no usable boxes (${summarise(allProblems)})`);
  return { status: 'cards', locations: kept, problems: allProblems, duplicates };
}

function checkPass(outcome: PromiseSettledResult<LlmParseResult<LocateWireResult>>, image: NormalizedImage): LocatePass {
  if (outcome.status === 'rejected') return failedPass(`call failed: ${String(outcome.reason)}`);
  const result = outcome.value;
  if (!result.ok) return failedPass(`${result.failure}: ${result.detail}`);
  return checkAnswer(result.value, image);
}

/** ['tiny', 'tiny', 'inverted'] becomes '2 tiny, 1 inverted'. */
function summarise(problems: string[]): string {
  const counts = new Map<string, number>();
  for (const problem of problems) counts.set(problem, (counts.get(problem) ?? 0) + 1);
  return [...counts].map(([problem, count]) => `${count} ${problem}`).join(', ');
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/* ------------------------------------------------------------------ */
/* Reconciling two passes                                              */
/* ------------------------------------------------------------------ */

function wholeImageResult(image: NormalizedImage, reason: string): LocateResult {
  return {
    noCard: false,
    locations: [{ box: { x: 0, y: 0, width: image.width, height: image.height }, rotation: 0 }],
    fellBackToFullImage: true,
    countConfirmed: false,
    note: `${reason} Using the whole image.`,
  };
}

/** Best overlaps first, so a card pairs with its true counterpart rather than a neighbour. */
function matchPasses(first: CardLocation[], second: CardLocation[]) {
  const candidates = first
    .flatMap((a) => second.map((b) => ({ a, b, score: iou(a.box, b.box) })))
    .filter(({ score }) => score >= SAME_CARD_IOU)
    .sort((p, q) => q.score - p.score);

  const taken = new Set<CardLocation>();
  const pairs: Array<[CardLocation, CardLocation]> = [];
  for (const { a, b } of candidates) {
    if (taken.has(a) || taken.has(b)) continue;
    taken.add(a).add(b);
    pairs.push([a, b]);
  }
  return {
    pairs,
    onlyFirst: first.filter((location) => !taken.has(location)),
    onlySecond: second.filter((location) => !taken.has(location)),
  };
}

function passNotes(first: LocatePass, second: LocatePass): string[] {
  const notes: string[] = [];
  for (const [index, pass] of [first, second].entries()) {
    if (pass.status === 'cards' && pass.problems.length > 0) {
      notes.push(`Pass ${index + 1} rejected boxes: ${summarise(pass.problems)}.`);
    }
    if (pass.duplicates > 0) notes.push(`Pass ${index + 1} repeated ${plural(pass.duplicates, 'card')}.`);
  }
  return notes;
}

function reconcile(first: LocatePass, second: LocatePass, image: NormalizedImage): LocateResult {
  const describe = (pass: LocatePass) => (pass.status === 'no_card' ? 'saw no card' : `failed (${pass.problems.join('; ')})`);

  if (first.status === 'no_card' && second.status === 'no_card') {
    return { noCard: true, locations: [], fellBackToFullImage: false, countConfirmed: true, note: 'Both locate passes saw no card.' };
  }
  if (first.status !== 'cards' && second.status !== 'cards') {
    return wholeImageResult(image, `Locate pass 1 ${describe(first)} and pass 2 ${describe(second)}.`);
  }
  if (first.status !== 'cards' || second.status !== 'cards') {
    const [usable, other, usableNumber] = first.status === 'cards' ? [first, second, 1] : [second, first, 2];
    const notes = [`Pass ${3 - usableNumber} ${describe(other)}, so the ${plural(usable.locations.length, 'card')} from pass ${usableNumber} could not be confirmed.`];
    return {
      noCard: false,
      locations: readingOrder(usable.locations),
      fellBackToFullImage: false,
      countConfirmed: false,
      note: [...notes, ...passNotes(first, second)].join(' '),
    };
  }

  const { pairs, onlyFirst, onlySecond } = matchPasses(first.locations, second.locations);
  // The enclosing box, so one pass cutting a card short can't cut off a printed line.
  // If one pass ran into a neighbour, the enclosing box now holds a card boundary, which the pixel check catches afterwards.
  const matched = pairs.map(([a, b]) => ({ box: enclosing(a.box, b.box), rotation: a.rotation }));
  const merged = dropOverlaps([...matched, ...onlyFirst, ...onlySecond]);
  const rotationConflicts = pairs.filter(([a, b]) => a.rotation !== b.rotation).length;

  const notes = passNotes(first, second);
  if (merged.problems.length > 0) notes.push(`Merging the passes rejected boxes: ${summarise(merged.problems)}.`);
  if (onlyFirst.length > 0 || onlySecond.length > 0) {
    notes.unshift(
      `Locate passes differ: pass 1 found ${plural(first.locations.length, 'card')} and pass 2 found ${first.locations.length === second.locations.length ? 'the same number in different places' : plural(second.locations.length, 'card')}. ` +
        `${onlyFirst.length} seen only by pass 1 and ${onlySecond.length} seen only by pass 2. Keeping ${plural(merged.kept.length, 'card')}.`,
    );
  }
  if (rotationConflicts > 0) notes.push(`Passes disagreed on the rotation of ${plural(rotationConflicts, 'card')}, so pass 1's was used.`);

  return {
    noCard: false,
    locations: readingOrder(merged.kept),
    fellBackToFullImage: false,
    countConfirmed:
      onlyFirst.length === 0 &&
      onlySecond.length === 0 &&
      rotationConflicts === 0 &&
      first.problems.length === 0 &&
      second.problems.length === 0 &&
      merged.problems.length === 0,
    note: notes.join(' ') || null,
  };
}

/* ------------------------------------------------------------------ */
/* Running the passes                                                  */
/* ------------------------------------------------------------------ */

/** Two different views of the image. Same pixels twice would tend to repeat the same miss. */
async function writePassImages(image: NormalizedImage): Promise<string[]> {
  const edge = CONFIG.image.locateLongEdge;
  const encode = { quality: CONFIG.image.jpegQuality } as const;
  const resized = sharp(image.path).resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true });
  const views = [resized.clone(), enhanceContrast(resized.clone())];

  return Promise.all(
    views.map(async (view, index) => {
      const outPath = path.join(path.dirname(image.path), `${stemOf(image.path)}-locate-${index + 1}.jpg`);
      await writeFileAtomic(outPath, await view.jpeg(encode).toBuffer());
      return outPath;
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Checking boxes against the pixels, and asking again about doubtful ones */
/* ------------------------------------------------------------------ */

/** Doubtful boxes asked about again, per photo. Each costs two calls, on a small crop. */
const MAX_RELOOKS = 8;
/** How much around a doubtful box the second look sees, as a share of the box's size. A clipped box needs room to grow. */
const RELOOK_MARGIN = 0.35;

/** A closer look giving back a box this close to the one asked about has changed nothing. */
const RELOOK_UNCHANGED_IOU = 0.9;

interface Relook {
  suspect: CardLocation;
  kind: Suspect;
  /** Boxes the closer look found, in the whole image's pixels. Null when it could not give a usable answer. */
  found: CardLocation[] | null;
}

/** Asks the model again about one box, on a crop of just that area, where its coordinates are far more exact. */
async function relook(llm: LlmClient, image: NormalizedImage, ctx: LlmCallContext, suspect: CardLocation, kind: Suspect): Promise<Relook> {
  const { box } = suspect;
  const left = Math.max(0, Math.floor(box.x - box.width * RELOOK_MARGIN));
  const top = Math.max(0, Math.floor(box.y - box.height * RELOOK_MARGIN));
  const right = Math.min(image.width, Math.ceil(box.x + box.width * (1 + RELOOK_MARGIN)));
  const bottom = Math.min(image.height, Math.ceil(box.y + box.height * (1 + RELOOK_MARGIN)));
  const region = { left, top, width: right - left, height: bottom - top };

  const cropPath = path.join(path.dirname(image.path), `${stemOf(image.path)}-relook-${left}-${top}.jpg`);
  try {
    await writeFileAtomic(cropPath, await sharp(image.path).extract(region).jpeg({ quality: CONFIG.image.jpegQuality }).toBuffer());
    const crop: NormalizedImage = { path: cropPath, width: region.width, height: region.height, sourceFormat: 'jpeg' };
    const result = await locatePasses(llm, crop, ctx);
    if (result.noCard || result.fellBackToFullImage || result.locations.length === 0) return { suspect, kind, found: null };
    const found = result.locations.map(({ box: inner, rotation }) => ({
      box: { x: inner.x + left, y: inner.y + top, width: inner.width, height: inner.height },
      rotation,
    }));
    return { suspect, kind, found };
  } finally {
    await unlink(cropPath).catch(() => {});
  }
}

/**
 * Puts a closer look's boxes in place of the doubtful one. A found box that matches
 * a box already there replaces it, because the crop placed it more exactly.
 */
function applyRelook(current: CardLocation[], suspect: CardLocation, found: CardLocation[]): CardLocation[] {
  const next = current.filter((location) => location !== suspect);
  for (const location of found) {
    const same = next.findIndex((other) => iou(other.box, location.box) >= SAME_CARD_IOU);
    if (same >= 0) next[same] = location;
    else next.push(location);
  }
  return dropOverlaps(next).kept;
}

/**
 * Snaps boxes onto the card outlines in the pixels, then asks the model again about any
 * box that looks wrong (one holding a card boundary, or cut short), on a crop of its own.
 */
async function repair(llm: LlmClient, image: NormalizedImage, ctx: LlmCallContext, result: LocateResult): Promise<LocateResult> {
  if (result.noCard || result.fellBackToFullImage || result.locations.length === 0) return result;

  let refined: RefinedLocation[];
  try {
    refined = await refineBoxes(image, result.locations);
  } catch {
    return result; // A box check failing must never lose the cards found.
  }

  let locations = refined.map(({ location }) => location);
  const doubtful = refined.filter(({ suspect }) => suspect !== null).slice(0, MAX_RELOOKS);
  const skipped = refined.filter(({ suspect }) => suspect !== null).length - doubtful.length;
  if (doubtful.length === 0 && skipped === 0) return { ...result, locations: readingOrder(locations) };

  const outcomes = await Promise.allSettled(doubtful.map(({ location, suspect }) => relook(llm, image, ctx, location, suspect!)));
  const pause = outcomes.find((outcome) => outcome.status === 'rejected' && outcome.reason instanceof JobPauseError);
  if (pause?.status === 'rejected') throw pause.reason;
  ctx.signal?.throwIfAborted();

  let unresolved = skipped;
  let changed = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected' || outcome.value.found === null) {
      unresolved += 1;
      continue;
    }
    const { suspect, kind, found } = outcome.value;
    // The pixels show a strong outline beyond this box and the model sees nothing there. Neither can be trusted, so a person decides.
    const unchanged = found.length === 1 && iou(found[0]!.box, suspect.box) >= RELOOK_UNCHANGED_IOU;
    if (kind === 'clipped' && unchanged) unresolved += 1;
    const before = locations;
    locations = applyRelook(locations, suspect, found);
    if (locations.length !== before.length) changed += 1;
  }

  const notes = [
    result.note,
    doubtful.length > 0
      ? `Looked again at ${doubtful.length === 1 ? '1 box' : `${doubtful.length} boxes`} that did not match the pixels (${summarise(doubtful.map(({ suspect }) => suspect!))}).`
      : null,
    changed > 0 ? `The closer look changed the number of cards in ${plural(changed, 'place')}.` : null,
    unresolved > 0 ? `${unresolved === 1 ? '1 doubtful box' : `${unresolved} doubtful boxes`} could not be checked, so the count is unconfirmed.` : null,
  ].filter((note) => note !== null);
  return {
    ...result,
    locations: readingOrder(locations),
    countConfirmed: result.countConfirmed && unresolved === 0,
    note: notes.length > 0 ? notes.join(' ') : null,
  };
}

export async function locateCards(llm: LlmClient, image: NormalizedImage, ctx: LlmCallContext): Promise<LocateResult> {
  return repair(llm, image, ctx, await locatePasses(llm, image, ctx));
}

async function locatePasses(llm: LlmClient, image: NormalizedImage, ctx: LlmCallContext): Promise<LocateResult> {
  const passImages = await writePassImages(image);
  try {
    // allSettled, so neither call is still reading its image when the files are removed.
    const outcomes = await Promise.allSettled(
      passImages.map((imagePath, index) =>
        llm.parse<LocateWireResult>(
          {
            instructions: LOCATE_INSTRUCTIONS,
            userText: PASS_PROMPTS[index] ?? PASS_PROMPTS[0],
            imagePaths: [imagePath],
            schema: LocateWireSchema,
            schemaName: SCHEMA_NAMES.locate,
            reasoningEffort: CONFIG.reasoningEffort.locate,
            maxOutputTokens: CONFIG.maxOutputTokens.locate,
          },
          ctx,
        ),
      ),
    );

    const pause = outcomes.find((outcome) => outcome.status === 'rejected' && outcome.reason instanceof JobPauseError);
    if (pause?.status === 'rejected') throw pause.reason;
    // A cancelled job must stop here rather than record a fallback it never really needed.
    ctx.signal?.throwIfAborted();

    const [first, second] = outcomes.map((outcome) => checkPass(outcome, image));
    return reconcile(first!, second!, image);
  } finally {
    await Promise.all(passImages.map((imagePath) => unlink(imagePath).catch(() => {})));
  }
}
