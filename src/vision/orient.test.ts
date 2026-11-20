import { readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG } from '../shared/config.ts';
import { JobPauseError, SCHEMA_NAMES } from '../shared/contracts.ts';
import type { LlmCallContext, LlmParseRequest, LlmParseResult, LocateResult, NormalizedImage, Rotation } from '../shared/contracts.ts';
import { orientationPicture, orientCards, OrientWireSchema } from './orient.ts';
import { cornersMatch, cornersRaw, LOCATE_CTX, rawPixels, saveNormalized, tiltedAwayBy, withTempDir } from './testFixtures.ts';

let dir: string;
let cleanup: () => Promise<void>;
let image: NormalizedImage;

const CARD = { width: 100, height: 100 };

/** A 600x400 frame with two square cards that need turning 90 degrees clockwise to be upright. */
beforeAll(async () => {
  ({ dir, cleanup } = await withTempDir('orient'));
  const card = await tiltedAwayBy(90, await sharp(cornersRaw(CARD.width, CARD.height), { raw: { ...CARD, channels: 3 } }).png().toBuffer());
  const frame = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#6a6f75' } })
    .composite([
      { input: card, left: 50, top: 50 },
      { input: card, left: 300, top: 150 },
    ])
    .png()
    .toBuffer();
  image = await saveNormalized(frame, path.join(dir, 'frame.jpg'));
});
afterAll(() => cleanup());

const located = (rotations: Rotation[], extra: Partial<LocateResult> = {}): LocateResult => ({
  noCard: false,
  fellBackToFullImage: false,
  countConfirmed: true,
  note: null,
  locations: rotations.map((rotation, index) => ({ box: { x: 50 + index * 250, y: 50 + index * 100, width: 100, height: 100 }, rotation })),
  ...extra,
});

type Answer = number | 'fail' | Error;

/** Answers each card by the number in its picture's file name, whatever order the calls arrive in. */
function orientLlm(answers: Answer[]) {
  const calls: Array<{ request: LlmParseRequest<unknown>; ctx: LlmCallContext }> = [];
  const llm = {
    calls,
    parse: async <T>(request: LlmParseRequest<T>, ctx: LlmCallContext): Promise<LlmParseResult<T>> => {
      calls.push({ request: request as LlmParseRequest<unknown>, ctx });
      const card = Number(/-orient-(\d+)\.jpg$/.exec(request.imagePaths[0]!)![1]) - 1;
      const answer = answers[card]!;
      if (answer instanceof Error) throw answer;
      const base = { usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 }, latencyMs: 1, attempts: 1 };
      if (answer === 'fail') return { ok: false, failure: 'refused', detail: 'no', ...base };
      return { ok: true, value: { upright_tile: answer } as T, model: 'gpt-6-luna', ...base };
    },
  };
  return llm;
}

describe('the picture shown to the model', () => {
  it('shows the card as locate turned it in tile 1, and a further quarter turn in each later tile', async () => {
    const { data, info } = await sharp(image.path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const decoded = sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } });
    const box = { x: 50, y: 50, width: 100, height: 100 };

    // Locate says 90, which is right: tile 1 is upright and tile 3, a half turn on, is upside down.
    const right = sharp(await orientationPicture(decoded, image, { box, rotation: 90 }));
    const tile = async (picture: Sharp, n: number) => {
      const size = (await picture.metadata()).width!;
      const half = (size - 8) / 2;
      return rawPixels(await picture.clone().extract({ left: ((n - 1) % 2) * (half + 8), top: Math.floor((n - 1) / 2) * (half + 8), width: half, height: half }).png().toBuffer());
    };
    expect(cornersMatch(await tile(right, 1))).toBe(true);
    expect(cornersMatch(await tile(right, 3))).toBe(false);

    // Locate says 270, which is wrong: the upright card is three tiles on from tile 1... that is, tile 3.
    const wrong = sharp(await orientationPicture(decoded, image, { box, rotation: 270 }));
    expect(cornersMatch(await tile(wrong, 1))).toBe(false);
    expect(cornersMatch(await tile(wrong, 3))).toBe(true);
  });
});

describe('orientCards', () => {
  it('turns a card the model says is upside down, the way the real photo went wrong', async () => {
    // Locate said 90 for both cards; the model sees tile 3 (a further half turn) upright for the first.
    const llm = orientLlm([3, 1]);
    const result = await orientCards(llm, image, located([90, 90]), LOCATE_CTX);

    expect(result.locations.map((location) => location.rotation)).toEqual([270, 90]);
    expect(result.note).toContain('Turned 1 of 2 cards');
    expect(result.locations.map((location) => location.box)).toEqual(located([90, 90]).locations.map((location) => location.box));
  });

  it('wraps past 360 and handles every tile', async () => {
    const llm = orientLlm([1, 2, 3, 4]);
    const four = { ...located([270, 270, 270, 270]) };
    four.locations = four.locations.map((location, index) => ({ ...location, box: { ...location.box, x: 10 + index * 120, y: 10 } }));
    const result = await orientCards(llm, image, four, LOCATE_CTX);
    expect(result.locations.map((location) => location.rotation)).toEqual([270, 0, 90, 180]);
  });

  it('asks one question per card, with the orient schema, effort and purpose, and cleans up its pictures', async () => {
    const llm = orientLlm([1, 1]);
    await orientCards(llm, image, located([0, 0]), LOCATE_CTX);

    expect(llm.calls).toHaveLength(2);
    for (const { request, ctx } of llm.calls) {
      expect(request.schemaName).toBe(SCHEMA_NAMES.orient);
      expect(request.reasoningEffort).toBe(CONFIG.reasoningEffort.orient);
      expect(request.maxOutputTokens).toBe(CONFIG.maxOutputTokens.orient);
      expect(request.imagePaths).toHaveLength(1);
      expect(ctx).toMatchObject({ jobId: LOCATE_CTX.jobId, fileId: LOCATE_CTX.fileId, purpose: 'orient' });
    }
    expect((await readdir(dir)).filter((name) => name.includes('-orient-'))).toEqual([]);
  });

  it('keeps locate\'s rotation, and says so, when the model cannot tell or the call fails', async () => {
    const llm = orientLlm([0, 'fail']);
    const result = await orientCards(llm, image, located([90, 180]), LOCATE_CTX);

    expect(result.locations.map((location) => location.rotation)).toEqual([90, 180]);
    expect(result.note).toContain('2 cards kept locate\'s rotation');
  });

  it('keeps locate\'s rotation when the answer is malformed', async () => {
    const llm = orientLlm([7 as never, 1]);
    const result = await orientCards(llm, image, located([90, 90]), LOCATE_CTX);
    expect(result.locations.map((location) => location.rotation)).toEqual([90, 90]);
  });

  it('lets a pause through, because retrying cannot fix it', async () => {
    const llm = orientLlm([1, new JobPauseError('out_of_credit', 'no credit')]);
    await expect(orientCards(llm, image, located([0, 0]), LOCATE_CTX)).rejects.toBeInstanceOf(JobPauseError);
  });

  it('does nothing for no card, a whole-image fallback, or no boxes', async () => {
    const llm = orientLlm([]);
    const empty: LocateResult = { noCard: true, locations: [], fellBackToFullImage: false, countConfirmed: true, note: 'none' };
    expect(await orientCards(llm, image, empty, LOCATE_CTX)).toBe(empty);
    const fallback = located([0], { fellBackToFullImage: true, countConfirmed: false });
    expect(await orientCards(llm, image, fallback, LOCATE_CTX)).toBe(fallback);
    expect(llm.calls).toHaveLength(0);
  });

  it('keeps an existing locate note', async () => {
    const llm = orientLlm([3]);
    const result = await orientCards(llm, image, located([0], { note: 'Pass 2 failed.' }), LOCATE_CTX);
    expect(result.note).toBe('Pass 2 failed. Turned 1 of 1 card after checking each one\'s orientation.');
  });
});

describe('OrientWireSchema', () => {
  it('accepts 0 to 4 only', () => {
    for (const tile of [0, 1, 2, 3, 4]) expect(OrientWireSchema.safeParse({ upright_tile: tile }).success).toBe(true);
    for (const tile of [5, -1, 1.5, '2']) expect(OrientWireSchema.safeParse({ upright_tile: tile }).success).toBe(false);
  });
});
