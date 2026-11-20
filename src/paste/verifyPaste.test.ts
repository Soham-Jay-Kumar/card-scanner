import { describe, expect, it } from 'vitest';
import { COLUMN_HEADERS, FIELD_KEYS, type CardRow } from '../shared/contracts.ts';
import { PHONE_CASES } from './phoneCases.ts';
import { verifyPaste } from './verifyPaste.ts';

const row = (patch: Partial<CardRow> = {}): CardRow => ({
  name: 'Jane Doe',
  position: 'CEO',
  company: 'Acme',
  email: 'jane@acme.com',
  phone: '+91 98765 43210',
  website: 'acme.com',
  ...patch,
});

const line = (item: CardRow): string => FIELD_KEYS.map((field) => item[field]).join('\t');
const header = FIELD_KEYS.map((field) => COLUMN_HEADERS[field]).join('\t');

/** Text as a spreadsheet puts it on the clipboard: a quoted cell when it holds a tab, line break or quote. */
function tsvCell(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
const sheetText = (rows: CardRow[]): string =>
  rows.map((item) => FIELD_KEYS.map((field) => tsvCell(item[field])).join('\t')).join('\r\n');

describe('clean paste', () => {
  it('passes with every case in every column', () => {
    const rows = PHONE_CASES.map(({ value }) =>
      Object.fromEntries(FIELD_KEYS.map((field) => [field, value])) as CardRow,
    );
    const report = verifyPaste(rows, sheetText(rows));
    expect(report.differences).toEqual([]);
    expect(report).toMatchObject({
      ok: true,
      rowsExpected: rows.length,
      rowsFound: rows.length,
      cellsCompared: rows.length * 6,
    });
  });

  it('accepts LF, CRLF and CR line endings', () => {
    const rows = [row(), row({ name: 'Omar' })];
    for (const ending of ['\n', '\r\n', '\r']) {
      expect(verifyPaste(rows, rows.map(line).join(ending)).ok).toBe(true);
    }
  });

  it('auto-detects a header row and numbers rows without it', () => {
    const rows = [row(), row({ name: 'Omar' })];
    const report = verifyPaste(rows, [header, line(rows[0]!), line(row({ name: 'Wrong' }))].join('\n'));
    expect(report.rowsFound).toBe(2);
    expect(report.differences[0]).toMatchObject({ row: 2, field: 'name' });
  });

  it('detects the header in any letter case', () => {
    expect(verifyPaste([row()], `${header.toUpperCase()}\n${line(row())}`).ok).toBe(true);
  });

  it('ignores trailing empty rows and columns', () => {
    const rows = [row(), row({ name: 'Omar' })];
    const text = rows.map((item) => `${line(item)}\t\t`).join('\n');
    expect(verifyPaste(rows, `${text}\n\t\t\t\t\t\n\n\n`).ok).toBe(true);
  });

  it('treats missing trailing tabs as blank cells', () => {
    const rows = [row({ website: '', phone: '' })];
    expect(verifyPaste(rows, 'Jane Doe\tCEO\tAcme\tjane@acme.com').ok).toBe(true);
  });

  it('keeps a blank row in the middle', () => {
    const blank = row({ name: '', position: '', company: '', email: '', phone: '', website: '' });
    const rows = [row(), blank, row({ name: 'Omar' })];
    expect(verifyPaste(rows, rows.map(line).join('\n')).ok).toBe(true);
  });

  it('reads quoted cells with quotes, tabs and line breaks', () => {
    const rows = [row({ name: 'say "hi"', company: 'Acme, Inc' })];
    expect(verifyPaste(rows, sheetText(rows)).ok).toBe(true);
    const report = verifyPaste([row({ name: 'one' })], line(row({ name: '"one\ntwo"' })));
    expect(report.rowsFound).toBe(1);
    expect(report.differences[0]).toMatchObject({ field: 'name', actual: 'one\ntwo', kind: 'changed' });
  });

  it('takes an unbalanced leading quote literally, without swallowing the next row', () => {
    const rows = [row({ name: '"Bob' }), row({ name: 'Omar' })];
    const report = verifyPaste(rows, rows.map(line).join('\n'));
    expect(report.differences).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('passes a value that arrives with its quotes unescaped', () => {
    const rows = [row({ name: '"Acme"' })];
    expect(verifyPaste(rows, line(rows[0]!)).ok).toBe(true);
  });

  it('compares against the sanitised value that was actually copied', () => {
    const rows = [row({ name: 'Jane\tDoe', position: 'Chief\r\nOfficer' })];
    expect(verifyPaste(rows, line(row({ name: 'Jane Doe', position: 'Chief Officer' }))).ok).toBe(true);
  });

  it('passes with nothing expected and nothing pasted', () => {
    expect(verifyPaste([], '')).toMatchObject({ ok: true, rowsExpected: 0, rowsFound: 0, cellsCompared: 0 });
  });
});

describe('injected failures', () => {
  const cases: Array<[string, string, string, string]> = [
    ['#ERROR! from Sheets', '+91 98765 43210', '#ERROR!', 'formula_error'],
    ['#NAME? from Excel', '+91 98765 43210', '#NAME?', 'formula_error'],
    ['#VALUE!', '+91 98765 43210', '#VALUE!', 'formula_error'],
    ['#REF!', '+91 98765 43210', '#REF!', 'formula_error'],
    ['a lost plus', '+919876543210', '919876543210', 'lost_plus'],
    ['a lost plus keeping spaces', '+91 98765 43210', '91 98765 43210', 'lost_plus'],
    ['a lost plus and spaces', '+91 98765 43210', '919876543210', 'lost_plus'],
    ['a lost zero', '0412345678', '412345678', 'lost_leading_zero'],
    ['lost zeros on 007', '007', '7', 'lost_leading_zero'],
    ['a lost zero with separators', '03-1234-5678', '3-1234-5678', 'lost_leading_zero'],
    ['scientific notation', '9198765432101234', '9.19877E+15', 'scientific_notation'],
    ['scientific notation with a comma', '9198765432101234', '9,19E+15', 'scientific_notation'],
    ['a date', '10-12-2024', '10/12/2024', 'date'],
    ['a reordered date', '10-12-2024', '2024-12-10', 'date'],
    ['a named-month date', '3/4', '4-Mar', 'date'],
    ['a date serial number', '10-12-2024', '45577', 'date'],
    ['a calculated phone', '+1-555-123-4567', '-5244', 'changed'],
    ['rounding to 15 digits', '9198765432101234', '9198765432101230', 'changed'],
    ['a one-digit change', '+91 98765 43210', '+91 98765 43211', 'changed'],
    ['an evaluated formula', '=SUM(1)', '1', 'changed'],
    ['a text formula left unevaluated', '+91 98765 43210', '="+91 98765 43210"', 'changed'],
    ['a boolean case change', 'TRUE', 'true', 'changed'],
    ['mangled Unicode', '山田太郎', '????', 'changed'],
    ['collapsed spaces', 'a  b', 'a b', 'changed'],
    ['a cell emptied', '+91 98765 43210', '', 'changed'],
  ];

  it.each(cases)('reports %s', (_, expected, actual, kind) => {
    const report = verifyPaste([row(), row({ phone: expected })], [line(row()), line(row({ phone: actual }))].join('\n'));
    expect(report.ok).toBe(false);
    expect(report.differences).toEqual([{ row: 2, field: 'phone', expected, actual, kind }]);
  });

  it('reports the failure in any column', () => {
    for (const field of FIELD_KEYS) {
      const report = verifyPaste([row({ [field]: '+919876543210' })], line(row({ [field]: '#ERROR!' })));
      expect(report.differences).toEqual([
        { row: 1, field, expected: '+919876543210', actual: '#ERROR!', kind: 'formula_error' },
      ]);
    }
  });

  it('every phone case fails when each failure is injected', () => {
    const injected: Array<(value: string) => string> = [
      () => '#ERROR!',
      (value) => value.replace(/^\+/, '').replace(/^0+/, ''),
      () => '1.23E+15',
      () => '12/10/2024',
      () => '-5244',
      (value) => `${value}9`,
    ];
    for (const { value } of PHONE_CASES) {
      for (const inject of injected) {
        const actual = inject(value);
        if (actual === value) continue;
        const report = verifyPaste([row({ phone: value })], line(row({ phone: actual })));
        expect(report.ok, `${value} became ${actual}`).toBe(false);
        expect(report.differences).toHaveLength(1);
        expect(report.differences[0]?.field).toBe('phone');
      }
    }
  });
});

describe('row problems', () => {
  const rows = [row({ name: 'One' }), row({ name: 'Two' }), row({ name: 'Three' })];

  it('fails a missing last row and names what is missing', () => {
    const report = verifyPaste(rows, rows.slice(0, 2).map(line).join('\n'));
    expect(report).toMatchObject({ ok: false, rowsExpected: 3, rowsFound: 2, cellsCompared: 12 });
    expect(report.differences).toHaveLength(6);
    expect(report.differences[0]).toMatchObject({ row: 3, field: 'name', expected: 'Three', actual: '', kind: 'missing_row' });
  });

  it('fails a row missing from the middle', () => {
    const report = verifyPaste(rows, [rows[0]!, rows[2]!].map(line).join('\n'));
    expect(report.ok).toBe(false);
    expect(report.rowsFound).toBe(2);
    expect(report.differences.some((item) => item.row === 2 && item.kind === 'changed')).toBe(true);
  });

  it('fails an extra row', () => {
    const report = verifyPaste(rows, [...rows, row({ name: 'Four' })].map(line).join('\n'));
    expect(report).toMatchObject({ ok: false, rowsFound: 4 });
    expect(report.differences).toHaveLength(1);
    expect(report.differences[0]).toMatchObject({ row: 4, kind: 'extra_row' });
  });

  it('fails rows pasted in the wrong order', () => {
    const report = verifyPaste(rows, [rows[1]!, rows[0]!, rows[2]!].map(line).join('\n'));
    expect(report.ok).toBe(false);
    expect(report.differences.map((item) => item.row)).toEqual([1, 2]);
  });

  it('fails a row shifted down by a blank row', () => {
    const report = verifyPaste(rows, ['\t\t\t\t\t', ...rows.map(line)].join('\n'));
    expect(report).toMatchObject({ ok: false, rowsFound: 4 });
  });

  it('fails a row shifted one column to the right', () => {
    const report = verifyPaste([rows[0]!], `\t${line(rows[0]!)}`);
    expect(report.ok).toBe(false);
    expect(report.differences.at(-1)).toMatchObject({ kind: 'extra_column', field: 'website', actual: 'acme.com' });
  });

  it('fails content in a seventh column even when six cells match', () => {
    const report = verifyPaste([rows[0]!], `${line(rows[0]!)}\tstray`);
    expect(report.ok).toBe(false);
    expect(report.differences).toEqual([
      { row: 1, field: 'website', expected: '', actual: 'stray', kind: 'extra_column' },
    ]);
  });

  it('fails an empty paste', () => {
    const report = verifyPaste(rows, '');
    expect(report).toMatchObject({ ok: false, rowsExpected: 3, rowsFound: 0, cellsCompared: 0 });
  });

  it('does not treat a near-header as a header', () => {
    const text = `Name\tPosition\tCompany\tEmail\tPhone\n${line(rows[0]!)}`;
    expect(verifyPaste([rows[0]!], text).ok).toBe(false);
  });

  it('finds one wrong cell in 1,000 rows', () => {
    const many = Array.from({ length: 1_000 }, (_, index) => row({ name: `Person ${index}` }));
    const copied = many.map((item) => ({ ...item }));
    copied[617] = { ...many[617]!, phone: '#ERROR!' };
    const report = verifyPaste(many, copied.map(line).join('\r\n'));
    expect(report.ok).toBe(false);
    expect(report.cellsCompared).toBe(6_000);
    expect(report.differences).toEqual([
      { row: 618, field: 'phone', expected: '+91 98765 43210', actual: '#ERROR!', kind: 'formula_error' },
    ]);
  });
});
