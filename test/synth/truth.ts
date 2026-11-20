/**
 * The truth file format. Synthetic sets and hand-labelled real cards use the same
 * one, so the accuracy harness runs on either unchanged.
 * test/accuracy/README.md documents it for people.
 */
import type { CardReadData, CardRow, Rotation } from '../../src/shared/contracts.ts';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface TruthCard {
  /** The exact six cells the app should produce. A blank cell is ''. */
  row: CardRow;
  /** Every printed line. Used to tell a misread from an invented value. Optional. */
  printed?: string[];
  difficulty?: Difficulty;
  /** Extra score breakdowns, such as 'sheet-30+'. */
  buckets?: string[];
  /** Why this card is here, such as 'lookalike' or 'fax'. */
  tags?: string[];
  /** Set only when the outcome is certain, such as a card with no name. */
  expectedStatus?: 'verified' | 'needs_review';
  /** 0-based position in reading order within the file. Cards are listed in this order. */
  readingOrder?: number;

  /* Synthetic cards only. */
  markerId?: number;
  aspect?: number;
  read?: CardReadData;
  /** Where the card sits in the file, in pixels. */
  box?: { x: number; y: number; width: number; height: number };
  /** Clockwise turn needed to make the card upright. */
  rotationNeeded?: Rotation;
}

export interface TruthFile {
  /** Path relative to the folder holding truth.json. Files are uploaded in this order. */
  file: string;
  /** What should happen to the file. Defaults to 'cards'. */
  expect?: 'cards' | 'no_card' | 'failed' | 'duplicate';
  /** For 'duplicate': the file this one repeats. */
  duplicateOf?: string;
  /** In reading order. Empty unless expect is 'cards'. */
  cards: TruthCard[];
  note?: string;
}

export interface TruthSet {
  version: 1;
  source: 'synthetic' | 'hand-labelled';
  files: TruthFile[];
}

export function truthCards(set: TruthSet): TruthCard[] {
  return set.files.flatMap((file) => file.cards);
}
