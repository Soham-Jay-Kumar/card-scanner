import { describe, expect, it } from 'vitest';
import type { Reconciliation } from '../shared/contracts.ts';
import { estimate } from './progress.ts';

const reconciliation = (fields: Partial<Reconciliation>): Reconciliation => ({
  files: 0,
  duplicateFiles: 0,
  noCardFiles: 0,
  failedFiles: 0,
  filesInProgress: 0,
  cards: 0,
  verified: 0,
  confirmed: 0,
  needsReview: 0,
  rejected: 0,
  failedCards: 0,
  cardsInProgress: 0,
  balanced: true,
  ...fields,
});

const NOW = 1_000_000;
/** One card finished every second for the last 30 seconds. */
const steady = (): number[] => Array.from({ length: 30 }, (_, i) => NOW - 30_000 + i * 1_000);

describe('estimate', () => {
  it('has no rate or ETA before a card finishes', () => {
    expect(estimate(NOW - 30_000, [], reconciliation({ cardsInProgress: 5 }), NOW)).toEqual({ cardsPerMinute: 0, etaSeconds: null });
  });

  it('measures cards over the elapsed time, then over the last minute', () => {
    expect(estimate(NOW - 30_000, steady(), reconciliation({}), NOW).cardsPerMinute).toBe(60);
    expect(estimate(NOW - 600_000, steady(), reconciliation({}), NOW).cardsPerMinute).toBe(30);
  });

  it('forgets cards older than the window', () => {
    const finishedAt = [NOW - 120_000, ...steady()];
    estimate(NOW - 600_000, finishedAt, reconciliation({}), NOW);
    expect(finishedAt).toHaveLength(30);
  });

  it('does not treat the first card as a huge rate', () => {
    expect(estimate(NOW - 100, [NOW], reconciliation({}), NOW).cardsPerMinute).toBe(12);
  });

  it('gives no ETA while no file has been located, because the card total is unknown', () => {
    const result = estimate(NOW - 30_000, steady(), reconciliation({ files: 100, filesInProgress: 100 }), NOW);
    expect(result).toEqual({ cardsPerMinute: 60, etaSeconds: null });
  });

  it('counts known cards when every file is located', () => {
    const result = estimate(NOW - 30_000, steady(), reconciliation({ files: 2, cards: 72, cardsInProgress: 60 }), NOW);
    expect(result.etaSeconds).toBe(60);
  });

  it('projects unlocated files from what located files have yielded', () => {
    // 2 sheets gave 72 cards, so the 3 files left should give about 108 more.
    const result = estimate(NOW - 30_000, steady(), reconciliation({ files: 5, filesInProgress: 3, cards: 72, cardsInProgress: 12 }), NOW);
    expect(result.etaSeconds).toBe(120);
  });

  it('leaves files that gave no cards out of the projection', () => {
    const result = estimate(
      NOW - 30_000,
      steady(),
      reconciliation({ files: 12, noCardFiles: 5, failedFiles: 1, duplicateFiles: 2, filesInProgress: 2, cards: 2, cardsInProgress: 0 }),
      NOW,
    );
    // 2 files made 2 cards, so the 2 left add 2 more at 1 card per second.
    expect(result.etaSeconds).toBe(2);
  });

  it('handles pairs, where two files make one card', () => {
    const result = estimate(NOW - 30_000, steady(), reconciliation({ files: 10, filesInProgress: 4, cards: 3, cardsInProgress: 1 }), NOW);
    expect(result.etaSeconds).toBe(3);
  });
});
