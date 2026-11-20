import type { CreatePasteService } from '../shared/contracts.ts';
import { encode } from './encode.ts';
import { createPasteboard } from './pasteboard.ts';
import { verifyPaste } from './verifyPaste.ts';

export const createPasteService: CreatePasteService = () => ({
  encode,
  verifyPaste,
  ...createPasteboard(),
});

export { PHONE_CASES, phoneCaseRows } from './phoneCases.ts';
export type { PhoneCase } from './phoneCases.ts';
