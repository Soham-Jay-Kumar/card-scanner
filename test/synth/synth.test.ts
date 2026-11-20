/** Checks the generated set itself. Slow, so RUN_FULL_SYNTH=1 turns it on. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { decodeMarkers, primaryMarker } from '../fake-openai/marker.ts';
import { FULL_SYNTH } from '../helpers/app.ts';
import { generateSynthSet, SYNTH_DIR } from './generate.ts';
import { truthCards } from './truth.ts';

describe.skipIf(!FULL_SYNTH)('synthetic set (RUN_FULL_SYNTH=1)', () => {
  it('covers what the plan asks for, and every marker reads back', async () => {
    const truth = await generateSynthSet();
    const cards = truthCards(truth);
    expect(new Set(cards.map((card) => card.markerId)).size).toBe(cards.length);

    const sheets = truth.files.filter((file) => file.cards.some((card) => card.buckets?.includes('sheet-30+')));
    expect(sheets.map((file) => file.cards.length).sort()).toEqual([30, 30, 36, 36, 36, 42, 42, 42]);
    expect(new Set(sheets.map((file) => /-(grid|uneven|mixed_rotation|overlap)-/.exec(file.file)?.[1])).size).toBe(4);
    expect(new Set(sheets.map((file) => /-(high|phone)\.jpg/.exec(file.file)?.[1])).size).toBe(2);

    for (const file of truth.files) {
      const data = readFileSync(join(SYNTH_DIR, file.file));
      if (file.file.endsWith('.heic') || file.expect === 'failed' || file.expect === 'duplicate') continue;
      if (file.cards.length > 1) {
        const seen = (await decodeMarkers(data, [4000])).map((marker) => marker.id);
        expect(seen.sort((p, q) => p - q), file.file).toEqual(file.cards.map((card) => card.markerId!).sort((p, q) => p - q));
        expect(file.cards.map((card) => card.readingOrder), file.file).toEqual(file.cards.map((_, index) => index));
      } else if (file.cards.length === 1) {
        const marker = primaryMarker(await decodeMarkers(data), () => file.cards[0]!.aspect ?? 1.75);
        expect(marker?.id, file.file).toBe(file.cards[0]!.markerId);
      } else {
        expect(await decodeMarkers(data), file.file).toEqual([]);
      }
    }
  }, 20 * 60_000);
});
