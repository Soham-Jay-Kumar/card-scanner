/**
 * Speed and time-left estimates. Everything is counted in cards: a file can hold
 * one card or 36, and the card total isn't known until each file is located.
 */
import type { Reconciliation } from '../shared/contracts.ts';

const RATE_WINDOW_MS = 60_000;
/** Stops the first finished card from reading as a huge rate. */
const MIN_RATE_SPAN_MS = 5_000;

export interface Estimate {
  cardsPerMinute: number;
  etaSeconds: number | null;
}

/** Drops old entries from finishedAt, which is in time order. */
export function estimate(startedAt: number, finishedAt: number[], reconciliation: Reconciliation, now: number): Estimate {
  while (finishedAt.length > 0 && (finishedAt[0] ?? now) < now - RATE_WINDOW_MS) finishedAt.shift();
  const spanMs = Math.max(MIN_RATE_SPAN_MS, Math.min(RATE_WINDOW_MS, now - startedAt));
  const cardsPerMinute = (finishedAt.length * 60_000) / spanMs;
  if (cardsPerMinute === 0) return { cardsPerMinute: 0, etaSeconds: null };

  const { files, duplicateFiles, noCardFiles, failedFiles, filesInProgress, cards, cardsInProgress } = reconciliation;
  const cardFiles = files - duplicateFiles - noCardFiles - failedFiles - filesInProgress;
  // Unlocated files are unknown, so assume they yield what the located ones have.
  if (filesInProgress > 0 && cardFiles === 0) return { cardsPerMinute, etaSeconds: null };
  const expectedCards = filesInProgress > 0 ? filesInProgress * (cards / cardFiles) : 0;
  return { cardsPerMinute, etaSeconds: Math.round(((cardsInProgress + expectedCards) / cardsPerMinute) * 60) };
}
