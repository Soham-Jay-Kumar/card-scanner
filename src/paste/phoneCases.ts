/**
 * The shared paste test set. QA reuses this, so every value is written exactly
 * as it would be printed on a card and must survive every paste route unchanged.
 */
import type { CardRow } from '../shared/contracts.ts';

export interface PhoneCase {
  value: string;
  /** 'phone' goes in the Phone column. 'trap' is non-phone text a spreadsheet would mangle. */
  kind: 'phone' | 'trap';
  /** What goes wrong when this value is pasted as plain text. */
  note: string;
}

export const PHONE_CASES: readonly PhoneCase[] = [
  // The plan's failure table.
  { kind: 'phone', value: '+91 98765 43210', note: 'Leading + starts a formula, giving #ERROR!' },
  { kind: 'phone', value: '+1-555-123-4567', note: 'Read as arithmetic, giving -5244 with no error shown' },
  { kind: 'phone', value: '+919876543210', note: 'The + is lost' },
  { kind: 'phone', value: '0412345678', note: 'The leading zero is lost' },
  { kind: 'phone', value: '9198765432101234', note: '16 digits: rounded to 15 or shown as 9.19E+15' },
  { kind: 'phone', value: '12345678901234567890', note: '20 digits: rounded or scientific' },
  { kind: 'phone', value: '10-12-2024', note: 'Becomes a date' },

  // Common printed formats.
  { kind: 'phone', value: '(555) 123-4567', note: 'Brackets can read as a negative number' },
  { kind: 'phone', value: '+44 (0)20 7946 0958', note: 'Leading + and a bracketed trunk zero' },
  { kind: 'phone', value: '555.123.4567', note: 'Dots can read as a number or date' },
  { kind: 'phone', value: '1-800-FLOWERS', note: 'Letters inside a number' },
  { kind: 'phone', value: '+91-98765-43210 x204', note: 'Extension after an arithmetic-looking number' },
  { kind: 'phone', value: '+91 98765 43210; +91 98765 43211', note: 'Two numbers in one cell' },
  { kind: 'phone', value: '020 7946 0958; 07700 900123', note: 'Two numbers with leading zeros' },
  { kind: 'phone', value: '0044 20 7946 0958', note: 'International 00 prefix' },
  { kind: 'phone', value: '+81 3-1234-5678', note: 'Japanese format with mixed separators' },
  { kind: 'phone', value: '03-1234-5678', note: 'Leading zero and a date-like shape' },
  { kind: 'phone', value: '(03) 9123 4567', note: 'Australian format with a bracketed zero' },
  { kind: 'phone', value: '555-123-4567', note: 'Read as subtraction or a date' },
  { kind: 'phone', value: '5551234567', note: 'Plain digits become a number' },
  { kind: 'phone', value: '+1 (212) 555-0100 ext. 89', note: 'Extension spelled out' },
  { kind: 'phone', value: '1 800 123 456', note: 'Spaced digits' },
  { kind: 'phone', value: '12/10/2024', note: 'Slashes become a date' },
  { kind: 'phone', value: '2024-12-10', note: 'ISO date shape' },
  { kind: 'phone', value: '12.05.2024', note: 'European date shape' },
  { kind: 'phone', value: '+९१ ९८७६५ ४३२१०', note: 'Leading + with Devanagari digits' },

  // Non-phone traps.
  { kind: 'trap', value: '007', note: 'Leading zeros are lost' },
  { kind: 'trap', value: '3/4', note: 'Becomes a date or a fraction' },
  { kind: 'trap', value: 'TRUE', note: 'Becomes a boolean' },
  { kind: 'trap', value: 'FALSE', note: 'Becomes a boolean' },
  { kind: 'trap', value: '=SUM(1)', note: 'Runs as a formula' },
  { kind: 'trap', value: '1e5', note: 'Becomes 100000' },
  { kind: 'trap', value: '@acme', note: 'Leading @ is treated as a formula' },
  { kind: 'trap', value: '-Sales', note: 'Leading - starts a formula' },
  { kind: 'trap', value: '50%', note: 'Becomes 0.5' },
  { kind: 'trap', value: '$1,000', note: 'Becomes a currency number' },
  { kind: 'trap', value: '12:30', note: 'Becomes a time' },
  { kind: 'trap', value: 'Mar-12', note: 'Becomes a date' },
  { kind: 'trap', value: '"Acme" Inc', note: 'A leading quote is taken as a quoted field' },
  { kind: 'trap', value: '#N/A', note: 'Becomes an error value' },
  { kind: 'trap', value: 'Müller', note: 'Must survive UTF-8' },
  { kind: 'trap', value: '山田太郎', note: 'Must survive UTF-8' },
  { kind: 'trap', value: 'तुलिका', note: 'Must survive UTF-8, including combining marks' },
];

const BLANK_ROW: CardRow = { name: '', position: '', company: '', email: '', phone: '', website: '' };

/** One row per case, with the value in the Phone column or, for a trap, the Company column. */
export function phoneCaseRows(): CardRow[] {
  return PHONE_CASES.map(({ kind, value }) => ({
    ...BLANK_ROW,
    name: `Case ${value.length}`,
    [kind === 'phone' ? 'phone' : 'company']: value,
  }));
}
