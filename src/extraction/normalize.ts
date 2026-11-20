/**
 * Comparison keys: two cells agree when their keys are equal. Keys are for
 * comparing only and must never reach a spreadsheet cell.
 */
import { MULTI_VALUE_SEPARATOR, type FieldKey } from '../shared/contracts.ts';
import { normalizeText } from '../shared/text.ts';

/** A + counts as leading when it comes before the first digit or letter, as in `(+91) 98765`. */
const LEADING_PLUS = /^[^\p{L}\p{Nd}]*\+/u;
const NOT_DIGIT_OR_LETTER = /[^\p{L}\p{Nd}]/gu;

/**
 * Digits plus any leading +. Letters are kept as well, so a misread letter in
 * `1-800-FLOWERS` or a label left in the number still counts as a difference.
 */
function phoneKey(value: string): string {
  const text = normalizeText(value).toLowerCase();
  return (LEADING_PLUS.test(text) ? '+' : '') + text.replace(NOT_DIGIT_OR_LETTER, '');
}

function caseInsensitiveKey(value: string): string {
  return normalizeText(value).toLowerCase();
}

/** Multi-value cells compare as sets, so printed order doesn't matter. */
function setKey(cell: string, valueKey: (value: string) => string): string {
  const keys = cell.split(MULTI_VALUE_SEPARATOR).map(valueKey).filter(Boolean);
  return [...new Set(keys)].sort().join('\n');
}

/** Builds the comparison key for one final cell of the given field. */
export function comparisonKey(field: FieldKey, cell: string): string {
  switch (field) {
    case 'email':
    case 'website':
      return setKey(cell, caseInsensitiveKey);
    case 'phone':
      return setKey(cell, phoneKey);
    default:
      return normalizeText(cell);
  }
}
