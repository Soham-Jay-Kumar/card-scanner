/**
 * The one text normaliser used for every comparison, so no two teams can
 * compare strings differently. This is for comparing only: never use it to
 * produce a cell value, because cells must stay exactly as printed.
 */
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

export function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}
