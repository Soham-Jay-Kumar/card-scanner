import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { COLUMN_HEADERS, FIELD_KEYS, type CardRow } from '../shared/contracts.ts';
import { PHONE_CASES } from '../paste/phoneCases.ts';
import { toCsv, toXlsx } from './index.ts';

const everyField = (value: string): CardRow =>
  Object.fromEntries(FIELD_KEYS.map((field) => [field, value])) as CardRow;

const headers = FIELD_KEYS.map((field) => COLUMN_HEADERS[field]);

const hostile = [
  '<b>bold</b>',
  '</td><td>',
  'say "hi"',
  '"Acme" Inc',
  "it's",
  '&amp;',
  '=SUM(1)',
  '=cmd|\' /C calc\'!A0',
  'a,b',
  ' leading and trailing ',
];

async function readSheet(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('No worksheet');
  return sheet;
}

/** Parses RFC 4180 strictly, so a quoting mistake fails the test. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      if (cell !== '') throw new Error('Quote inside an unquoted field');
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else {
      cell += char;
    }
  }
  if (quoted || cell !== '' || row.length > 0) throw new Error('Missing final CRLF');
  return rows;
}

describe('toXlsx', () => {
  it('writes the header row in column order', async () => {
    const sheet = await readSheet(await toXlsx([]));
    expect(sheet.getRow(1).values).toEqual([undefined, ...headers]);
    expect(sheet.rowCount).toBe(1);
  });

  it('stores every phone case as a string, byte for byte, with text format', async () => {
    const rows = PHONE_CASES.map(({ value }) => everyField(value));
    const sheet = await readSheet(await toXlsx(rows));
    expect(sheet.rowCount).toBe(rows.length + 1);
    rows.forEach((row, index) => {
      FIELD_KEYS.forEach((field, column) => {
        const cell = sheet.getCell(index + 2, column + 1);
        expect(cell.type).toBe(ExcelJS.ValueType.String);
        expect(cell.value).toBe(row[field]);
        expect(typeof cell.value).toBe('string');
        expect(cell.numFmt).toBe('@');
      });
    });
  });

  it('stores strings in the file itself, with no formula or number cell anywhere', async () => {
    const rows = PHONE_CASES.map(({ value }) => everyField(value));
    const zip = await JSZip.loadAsync(await toXlsx(rows));
    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string');
    const stylesXml = await zip.file('xl/styles.xml')?.async('string');
    expect(sheetXml).toBeDefined();
    const cells = [...(sheetXml ?? '').matchAll(/<c r="[A-F]\d+"[^>]*?(?:\/>|>.*?<\/c>)/g)].map((match) => match[0]);
    expect(cells).toHaveLength((rows.length + 1) * 6);
    for (const cell of cells) {
      expect(cell).toMatch(/ t="s"/);
      expect(cell).not.toContain('<f>');
    }
    // 49 is the built-in id of the Text format.
    expect(stylesXml).toMatch(/numFmtId="49"/);
  });

  it('keeps a formula-looking value as text', async () => {
    const sheet = await readSheet(await toXlsx([everyField('=SUM(1)')]));
    const cell = sheet.getCell(2, 1);
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.value).toBe('=SUM(1)');
    expect(cell.formula).toBeUndefined();
  });

  it.each(hostile)('keeps hostile text %j in every field', async (value) => {
    const sheet = await readSheet(await toXlsx([everyField(value)]));
    FIELD_KEYS.forEach((_, column) => {
      expect(sheet.getCell(2, column + 1).value).toBe(value);
    });
  });

  it('keeps a blank cell blank and in text format, and never drops a row', async () => {
    const blank = everyField('');
    const sheet = await readSheet(await toXlsx([blank, { ...blank, name: 'Jane' }, blank]));
    expect(sheet.rowCount).toBe(4);
    expect(sheet.getCell(3, 1).value).toBe('Jane');
    expect(sheet.getCell(3, 2).text).toBe('');
    expect(sheet.getCell(3, 2).numFmt).toBe('@');
  });

  it('does not corrupt the file on a control character', async () => {
    const sheet = await readSheet(await toXlsx([everyField('a\u0001b\u0000c')]));
    expect(sheet.rowCount).toBe(2);
  });

  it('handles 1,000 rows', async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) =>
      everyField(PHONE_CASES[index % PHONE_CASES.length]?.value ?? ''),
    );
    const sheet = await readSheet(await toXlsx(rows));
    expect(sheet.rowCount).toBe(1_001);
    expect(sheet.getCell(1_001, 5).value).toBe(rows[999]?.phone);
  });
});

describe('toCsv', () => {
  it('starts with a UTF-8 byte order mark', () => {
    expect([...toCsv([]).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('writes CRLF records and a header', () => {
    const text = toCsv([everyField('x')]).toString('utf8').slice(1);
    expect(text).toBe('Name,Position,Company,Email,Phone,Website\r\nx,x,x,x,x,x\r\n');
  });

  it('keeps every phone case literal, with no formula wrapper', () => {
    const rows = PHONE_CASES.map(({ value }) => everyField(value));
    const parsed = parseCsv(toCsv(rows).toString('utf8').slice(1));
    expect(parsed[0]).toEqual(headers);
    expect(parsed).toHaveLength(rows.length + 1);
    rows.forEach((row, index) => {
      expect(parsed[index + 1]).toEqual(FIELD_KEYS.map((field) => row[field]));
    });
  });

  it('does not wrap a phone as a formula', () => {
    expect(toCsv([everyField('+91 98765 43210')]).toString('utf8')).not.toContain('="');
  });

  it.each([...hostile, 'line one\nline two', 'line one\r\nline two', '"', '""', ','])(
    'round-trips hostile text %j under RFC 4180',
    (value) => {
      const parsed = parseCsv(toCsv([everyField(value)]).toString('utf8').slice(1));
      expect(parsed).toHaveLength(2);
      expect(parsed[1]).toEqual(FIELD_KEYS.map(() => value));
    },
  );

  it('survives multi-byte text', () => {
    const value = '山田太郎 तुलिका Müller 😀';
    expect(toCsv([everyField(value)]).toString('utf8')).toContain(value);
  });

  it('never drops a row', () => {
    expect(parseCsv(toCsv([everyField(''), everyField('')]).toString('utf8').slice(1))).toHaveLength(3);
  });

  it('returns a Buffer', () => {
    expect(Buffer.isBuffer(toCsv([]))).toBe(true);
  });
});
