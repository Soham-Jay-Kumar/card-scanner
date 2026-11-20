/**
 * Layer 4 of the phone paste fix: compare text copied back out of a spreadsheet
 * with what should be there. Works on any spreadsheet, because it only reads the
 * tab-separated text the spreadsheet puts on the clipboard.
 */
import { COLUMN_HEADERS, FIELD_KEYS } from '../shared/contracts.ts';
import type { CardRow, FieldKey, VerifyPasteDifference, VerifyPasteReport } from '../shared/contracts.ts';
import { looksLikeDate, sanitizeCell } from './encode.ts';

interface PastedCell {
  value: string;
  /** The text exactly as pasted, for cells that merely look quoted. */
  raw: string;
}

const isDelimiter = (char: string | undefined): boolean =>
  char === undefined || char === '\t' || char === '\n' || char === '\r';

/** Reads a "quoted" cell. Returns null when the text is not a complete quoted cell. */
function readQuotedCell(text: string, start: number): { cell: PastedCell; next: number } | null {
  let value = '';
  let from = start + 1;
  for (;;) {
    const quote = text.indexOf('"', from);
    if (quote === -1) return null;
    value += text.slice(from, quote);
    if (text[quote + 1] === '"') {
      value += '"';
      from = quote + 2;
    } else if (isDelimiter(text[quote + 1])) {
      return { cell: { value, raw: text.slice(start, quote + 1) }, next: quote + 1 };
    } else {
      return null;
    }
  }
}

function readCell(text: string, start: number): { cell: PastedCell; next: number } {
  const quoted = text[start] === '"' ? readQuotedCell(text, start) : null;
  if (quoted) return quoted;
  let end = start;
  while (!isDelimiter(text[end])) end += 1;
  const value = text.slice(start, end);
  return { cell: { value, raw: value }, next: end };
}

function parseRows(text: string): PastedCell[][] {
  const rows: PastedCell[][] = [];
  let row: PastedCell[] = [];
  let index = 0;
  while (index < text.length) {
    const { cell, next } = readCell(text, index);
    row.push(cell);
    index = next;
    if (index >= text.length) break;
    if (text[index] === '\t') {
      index += 1;
      // A tab at the very end still opens one last empty cell.
      if (index >= text.length) row.push({ value: '', raw: '' });
      continue;
    }
    index += text.startsWith('\r\n', index) ? 2 : 1;
    rows.push(row);
    row = [];
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

const isBlank = (cell: PastedCell): boolean => cell.value.trim() === '';

function isHeaderRow(row: PastedCell[]): boolean {
  const hasExtraContent = row.slice(FIELD_KEYS.length).some((cell) => !isBlank(cell));
  if (hasExtraContent) return false;
  return FIELD_KEYS.every(
    (field, column) => row[column]?.value.trim().toLowerCase() === COLUMN_HEADERS[field].toLowerCase(),
  );
}

const FORMULA_ERROR = /^#(?:ERROR!|NAME\?|VALUE!|REF!|N\/A|DIV\/0!|NUM!|NULL!|SPILL!|CALC!)$/i;
const SCIENTIFIC = /^[-+]?\d+(?:[.,]\d+)?e[-+]?\d+$/i;
/** The serial number Excel stores for a date, shown when a date cell is formatted as a number. */
const DATE_SERIAL = /^\d{4,6}(?:\.\d+)?$/;

const digitsOf = (text: string): string => text.replace(/\D/g, '');

function classify(expected: string, actual: string): string {
  const shown = actual.trim();
  if (FORMULA_ERROR.test(shown)) return 'formula_error';
  if (SCIENTIFIC.test(shown)) return 'scientific_notation';

  const expectedDigits = digitsOf(expected);
  const actualDigits = digitsOf(actual);
  if (expectedDigits !== '') {
    const startsWithPlus = expected.trimStart().startsWith('+');
    if (startsWithPlus && !shown.includes('+') && expectedDigits === actualDigits) return 'lost_plus';
    if (expectedDigits.startsWith('0') && expectedDigits.replace(/^0+/, '') === actualDigits) {
      return 'lost_leading_zero';
    }
  }

  if (looksLikeDate(shown) || (looksLikeDate(expected) && DATE_SERIAL.test(shown))) return 'date';
  return 'changed';
}

export function verifyPaste(expected: CardRow[], pastedText: string): VerifyPasteReport {
  const rows = parseRows(pastedText);
  if (rows[0] && isHeaderRow(rows[0])) rows.shift();
  while (rows.length > expected.length && rows.at(-1)?.every(isBlank)) rows.pop();

  const differences: VerifyPasteDifference[] = [];
  const lastField: FieldKey = 'website';
  const rowsInBoth = Math.min(rows.length, expected.length);

  for (let rowIndex = 0; rowIndex < rowsInBoth; rowIndex += 1) {
    const pasted = rows[rowIndex] ?? [];
    const row = rowIndex + 1;
    FIELD_KEYS.forEach((field, column) => {
      const wanted = sanitizeCell(expected[rowIndex]?.[field] ?? '');
      const cell = pasted[column];
      const actual = cell?.value ?? '';
      if (actual === wanted || cell?.raw === wanted) return;
      differences.push({ row, field, expected: wanted, actual, kind: classify(wanted, actual) });
    });
    // Content past the last column means this row shifted sideways.
    for (const extra of pasted.slice(FIELD_KEYS.length)) {
      if (!isBlank(extra)) {
        differences.push({ row, field: lastField, expected: '', actual: extra.value, kind: 'extra_column' });
      }
    }
  }

  for (let rowIndex = rowsInBoth; rowIndex < expected.length; rowIndex += 1) {
    for (const field of FIELD_KEYS) {
      const wanted = sanitizeCell(expected[rowIndex]?.[field] ?? '');
      if (wanted !== '') {
        differences.push({ row: rowIndex + 1, field, expected: wanted, actual: '', kind: 'missing_row' });
      }
    }
  }

  for (let rowIndex = rowsInBoth; rowIndex < rows.length; rowIndex += 1) {
    const pasted = rows[rowIndex] ?? [];
    const column = pasted.findIndex((cell) => !isBlank(cell));
    differences.push({
      row: rowIndex + 1,
      field: FIELD_KEYS[Math.max(0, Math.min(column, FIELD_KEYS.length - 1))] ?? lastField,
      expected: '',
      actual: pasted.map((cell) => cell.value).join('\t'),
      kind: 'extra_row',
    });
  }

  return {
    ok: rows.length === expected.length && differences.length === 0,
    rowsExpected: expected.length,
    rowsFound: rows.length,
    cellsCompared: rowsInBoth * FIELD_KEYS.length,
    differences,
  };
}
