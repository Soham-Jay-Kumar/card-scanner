/** Field-by-field comparison of a card's reads. Pure function. */
import {
  FIELD_KEYS,
  READ_VARIANTS,
  type Agreement,
  type CardReadData,
  type CardRow,
  type FieldConsensus,
  type FieldConsensusMap,
  type FieldKey,
  type ReadRecord,
  type ReadVariant,
} from '../shared/contracts.ts';
import { comparisonKey } from './normalize.ts';
import { toRow } from './toRow.ts';

interface GoodRead {
  variant: ReadVariant;
  data: CardReadData;
  row: CardRow;
}

interface Reading {
  variant: ReadVariant;
  value: string;
}

/** Successful reads, at most one per variant, in A, B, C order. */
function goodReads(reads: ReadRecord[]): GoodRead[] {
  return READ_VARIANTS.flatMap((variant) => {
    const outcome = reads.find((read) => read.variant === variant)?.outcome;
    return outcome?.ok ? [{ variant, data: outcome.data, row: toRow(outcome.data) }] : [];
  });
}

/** The most common exact string in a group. Groups are in A, B, C order, so ties go to the earliest read. */
function mostCommonValue(group: Reading[]): string {
  const counts = new Map<string, number>();
  for (const { value } of group) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

function compareField(field: FieldKey, good: GoodRead[]): FieldConsensus {
  const values: FieldConsensus['values'] = { A: null, B: null, C: null };
  const groups = new Map<string, Reading[]>();
  for (const { variant, row } of good) {
    const value = row[field];
    values[variant] = value;
    const key = comparisonKey(field, value);
    groups.set(key, [...(groups.get(key) ?? []), { variant, value }]);
  }

  // Array.prototype.sort is stable, so equal support keeps A, B, C order.
  const ranked = [...groups.values()].sort((a, b) => b.length - a.length);
  const candidates = ranked.map((group) => ({
    value: mostCommonValue(group),
    reads: group.map((reading) => reading.variant),
  }));

  const top = candidates[0];
  const support = top?.reads.length ?? 0;
  let agreement: Agreement = 'split';
  if (support === READ_VARIANTS.length) agreement = 'unanimous';
  else if (support === 2) agreement = 'majority';

  return {
    field,
    values,
    agreement,
    chosen: agreement === 'split' ? '' : (top?.value ?? ''),
    candidates,
    unreadable: good.some(({ data }) => data.unreadable.includes(field)),
  };
}

export function compare(reads: ReadRecord[]): FieldConsensusMap {
  const good = goodReads(reads);
  return Object.fromEntries(FIELD_KEYS.map((field) => [field, compareField(field, good)])) as FieldConsensusMap;
}
