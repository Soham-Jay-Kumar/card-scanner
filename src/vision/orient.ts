import { unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { z } from 'zod';
import { CONFIG } from '../shared/config.ts';
import { JobPauseError, SCHEMA_NAMES } from '../shared/contracts.ts';
import type { CardLocation, LlmClient, LlmCallContext, LocateResult, NormalizedImage, Rotation } from '../shared/contracts.ts';
import { stemOf, writeFileAtomic } from './files.ts';

/**
 * Locate's rotation answer is unreliable. The model is asked to judge the direction
 * of text on cards scattered across a whole photo, in clockwise degrees, and it
 * can be wrong by exactly 180 degrees for every card in a photo (seen on a real
 * 43-card iPhone photo: all 43 answered 90, all needed 270). A card read upside
 * down loses its small print, so each card's orientation is checked on its own.
 *
 * The check shows the model four turns of the same crop and asks which one is
 * upright. That needs no clockwise or anticlockwise convention, so it cannot be
 * misapplied that way.
 */
export const ORIENT_INSTRUCTIONS = `You are shown one picture made of four tiles, numbered 1 to 4 in the top-left corner of each. Every tile shows the same business card, turned a different way.

Exactly one tile shows the card the right way up: its main printed text (the person's name, the company name, the address lines) runs in horizontal lines, reads left to right, and its letters are upright, not sideways and not upside down.

Answer with the number of that tile. Judge by the main text, not by a logo, which can be turned any way.
Answer 0 only if no tile shows readable text, for example a blank card back or a card with only a logo, or if you really cannot tell.`;

export const OrientWireSchema = z.object({
  upright_tile: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});
type OrientWireResult = z.infer<typeof OrientWireSchema>;

/** Tile n shows the crop turned a further (n - 1) quarter turns clockwise. */
const TURNS: Rotation[] = [0, 90, 180, 270];
const TILE_PX = 480;
const GAP_PX = 8;
const CHECK_CONCURRENCY = 8;
/** Same margin the real crop adds, so the check sees what the read will see. */
const MARGIN = CONFIG.image.cropMarginRatio;

const addTurn = (rotation: Rotation, extra: Rotation) => (((rotation + extra) % 360) as Rotation);

function regionOf(box: CardLocation['box'], image: NormalizedImage) {
  const marginX = box.width * MARGIN;
  const marginY = box.height * MARGIN;
  const left = Math.max(0, Math.floor(box.x - marginX));
  const top = Math.max(0, Math.floor(box.y - marginY));
  const right = Math.min(image.width, Math.ceil(box.x + box.width + marginX));
  const bottom = Math.min(image.height, Math.ceil(box.y + box.height + marginY));
  return { left, top, width: right - left, height: bottom - top };
}

const badge = (label: number) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="28" fill="#d00000"/>` +
      `<text x="32" y="46" font-size="40" font-weight="700" font-family="Helvetica, Arial, sans-serif" fill="#fff" text-anchor="middle">${label}</text></svg>`,
  );

/** The four-tile picture for one card. Tile 1 is the card as locate says it should be turned. */
export async function orientationPicture(decoded: Sharp, image: NormalizedImage, location: CardLocation): Promise<Buffer> {
  const region = regionOf(location.box, image);
  const crop = await decoded.clone().extract(region).raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: crop.info.width, height: crop.info.height, channels: crop.info.channels } };

  const tiles = await Promise.all(
    TURNS.map(async (extra) =>
      sharp(crop.data, raw)
        .rotate(addTurn(location.rotation, extra))
        .resize({ width: TILE_PX, height: TILE_PX, fit: 'contain', background: '#808080' })
        .jpeg({ quality: 88 })
        .toBuffer(),
    ),
  );
  const size = 2 * TILE_PX + GAP_PX;
  return sharp({ create: { width: size, height: size, channels: 3, background: '#202020' } })
    .composite([
      ...tiles.map((input, index) => ({ input, left: (index % 2) * (TILE_PX + GAP_PX), top: Math.floor(index / 2) * (TILE_PX + GAP_PX) })),
      ...tiles.map((_, index) => ({ input: badge(index + 1), left: (index % 2) * (TILE_PX + GAP_PX) + 6, top: Math.floor(index / 2) * (TILE_PX + GAP_PX) + 6 })),
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
}

type Verdict = { kind: 'turn'; rotation: Rotation } | { kind: 'unsure' };

async function judge(
  llm: LlmClient,
  image: NormalizedImage,
  decoded: Sharp,
  location: CardLocation,
  index: number,
  ctx: LlmCallContext,
): Promise<Verdict> {
  const picturePath = path.join(path.dirname(image.path), `${stemOf(image.path)}-orient-${String(index + 1).padStart(3, '0')}.jpg`);
  await writeFileAtomic(picturePath, await orientationPicture(decoded, image, location));
  try {
    const result = await llm.parse<OrientWireResult>(
      {
        instructions: ORIENT_INSTRUCTIONS,
        userText: 'Which tile shows the card the right way up?',
        imagePaths: [picturePath],
        schema: OrientWireSchema,
        schemaName: SCHEMA_NAMES.orient,
        reasoningEffort: CONFIG.reasoningEffort.orient,
        maxOutputTokens: CONFIG.maxOutputTokens.orient,
      },
      { ...ctx, purpose: 'orient' },
    );
    if (!result.ok) return { kind: 'unsure' };
    const parsed = OrientWireSchema.safeParse(result.value);
    if (!parsed.success || parsed.data.upright_tile === 0) return { kind: 'unsure' };
    return { kind: 'turn', rotation: addTurn(location.rotation, TURNS[parsed.data.upright_tile - 1]!) };
  } finally {
    await unlink(picturePath).catch(() => {});
  }
}

/**
 * Settles each card's rotation by looking at the card alone. A card the model can't
 * judge (no text, or the call failed) keeps the rotation locate gave. A pause
 * (out of credit, bad key) is not swallowed: it stops the job as it would anywhere else.
 */
export async function orientCards(
  llm: LlmClient,
  image: NormalizedImage,
  located: LocateResult,
  ctx: LlmCallContext,
): Promise<LocateResult> {
  // A whole-image fallback is not a card, and there is nothing to check without boxes.
  if (located.noCard || located.fellBackToFullImage || located.locations.length === 0) return located;

  const { data, info } = await sharp(image.path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });

  const verdicts: Array<Verdict | Error> = new Array(located.locations.length);
  let next = 0;
  const worker = async () => {
    while (next < located.locations.length) {
      const index = next++;
      ctx.signal?.throwIfAborted();
      try {
        verdicts[index] = await judge(llm, image, decoded, located.locations[index]!, index, ctx);
      } catch (error) {
        verdicts[index] = error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, located.locations.length) }, worker));

  const pause = verdicts.find((verdict) => verdict instanceof JobPauseError);
  if (pause) throw pause;
  ctx.signal?.throwIfAborted();

  let corrected = 0;
  let unchecked = 0;
  const locations = located.locations.map((location, index): CardLocation => {
    const verdict = verdicts[index];
    if (!verdict || verdict instanceof Error || verdict.kind === 'unsure') {
      unchecked += 1;
      return location;
    }
    if (verdict.rotation !== location.rotation) corrected += 1;
    return { ...location, rotation: verdict.rotation };
  });

  const cards = (count: number) => `${count} ${count === 1 ? 'card' : 'cards'}`;
  const notes = [
    located.note,
    corrected > 0 ? `Turned ${corrected} of ${cards(locations.length)} after checking each one's orientation.` : null,
    unchecked > 0 ? `${cards(unchecked)} kept locate's rotation because the orientation could not be checked.` : null,
  ].filter((note): note is string => note !== null);
  return { ...located, locations, note: notes.length > 0 ? notes.join(' ') : null };
}
