/**
 * Turns one read into its six final cell strings. Text stays exactly as the
 * model returned it, apart from characters that would break the spreadsheet
 * row. normalizeText is only used to test for blanks, never to build a cell.
 */
import { MULTI_VALUE_SEPARATOR, type CardReadData, type CardRow } from '../shared/contracts.ts';
import { normalizeText } from '../shared/text.ts';

const CELL_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;

const FAX_WORDS = new Set(['fax', 'f', 'fx', 'facs', 'facsimile', 'telefax', 'efax']);
const VOICE_WORDS = new Set(['tel', 'tele', 'telephone', 'phone', 'ph', 'p', 't', 'm', 'mob', 'mobile', 'cell', 'voice', 'v']);

/**
 * True when a label marks a fax-only number. Whole words are matched, so
 * `Fairfax` and `Halifax` are not faxes. A shared line such as `Tel/Fax` is
 * also a working phone, so it stays.
 */
export function isFaxLabel(label: string): boolean {
  const words = normalizeText(label).toLowerCase().split(/\P{L}+/u);
  return words.some((word) => FAX_WORDS.has(word)) && !words.some((word) => VOICE_WORDS.has(word));
}

function toCell(value: string): string {
  const cell = value.replace(CELL_BREAKS, ' ');
  return normalizeText(cell) === '' ? '' : cell;
}

function joinValues(values: string[]): string {
  return [...new Set(values.map(toCell).filter(Boolean))].join(MULTI_VALUE_SEPARATOR);
}

export function toRow(data: CardReadData): CardRow {
  return {
    name: toCell(data.name),
    position: toCell(data.position),
    company: toCell(data.company),
    email: joinValues(data.emails),
    phone: joinValues(data.phones.filter((phone) => !isFaxLabel(phone.label)).map((phone) => phone.number)),
    website: joinValues(data.websites),
  };
}
