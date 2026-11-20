import type { CreateExtractionService } from '../shared/contracts.ts';
import { compare } from './compare.ts';
import { readCard } from './readCard.ts';
import { toRow } from './toRow.ts';

export { comparisonKey } from './normalize.ts';

export const createExtractionService: CreateExtractionService = ({ llm }) => ({
  readCard: (input, ctx) => readCard(llm, input, ctx),
  compare,
  toRow,
});
