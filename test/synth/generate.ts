/**
 * Builds the known-answer card set in test/.artifacts/synth: images plus truth.json.
 * Generators are committed and images are not. Output is reused until a generator
 * changes. To build by hand: node test/synth/generate.ts [--force]
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

import { CARD_CONTENT, generatedPerson, perfectRead, printedLines, rowOf } from './content.ts';
import type { CardContent } from './content.ts';
import { applyDegradations, noCardPhoto } from './degrade.ts';
import type { Degradation } from './degrade.ts';
import { cardSize, openRenderer } from './render.ts';
import type { Renderer } from './render.ts';
import { buildSheet } from './sheets.ts';
import type { SheetLayout, SheetResolution } from './sheets.ts';
import type { TruthCard, TruthFile, TruthSet } from './truth.ts';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

export const SYNTH_DIR = resolve(here, '..', '.artifacts', 'synth');
export const SYNTH_TRUTH = join(SYNTH_DIR, 'truth.json');

interface Recipe {
  name: string;
  steps: Degradation[];
  jpeg?: number;
}

const onTable: Degradation = { kind: 'table' };

/** Each degraded photo gets a fresh marker, so its truth is its own. */
const RECIPES: Recipe[] = [
  { name: 'rotate-90', steps: [onTable, { kind: 'rotate', angle: 90 }] },
  { name: 'rotate-180', steps: [onTable, { kind: 'rotate', angle: 180 }] },
  { name: 'rotate-270', steps: [onTable, { kind: 'rotate', angle: 270 }] },
  { name: 'skew-small', steps: [onTable, { kind: 'skew', degrees: 3 }] },
  { name: 'skew-negative', steps: [onTable, { kind: 'skew', degrees: -5 }] },
  { name: 'perspective', steps: [onTable, { kind: 'perspective', strength: 0.08 }] },
  { name: 'perspective-strong', steps: [onTable, { kind: 'perspective', strength: 0.16 }] },
  { name: 'blur-mild', steps: [onTable, { kind: 'blur', sigma: 1.2 }] },
  { name: 'blur-heavy', steps: [onTable, { kind: 'blur', sigma: 3 }] },
  { name: 'dim', steps: [onTable, { kind: 'dim', factor: 0.45 }] },
  { name: 'dim-heavy', steps: [onTable, { kind: 'dim', factor: 0.25 }] },
  { name: 'glare', steps: [onTable, { kind: 'glare' }] },
  { name: 'jpeg-artefacts', steps: [onTable], jpeg: 18 },
  { name: 'jpeg-heavy', steps: [onTable], jpeg: 8 },
  { name: 'small-scan', steps: [{ kind: 'shrink', width: 420 }] },
  { name: 'rotated-dim', steps: [onTable, { kind: 'rotate', angle: 90 }, { kind: 'dim', factor: 0.5 }] },
  { name: 'skew-blur', steps: [onTable, { kind: 'skew', degrees: 4 }, { kind: 'blur', sigma: 1.5 }] },
  { name: 'upside-down-glare', steps: [onTable, { kind: 'glare' }, { kind: 'rotate', angle: 180 }] },
  { name: 'perspective-jpeg', steps: [onTable, { kind: 'perspective', strength: 0.1 }], jpeg: 30 },
  { name: 'dim-blur', steps: [onTable, { kind: 'dim', factor: 0.5 }, { kind: 'blur', sigma: 1.5 }] },
];

const SHEETS: Array<{ count: number; layout: SheetLayout; resolution: SheetResolution }> = [
  { count: 30, layout: 'grid', resolution: 'high' },
  { count: 36, layout: 'grid', resolution: 'phone' },
  { count: 42, layout: 'uneven', resolution: 'high' },
  { count: 30, layout: 'uneven', resolution: 'phone' },
  { count: 36, layout: 'mixed_rotation', resolution: 'high' },
  { count: 42, layout: 'mixed_rotation', resolution: 'phone' },
  { count: 42, layout: 'overlap', resolution: 'high' },
  { count: 36, layout: 'overlap', resolution: 'phone' },
];

function sourceHash(): string {
  const hash = createHash('sha256');
  const roots = [here, resolve(here, '..', 'fake-openai')];
  for (const root of roots) {
    for (const name of readdirSync(root).sort()) {
      if (name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'server.ts') hash.update(readFileSync(join(root, name)));
    }
  }
  return hash.digest('hex');
}

/**
 * A degraded photo or a sheet can send any card to a person, so only a clean card
 * may promise 'verified'. A promise of review holds everywhere.
 */
function reviewPromiseOnly(card: TruthCard): TruthCard {
  if (card.expectedStatus !== 'verified') return card;
  const { expectedStatus: _dropped, ...rest } = card;
  return rest;
}

function truthFor(content: CardContent, markerId: number, buckets: string[] = []): TruthCard {
  const { width, height } = cardSize(content);
  return {
    row: rowOf(content),
    printed: printedLines(content),
    difficulty: content.difficulty,
    buckets,
    tags: content.tags,
    ...(content.expectedStatus ? { expectedStatus: content.expectedStatus } : {}),
    readingOrder: 0,
    markerId,
    aspect: width / height,
    read: perfectRead(content),
  };
}

async function build(renderer: Renderer): Promise<TruthSet> {
  let nextMarker = 1;
  const files: TruthFile[] = [];
  const write = async (relative: string, data: Buffer) => {
    const path = join(SYNTH_DIR, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  };
  const stamp = async (content: CardContent) => {
    const markerId = nextMarker;
    nextMarker += 1;
    return { markerId, png: await renderer.render(content, markerId) };
  };

  /* Clean cards. */
  for (const content of CARD_CONTENT) {
    const { markerId, png } = await stamp(content);
    const file = `clean/${content.key}.png`;
    await write(file, png);
    files.push({ file, cards: [truthFor(content, markerId, ['clean'])] });
  }

  /* Degraded photos, cycling through the content so each is a real card. */
  for (const [index, recipe] of RECIPES.entries()) {
    const content = CARD_CONTENT[index % CARD_CONTENT.length]!;
    const { markerId, png } = await stamp(content);
    const degraded = await applyDegradations(png, recipe.steps);
    const data = recipe.jpeg ? await sharp(degraded).flatten({ background: '#fff' }).jpeg({ quality: recipe.jpeg }).toBuffer() : degraded;
    const file = `degraded/${recipe.name}.${recipe.jpeg ? 'jpg' : 'png'}`;
    await write(file, data);
    const card = reviewPromiseOnly(truthFor(content, markerId, ['degraded', `degraded:${recipe.name}`]));
    card.tags = [...(card.tags ?? []), 'degraded'];
    card.difficulty = content.difficulty === 'easy' ? 'medium' : 'hard';
    files.push({ file, cards: [card] });
  }

  /* Eight-card scanner sheets. */
  for (const [number, layout] of (['grid', 'mixed_rotation'] as const).entries()) {
    const contents = Array.from({ length: 8 }, (_, index) => generatedPerson(100 + number * 10 + index));
    const stamped = await Promise.all(contents.map((content) => ({ content, markerId: 0 })));
    const pngs: Buffer[] = [];
    for (const entry of stamped) {
      const { markerId, png } = await stamp(entry.content);
      entry.markerId = markerId;
      pngs.push(png);
    }
    const sheet = await buildSheet(pngs, { layout, resolution: 'high', seed: 11 + number });
    const file = `sheets/eight-${layout}.jpg`;
    await write(file, sheet.image);
    files.push({
      file,
      cards: sheet.placed.map((place) => ({
        ...reviewPromiseOnly(truthFor(stamped[place.index]!.content, stamped[place.index]!.markerId, ['sheet-8'])),
        readingOrder: place.readingOrder,
        box: place.box,
        rotationNeeded: place.rotationNeeded,
      })),
    });
  }

  /* Sheets of 30 or more. Every sixth card is a hard one, the rest are made-up people. */
  for (const [number, plan] of SHEETS.entries()) {
    const entries: Array<{ content: CardContent; markerId: number }> = [];
    const pngs: Buffer[] = [];
    for (let index = 0; index < plan.count; index += 1) {
      const hard = index % 6 === 5;
      const pool = CARD_CONTENT.filter((content) => content.design.layout !== 'vertical');
      const content = hard ? pool[(number * 7 + index) % pool.length]! : generatedPerson(200 + number * 50 + index);
      const stamped = await stamp(content);
      entries.push({ content, markerId: stamped.markerId });
      pngs.push(stamped.png);
    }
    const sheet = await buildSheet(pngs, { layout: plan.layout, resolution: plan.resolution, seed: 21 + number });
    const file = `sheets/${plan.count}-${plan.layout}-${plan.resolution}.jpg`;
    await write(file, sheet.image);
    files.push({
      file,
      cards: sheet.placed.map((place) => {
        const { content, markerId } = entries[place.index]!;
        return {
          ...reviewPromiseOnly(truthFor(content, markerId, ['sheet-30+', `sheet:${plan.layout}`, `sheet:${plan.resolution}`])),
          readingOrder: place.readingOrder,
          box: place.box,
          rotationNeeded: place.rotationNeeded,
        };
      }),
    });
  }

  /* Files that are not one tidy image. */
  const first = CARD_CONTENT[0]!;

  await write('special/no-card.jpg', await noCardPhoto());
  files.push({ file: 'special/no-card.jpg', expect: 'no_card', cards: [], note: 'A photo with no card in it.' });

  const original = await readFile(join(SYNTH_DIR, files[0]!.file));
  await write('special/not-really.jpg', original.subarray(0, 300));
  files.push({ file: 'special/not-really.jpg', expect: 'failed', cards: [], note: 'A truncated image.' });
  await write('special/noise.png', Buffer.from(Array.from({ length: 4096 }, (_, index) => (index * 37) % 251)));
  files.push({ file: 'special/noise.png', expect: 'failed', cards: [], note: 'Not an image at all.' });

  await copyFile(join(SYNTH_DIR, files[0]!.file), join(SYNTH_DIR, 'clean-copy.png'));
  files.push({ file: 'clean-copy.png', expect: 'duplicate', duplicateOf: files[0]!.file, cards: [], note: 'A byte-for-byte copy.' });

  const wrongExtension = await stamp(CARD_CONTENT[1]!);
  await write('special/jpeg-named-png.png', await sharp(wrongExtension.png).jpeg({ quality: 90 }).toBuffer());
  files.push({ file: 'special/jpeg-named-png.png', cards: [truthFor(CARD_CONTENT[1]!, wrongExtension.markerId, ['format'])] });

  const heic = await stamp(CARD_CONTENT[2]!);
  await mkdir(join(SYNTH_DIR, 'special'), { recursive: true });
  const heicSource = join(SYNTH_DIR, 'special', 'heic-source.tmp.png');
  await writeFile(heicSource, heic.png);
  await run('sips', ['-s', 'format', 'heic', heicSource, '--out', join(SYNTH_DIR, 'special', 'iphone-photo.heic')]);
  await rm(heicSource);
  files.push({ file: 'special/iphone-photo.heic', cards: [truthFor(CARD_CONTENT[2]!, heic.markerId, ['format'])] });

  const exif = await stamp(first);
  await write('special/exif-rotated.jpg', await sharp(exif.png).rotate(270).withMetadata({ orientation: 6 }).jpeg({ quality: 90 }).toBuffer());
  files.push({ file: 'special/exif-rotated.jpg', cards: [truthFor(first, exif.markerId, ['format'])], note: 'Pixels sideways, EXIF says turn 90 degrees.' });

  return { version: 1, source: 'synthetic', files };
}

/** Test files run in parallel, and two builds at once would delete each other's images. */
async function withBuildLock<T>(work: () => Promise<T>): Promise<T> {
  const lock = `${SYNTH_DIR}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  const staleAfterMs = 20 * 60_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      const age = Date.now() - (await stat(lock).then((info) => info.mtimeMs, () => Date.now()));
      if (age > staleAfterMs) await rm(lock, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export function generateSynthSet(force = false): Promise<TruthSet> {
  return withBuildLock(() => buildOrReuse(force));
}

async function buildOrReuse(force: boolean): Promise<TruthSet> {
  const version = sourceHash();
  const stampPath = join(SYNTH_DIR, 'version.txt');
  if (!force && existsSync(SYNTH_TRUTH) && existsSync(stampPath) && readFileSync(stampPath, 'utf8') === version) {
    return JSON.parse(readFileSync(SYNTH_TRUTH, 'utf8')) as TruthSet;
  }
  await rm(SYNTH_DIR, { recursive: true, force: true });
  await mkdir(SYNTH_DIR, { recursive: true });
  const renderer = await openRenderer();
  try {
    const truth = await build(renderer);
    await writeFile(SYNTH_TRUTH, JSON.stringify(truth, null, 2));
    await writeFile(stampPath, version);
    return truth;
  } finally {
    await renderer.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const started = Date.now();
  const truth = await generateSynthSet(process.argv.includes('--force'));
  const cards = truth.files.reduce((sum, file) => sum + file.cards.length, 0);
  console.log(`${truth.files.length} files, ${cards} cards, ${((Date.now() - started) / 1000).toFixed(1)}s, in ${SYNTH_DIR}`);
}
