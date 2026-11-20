/** The runner end to end on a tiny folder: real app, fake server, a truth.json from disk. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadApp, tempDataDir } from '../helpers/app.ts';
import { cardFile, testCard } from '../helpers/fixtures.ts';
import { printedLines } from '../synth/content.ts';
import type { TruthSet } from '../synth/truth.ts';
import { runAccuracy } from './run.ts';

const { createApp, skipReason } = await loadApp();

describe.skipIf(!createApp)(`accuracy runner ${skipReason}`, () => {
  it('scores a folder with no key set, and refuses unmarked cards rather than guess', async () => {
    const folder = await mkdtemp(join(await tempDataDir(), 'cards-'));
    const cards = [testCard(3420), testCard(3421)];
    const truth: TruthSet = { version: 1, source: 'synthetic', files: [] };
    for (const card of cards) {
      const file = await cardFile(card);
      await writeFile(join(folder, file.name), file.bytes);
      truth.files.push({
        file: file.name,
        cards: [{ row: card.row, printed: printedLines(card.content), difficulty: 'easy', buckets: ['sheet-30+'], markerId: card.markerId, aspect: 1.75, read: card.fake.read }],
      });
    }
    const truthPath = join(folder, 'truth.json');
    await writeFile(truthPath, JSON.stringify(truth));

    const report = await runAccuracy({ truthPath, noise: { rate: 0 } });
    expect(report.reader).toBe('fake');
    expect(report.cardsFound).toBe(2);
    expect(report.overall.accuracy).toBe(1);
    expect(report.overall.verifiedAccuracy).toBe(1);
    expect(report.buckets.find((bucket) => bucket.bucket === 'sheet-30+')?.cards).toBe(2);

    const unmarked = join(folder, 'hand.json');
    await writeFile(unmarked, JSON.stringify({ version: 1, source: 'hand-labelled', files: [{ file: 'x.jpg', cards: [{ row: cards[0]!.row }] }] }));
    await expect(runAccuracy({ truthPath: unmarked })).rejects.toThrow(/need OPENAI_API_KEY/);
    await rm(folder, { recursive: true, force: true });
  }, 5 * 60_000);
});
