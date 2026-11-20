/**
 * Layers 2 and 3 of the phone paste fix: turn rows into the two clipboard
 * formats. Pure functions only, so every byte here can be tested without
 * touching the real clipboard.
 */
import { COLUMN_HEADERS, FIELD_KEYS } from '../shared/contracts.ts';
import type { CardRow, ClipboardPayload, FieldKey } from '../shared/contracts.ts';
import { normalizeText } from '../shared/text.ts';

/**
 * UNVERIFIED. Google Sheets' internal type code for "string", used as the value
 * of key "1" in data-sheets-value. The format is undocumented and this value
 * has not been captured from a real Sheets clipboard. Replace it with the value
 * seen when a real text cell is copied out of Google Sheets.
 */
export const SHEETS_STRING_TYPE_CODE = 2;

/** Excel's text format. The backslash is literal: the CSS value is "\@". */
const EXCEL_TEXT_STYLE = 'mso-number-format:"\\@"';

/**
 * Excel rejects a text literal over 255 characters inside a formula, so longer
 * values are joined from pieces. 120 code points is at most 240 UTF-16 units,
 * even when every character is an emoji or a doubled quote.
 */
const FORMULA_PIECE = /.{1,120}/gsu;

/** Tabs, line breaks and other control characters would split or corrupt a cell. */
const CONTROL_CHARS = /\r\n|[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

export function sanitizeCell(value: string): string {
  return value.replace(CONTROL_CHARS, ' ');
}

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const DATE_OR_TIME_PATTERNS = [
  // 10-12-2024, 2024/12/10, 12.05.2024, 3/4, each optionally followed by a time.
  /^\d{1,4}\s*[-/.]\s*\d{1,2}(?:\s*[-/.]\s*\d{1,4})?(?:[T\s]+\d{1,2}:\d{2}\S*(?:\s*[ap]\.?m\.?)?)?$/i,
  // 12:30, 12:30:45, 12:30 PM
  /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[ap]\.?m?\.?)?$/i,
  // 5 PM
  /^\d{1,2}\s*[ap]\.?m\.?$/i,
  // 12-Mar, 4 March 2024
  new RegExp(`^\\d{1,2}(?:st|nd|rd|th)?[-/.\\s]*${MONTH}\\.?(?:[-/.,\\s]+\\d{1,4})?$`, 'i'),
  // Mar-12, Sept 5, March 12, 2024
  new RegExp(`^${MONTH}\\.?[-/.\\s]*\\d{1,4}(?:st|nd|rd|th)?(?:[-/.,\\s]+\\d{1,4})?$`, 'i'),
];

export function looksLikeDate(value: string): boolean {
  const text = normalizeText(value);
  return DATE_OR_TIME_PATTERNS.some((pattern) => pattern.test(text));
}

const OTHER_RISKY_PATTERNS = [
  // Formula starters, the Unicode minus sign, and the two characters spreadsheets
  // treat specially at the start of pasted text: a leading " opens a quoted field
  // that can swallow tabs and rows, and a leading ' can vanish as a text prefix.
  /^[+\-\u2212=@"']/,
  // Numbers: 007, 1,234.50, .5, (5), $5, 5 EUR-style symbols, 50%, 1e5, 5-
  /^\(?\p{Sc}?\s*\.?\d[\d.,\s']*(?:e[+-]?\d+)?\s*[\p{Sc}%]?\)?-?$/iu,
  // Mixed fractions such as 1 1/2. Plain fractions like 3/4 count as dates above.
  /^\d+\s+\d+\/\d+$/,
  /^(?:true|false)$/i,
  // Typing these into Excel produces a real error value.
  /^#(?:N\/A|REF!|VALUE!|NAME\?|DIV\/0!|NUM!|NULL!|ERROR!)$/i,
];

/**
 * True when a spreadsheet would reinterpret this text if it arrived as plain
 * typed input. A false positive only wraps the cell in a harmless text formula.
 */
export function isRisky(value: string): boolean {
  const text = normalizeText(value);
  if (text === '') return false;
  return OTHER_RISKY_PATTERNS.some((pattern) => pattern.test(text)) || looksLikeDate(text);
}

/** ="value", which both spreadsheets show as the exact text. */
export function textFormula(value: string): string {
  const pieces = value.match(FORMULA_PIECE) ?? [''];
  return `=${pieces.map((piece) => `"${piece.replaceAll('"', '""')}"`).join('&')}`;
}

function plainCell(field: FieldKey, value: string): string {
  if (value === '') return '';
  return field === 'phone' || isRisky(value) ? textFormula(value) : value;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);

/** For a single-quoted attribute, where the JSON's double quotes can stay as they are. */
const escapeAttribute = (text: string): string => text.replace(/[&<>']/g, (char) => HTML_ESCAPES[char] ?? char);

function htmlCell(value: string): string {
  const typedValue = JSON.stringify({ 1: SHEETS_STRING_TYPE_CODE, 2: value });
  return `<td style='${EXCEL_TEXT_STYLE}' data-sheets-value='${escapeAttribute(typedValue)}'>${escapeHtml(value)}</td>`;
}

const htmlRow = (cells: string[]): string => `<tr>${cells.map(htmlCell).join('')}</tr>`;

function htmlDocument(tableRows: string): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>' +
    `<google-sheets-html-origin><table data-sheets-root="1"><tbody>${tableRows}</tbody></table></google-sheets-html-origin>` +
    '</body></html>'
  );
}

export function encode(rows: CardRow[], options: { includeHeader: boolean }): ClipboardPayload {
  const headers = FIELD_KEYS.map((field) => COLUMN_HEADERS[field]);
  const cleanRows = rows.map((row) => FIELD_KEYS.map((field) => sanitizeCell(row[field])));

  const htmlRows = cleanRows.map(htmlRow);
  const plainRows = cleanRows.map((cells) =>
    FIELD_KEYS.map((field, column) => plainCell(field, cells[column] ?? '')).join('\t'),
  );

  if (options.includeHeader) {
    htmlRows.unshift(htmlRow(headers));
    plainRows.unshift(headers.join('\t'));
  }

  return { html: htmlDocument(htmlRows.join('')), plain: plainRows.join('\n') };
}
