/**
 * Scores app results against truth, per field, as an exact string match. Pure:
 * it reads results and truth and knows nothing about who produced them, so the
 * same code scores the fake server, the live API and hand-labelled real cards.
 */
import { FIELD_KEYS, MULTI_VALUE_SEPARATOR } from '../../src/shared/contracts.ts';
import type { CardRow, CardStatus, FieldKey } from '../../src/shared/contracts.ts';
import { normalizeText } from '../../src/shared/text.ts';
import type { TruthCard, TruthSet } from '../synth/truth.ts';

export interface ResultCard {
  file: string;
  /** Position within its file. Reading order is checked from this. */
  index: number;
  status: CardStatus;
  /** The value the app holds, whether verified or pre-selected for review. */
  row: CardRow | null;
}

export interface ResultFile {
  file: string;
  stage: string;
}

export type Reader = 'fake' | 'live';
export type FieldOutcome = 'exact' | 'misread' | 'invented' | 'missing';

export interface FieldError {
  file: string;
  field: FieldKey;
  expected: string;
  actual: string;
  outcome: FieldOutcome;
  status: CardStatus | 'lost';
}

export interface BucketScore {
  bucket: string;
  cards: number;
  verifiedCards: number;
  reviewCards: number;
  lostCards: number;
  fields: number;
  exactFields: number;
  verifiedFields: number;
  verifiedExactFields: number;
  inventedValues: number;
  /** All fields, including ones a person would still check. */
  accuracy: number;
  /** null when no card in this bucket was verified. */
  verifiedAccuracy: number | null;
  reviewRate: number;
  verifiedRate: number;
}

export interface TargetResult {
  target: string;
  required: string;
  measured: string;
  met: boolean;
}

export interface AccuracyReport {
  reader: Reader;
  warning: string;
  overall: BucketScore;
  buckets: BucketScore[];
  cardsExpected: number;
  cardsFound: number;
  cardsLost: number;
  extraCards: number;
  /** Files that did not end as truth said they should. */
  fileProblems: string[];
  /** Files whose cards came back in a different order from truth's reading order. */
  outOfOrderFiles: string[];
  /** Cards the rules said must go to a person, or must verify, that did not. */
  statusProblems: string[];
  /** Verified values that differ from truth. The worst possible errors. */
  wrongVerified: FieldError[];
  inventedValues: FieldError[];
  targets: TargetResult[];
}

const CLOSE_RATIO = 0.34;
export const FAKE_WARNING =
  'These scores come from the FAKE server, which answers from a table of known cards and reads no text. They prove the pipeline logic only and say nothing about real Luna accuracy.';
export const LIVE_NOTE = 'Live gpt-6-luna results.';

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const holding = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = holding;
    }
  }
  return row[b.length]!;
}

function closeToAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => editDistance(value, candidate) <= Math.max(2, CLOSE_RATIO * candidate.length));
}

/**
 * A misread is a wrong copy of something on the card. An invented value is not on
 * the card at all. A filled-in field that truth says is blank always counts as
 * invented, even when its text appears on the card: a website worked out from an
 * email domain is exactly the guess the rules forbid.
 */
export function classifyField(expected: string, actual: string, printed: string[] | undefined): FieldOutcome {
  if (actual === expected) return 'exact';
  if (actual === '') return 'missing';
  if (expected === '') return 'invented';
  const known = expected.split(MULTI_VALUE_SEPARATOR);
  const onCard = normalizeText((printed ?? []).join('\n'));
  const invented = actual.split(MULTI_VALUE_SEPARATOR).some((part) => {
    const clean = normalizeText(part);
    return !(clean !== '' && onCard.includes(clean)) && !closeToAny(part, known);
  });
  return invented ? 'invented' : 'misread';
}

function matchScore(truth: TruthCard, result: ResultCard): number {
  if (!result.row) return 0;
  return FIELD_KEYS.filter((field) => result.row?.[field] === truth.row[field]).length;
}

/** Best matches first. A sheet's cards can come back in any order, so order is scored apart. */
function alignCards(truths: TruthCard[], results: ResultCard[]): Array<{ truth: TruthCard; result: ResultCard | null }> {
  const pairs = truths
    .flatMap((truth, t) => results.map((result, r) => ({ t, r, truth, result, score: matchScore(truth, result) })))
    .sort((p, q) => q.score - p.score || Math.abs(p.t - p.r) - Math.abs(q.t - q.r));
  const usedT = new Set<number>();
  const usedR = new Set<number>();
  const matched = new Map<number, ResultCard>();
  for (const { t, r, result } of pairs) {
    if (usedT.has(t) || usedR.has(r)) continue;
    usedT.add(t);
    usedR.add(r);
    matched.set(t, result);
  }
  return truths.map((truth, t) => ({ truth, result: matched.get(t) ?? null }));
}

class Tally {
  readonly bucket: string;
  cards = 0;
  verifiedCards = 0;
  reviewCards = 0;
  lostCards = 0;
  fields = 0;
  exactFields = 0;
  verifiedFields = 0;
  verifiedExactFields = 0;
  inventedValues = 0;

  constructor(bucket: string) {
    this.bucket = bucket;
  }

  score(): BucketScore {
    const share = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);
    return {
      bucket: this.bucket,
      cards: this.cards,
      verifiedCards: this.verifiedCards,
      reviewCards: this.reviewCards,
      lostCards: this.lostCards,
      fields: this.fields,
      exactFields: this.exactFields,
      verifiedFields: this.verifiedFields,
      verifiedExactFields: this.verifiedExactFields,
      inventedValues: this.inventedValues,
      accuracy: share(this.exactFields, this.fields),
      verifiedAccuracy: this.verifiedFields === 0 ? null : this.verifiedExactFields / this.verifiedFields,
      reviewRate: share(this.reviewCards, this.cards),
      verifiedRate: share(this.verifiedCards, this.cards),
    };
  }
}

const percent = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(2)}%`);

export function scoreResults(input: { truth: TruthSet; files: ResultFile[]; cards: ResultCard[]; reader: Reader }): AccuracyReport {
  const { truth, files, cards, reader } = input;
  const overall = new Tally('overall');
  const buckets = new Map<string, Tally>();
  const tallyFor = (name: string) => {
    let tally = buckets.get(name);
    if (!tally) {
      tally = new Tally(name);
      buckets.set(name, tally);
    }
    return tally;
  };

  const fileProblems: string[] = [];
  const outOfOrderFiles: string[] = [];
  const statusProblems: string[] = [];
  const wrongVerified: FieldError[] = [];
  const inventedValues: FieldError[] = [];
  let extraCards = 0;
  let cardsFound = 0;

  const stageByFile = new Map(files.map((file) => [file.file, file.stage]));
  const wantedStage = { no_card: 'no_card', failed: 'failed', duplicate: 'duplicate' } as const;

  for (const file of truth.files) {
    const expect = file.expect ?? 'cards';
    const stage = stageByFile.get(file.file);
    if (stage === undefined) fileProblems.push(`${file.file}: no record of this file`);
    else if (expect !== 'cards' && stage !== wantedStage[expect]) fileProblems.push(`${file.file}: expected ${expect}, ended as ${stage}`);

    const found = cards.filter((card) => card.file === file.file).sort((p, q) => p.index - q.index);
    cardsFound += found.length;
    const aligned = alignCards(file.cards, found);
    extraCards += Math.max(0, found.length - file.cards.length);

    const positions = aligned.filter((pair) => pair.result).map((pair) => pair.result!.index);
    if (positions.some((position, index) => index > 0 && position < positions[index - 1]!)) outOfOrderFiles.push(file.file);

    for (const { truth: card, result } of aligned) {
      const tallies = [overall, ...(card.difficulty ? [tallyFor(`difficulty:${card.difficulty}`)] : []), ...(card.buckets ?? []).map(tallyFor)];
      const status = result?.status ?? 'lost';
      const verified = status === 'verified' || status === 'confirmed';
      for (const tally of tallies) {
        tally.cards += 1;
        if (status === 'lost') tally.lostCards += 1;
        else if (verified) tally.verifiedCards += 1;
        else tally.reviewCards += 1;
      }
      if (card.expectedStatus && status !== card.expectedStatus) {
        statusProblems.push(`${file.file} (${card.row.name || 'no name'}): expected ${card.expectedStatus}, got ${status}`);
      }

      for (const field of FIELD_KEYS) {
        const expected = card.row[field];
        const actual = result?.row?.[field] ?? '';
        const outcome = result ? classifyField(expected, actual, card.printed) : 'missing';
        for (const tally of tallies) {
          tally.fields += 1;
          if (outcome === 'exact') tally.exactFields += 1;
          if (outcome === 'invented') tally.inventedValues += 1;
          if (verified) {
            tally.verifiedFields += 1;
            if (outcome === 'exact') tally.verifiedExactFields += 1;
          }
        }
        if (outcome === 'exact') continue;
        const error: FieldError = { file: file.file, field, expected, actual, outcome, status };
        if (verified) wrongVerified.push(error);
        if (outcome === 'invented') inventedValues.push(error);
      }
    }
  }

  const summary = overall.score();
  const targets: TargetResult[] = [
    {
      target: 'Verified fields exact',
      required: '>= 99.5%',
      measured: percent(summary.verifiedAccuracy),
      met: summary.verifiedAccuracy !== null && summary.verifiedAccuracy >= 0.995,
    },
    { target: 'Invented values', required: '0', measured: String(summary.inventedValues), met: summary.inventedValues === 0 },
    { target: 'Verified without a person', required: '>= 85%', measured: percent(summary.verifiedRate), met: summary.verifiedRate >= 0.85 },
  ];

  return {
    reader,
    warning: reader === 'fake' ? FAKE_WARNING : LIVE_NOTE,
    overall: summary,
    buckets: [...buckets.values()].map((tally) => tally.score()).sort((p, q) => p.bucket.localeCompare(q.bucket)),
    cardsExpected: summary.cards,
    cardsFound,
    cardsLost: summary.lostCards,
    extraCards,
    fileProblems,
    outOfOrderFiles,
    statusProblems,
    wrongVerified,
    inventedValues,
    targets,
  };
}

export function formatReport(report: AccuracyReport): string {
  const lines = [
    `Reader: ${report.reader}`,
    report.warning,
    '',
    `Cards: ${report.cardsFound} found of ${report.cardsExpected} expected, ${report.cardsLost} lost, ${report.extraCards} extra.`,
    `Overall field accuracy: ${percent(report.overall.accuracy)}. Review rate: ${percent(report.overall.reviewRate)}.`,
    '',
    'Targets (real cards on the live API are what count):',
    ...report.targets.map((target) => `  ${report.reader === 'fake' ? 'n/a ' : target.met ? 'MET ' : 'MISS'}  ${target.target}: ${target.measured} (needs ${target.required})`),
    '',
    'Breakdown:',
    ...report.buckets.map(
      (b) =>
        `  ${b.bucket.padEnd(28)} cards ${String(b.cards).padStart(4)}  exact ${percent(b.accuracy).padStart(7)}  verified-exact ${percent(b.verifiedAccuracy).padStart(7)}  verified ${percent(b.verifiedRate).padStart(7)}  review ${percent(b.reviewRate).padStart(7)}  lost ${b.lostCards}  invented ${b.inventedValues}`,
    ),
  ];
  const list = (title: string, items: string[]) => {
    if (items.length > 0) lines.push('', `${title}:`, ...items.slice(0, 40).map((item) => `  ${item}`));
  };
  list('Files that ended wrongly', report.fileProblems);
  list('Files out of reading order', report.outOfOrderFiles);
  list('Cards with the wrong status', report.statusProblems);
  list('WRONG VALUES THAT WERE VERIFIED', report.wrongVerified.map((e) => `${e.file} ${e.field}: expected "${e.expected}", got "${e.actual}"`));
  list('Invented values', report.inventedValues.map((e) => `${e.file} ${e.field}: "${e.actual}" (${e.status})`));
  return lines.join('\n');
}
