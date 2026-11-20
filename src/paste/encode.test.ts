import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLUMN_HEADERS, FIELD_KEYS, type CardRow } from '../shared/contracts.ts';
import { encode, isRisky, sanitizeCell, SHEETS_STRING_TYPE_CODE, textFormula } from './encode.ts';
import { PHONE_CASES, phoneCaseRows } from './phoneCases.ts';

const blankRow = (patch: Partial<CardRow> = {}): CardRow => ({
  name: '',
  position: '',
  company: '',
  email: '',
  phone: '',
  website: '',
  ...patch,
});

const everyField = (value: string): CardRow =>
  Object.fromEntries(FIELD_KEYS.map((field) => [field, value])) as CardRow;

const HOSTILE_VALUES = [
  '<b>bold</b>',
  '<script>alert(1)</script>',
  '</td></tr></table><h1>escaped</h1>',
  '</td><td>extra cell',
  'say "hello"',
  '"unbalanced',
  'trailing"',
  "it's",
  "'quoted'",
  "='); DROP TABLE cards;--",
  'a\tb',
  'line one\nline two',
  'line one\r\nline two',
  'line one\rline two',
  '&amp; &lt; &#39;',
  'back\\slash \\" \\u0041',
  '{"1":3,"3":5}',
  '=cmd|\' /C calc\'!A0',
  '=HYPERLINK("http://x","y")',
  '<!-- comment -->',
  ']]>',
];

/** Decodes the entities encode can produce. */
function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => {
    const decoded: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
    return decoded[name] ?? '';
  });
}

interface ParsedCell {
  text: string;
  style: string;
  sheets: { type: unknown; value: unknown };
}

/** A strict reader of encode's HTML: anything else between cells fails the test. */
function parseHtmlTable(html: string): ParsedCell[][] {
  const table = /<table data-sheets-root="1"><tbody>(.*)<\/tbody><\/table>/s.exec(html);
  if (!table) throw new Error('No table with a Sheets root marker');
  const body = table[1] ?? '';
  const rows: ParsedCell[][] = [];
  const rowPattern = /<tr>(.*?)<\/tr>/gs;
  let consumed = 0;
  for (const rowMatch of body.matchAll(rowPattern)) {
    expect(rowMatch.index).toBe(consumed);
    consumed += rowMatch[0].length;
    const cells: ParsedCell[] = [];
    const cellPattern = /<td style='([^']*)' data-sheets-value='([^']*)'>([^<]*)<\/td>/g;
    let inner = 0;
    for (const cell of (rowMatch[1] ?? '').matchAll(cellPattern)) {
      expect(cell.index).toBe(inner);
      inner += cell[0].length;
      const typed = JSON.parse(decodeEntities(cell[2] ?? '')) as Record<string, unknown>;
      cells.push({
        text: decodeEntities(cell[3] ?? ''),
        style: cell[1] ?? '',
        sheets: { type: typed['1'], value: typed['2'] },
      });
    }
    expect(inner).toBe((rowMatch[1] ?? '').length);
    rows.push(cells);
  }
  expect(consumed).toBe(body.length);
  return rows;
}

/** What a spreadsheet shows for one plain-text cell: formulas here are only joined text literals. */
function evaluatePlainCell(cell: string): string {
  if (!cell.startsWith('=')) return cell;
  const literal = /^"((?:[^"]|"")*)"/;
  let rest = cell.slice(1);
  let result = '';
  for (;;) {
    const match = literal.exec(rest);
    if (!match) throw new Error(`Not a text formula: ${cell}`);
    expect(Array.from(match[1] ?? '').length).toBeLessThanOrEqual(255);
    result += (match[1] ?? '').replaceAll('""', '"');
    rest = rest.slice(match[0].length);
    if (rest === '') return result;
    if (!rest.startsWith('&')) throw new Error(`Not a text formula: ${cell}`);
    rest = rest.slice(1);
  }
}

const parsePlain = (plain: string): string[][] => plain.split('\n').map((line) => line.split('\t'));

describe('isRisky', () => {
  it.each([
    '+91 98765 43210',
    '＋91 98765 43210',
    '-Sales',
    '\u22125',
    '=SUM(1)',
    '＝1+1',
    '@acme',
    ' =1+1',
    '"Acme" Inc',
    "'quoted",
    '123',
    '007',
    '0412345678',
    '9198765432101234',
    '1,234.50',
    '.5',
    '(555)',
    '1 234 567',
    '5-',
    '10-12-2024',
    '2024-12-10',
    '12/10/2024',
    '12.05.2024',
    '2024-12-10T10:30:00Z',
    '12/10/2024 10:30 PM',
    '3/4',
    '1 1/2',
    '12:30',
    '12:30:45',
    '12:30 PM',
    '5 PM',
    '12-Mar',
    'Mar-12',
    '4 March 2024',
    'March 12, 2024',
    'Sept 5',
    'MAR1',
    '50%',
    '$5',
    '€5,00',
    '£1,000',
    '₹500',
    '5 €',
    '1e5',
    '1E+5',
    '1.2e-3',
    'TRUE',
    'FALSE',
    'true',
    'False',
    '#N/A',
    '#REF!',
  ])('flags %s', (value) => {
    expect(isRisky(value)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'Acme Corp',
    'Dr. Jane Doe, PhD',
    'R&D Manager',
    'jane@acme.com',
    'www.acme.com',
    'acme.com',
    'https://acme.com/about',
    '3M',
    '7-Eleven',
    'May',
    'March',
    'Müller',
    '山田太郎',
    'तुलिका',
    'Truely',
    'Say "hi"',
  ])('leaves %j alone', (value) => {
    expect(isRisky(value)).toBe(false);
  });
});

describe('textFormula', () => {
  it('doubles quotes', () => {
    expect(textFormula('say "hi"')).toBe('="say ""hi"""');
  });

  it('splits long values into pieces Excel accepts', () => {
    const value = '+1 '.repeat(200);
    const formula = textFormula(value);
    expect(formula).toContain('"&"');
    expect(evaluatePlainCell(formula)).toBe(value);
  });

  it('never splits an emoji, and quotes stay within the Excel limit', () => {
    for (const value of ['😀'.repeat(300), '"'.repeat(300)]) {
      const formula = textFormula(value);
      expect(formula).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(evaluatePlainCell(formula)).toBe(value);
    }
  });
});

describe('encode html', () => {
  it('declares UTF-8 and carries both Sheets markers', () => {
    const { html } = encode([everyField('山田太郎')], { includeHeader: false });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('content="text/html; charset=utf-8"');
    expect(html).toContain('data-sheets-root="1"');
    expect(html).toContain('<google-sheets-html-origin>');
    expect(html).toContain('</html>');
  });

  it('marks every cell as text for Excel and for Sheets', () => {
    const { html } = encode([blankRow({ phone: '+91 98765 43210' }), everyField('x')], { includeHeader: true });
    const cells = parseHtmlTable(html).flat();
    expect(cells).toHaveLength(18);
    for (const cell of cells) {
      expect(cell.style).toBe('mso-number-format:"\\@"');
      expect(cell.sheets.type).toBe(SHEETS_STRING_TYPE_CODE);
      expect(cell.sheets.value).toBe(cell.text);
    }
  });

  it('writes the exact cell shape from the plan', () => {
    const { html } = encode([blankRow({ phone: '+91 98765 43210' })], { includeHeader: false });
    expect(html).toContain(
      `<td style='mso-number-format:"\\@"' data-sheets-value='{"1":${SHEETS_STRING_TYPE_CODE},"2":"+91 98765 43210"}'>+91 98765 43210</td>`,
    );
  });

  it.each(HOSTILE_VALUES)('keeps hostile text %j inside its cell, in every field', (value) => {
    const { html } = encode([everyField(value)], { includeHeader: false });
    const [row] = parseHtmlTable(html);
    expect(row).toHaveLength(6);
    for (const cell of row ?? []) {
      expect(cell.text).toBe(sanitizeCell(value));
      expect(cell.sheets.value).toBe(sanitizeCell(value));
    }
  });
});

describe('encode plain', () => {
  it('always wraps a non-blank phone and leaves blanks blank', () => {
    const { plain } = encode(
      [
        blankRow({ name: 'Jane', phone: '+91 98765 43210' }),
        blankRow({ name: 'Omar', phone: '1-800-FLOWERS' }),
        blankRow({ name: 'Blank' }),
      ],
      { includeHeader: false },
    );
    expect(parsePlain(plain)).toEqual([
      ['Jane', '', '', '', '="+91 98765 43210"', ''],
      ['Omar', '', '', '', '="1-800-FLOWERS"', ''],
      ['Blank', '', '', '', '', ''],
    ]);
  });

  it('wraps risky cells in any column and leaves ordinary ones as they are', () => {
    const row = blankRow({ name: '=SUM(1)', position: 'CEO', company: 'TRUE', email: 'a@b.co', website: '007' });
    expect(parsePlain(encode([row], { includeHeader: false }).plain)).toEqual([
      ['="=SUM(1)"', 'CEO', '="TRUE"', 'a@b.co', '', '="007"'],
    ]);
  });

  it('doubles quotes in a phone', () => {
    const { plain } = encode([blankRow({ phone: '12"34' })], { includeHeader: false });
    expect(parsePlain(plain)[0]?.[4]).toBe('="12""34"');
  });

  it('turns tabs and line breaks into a space before anything else', () => {
    const { plain } = encode([everyField('a\tb\r\nc\nd\re')], { includeHeader: false });
    const rows = parsePlain(plain);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(6);
    expect(rows[0]?.[0]).toBe('a b c d e');
    expect(rows[0]?.[4]).toBe('="a b c d e"');
  });

  it.each(HOSTILE_VALUES)('hostile text %j stays in one row and six cells', (value) => {
    const rows = parsePlain(encode([everyField(value)], { includeHeader: false }).plain);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(6);
    for (const cell of rows[0] ?? []) expect(evaluatePlainCell(cell)).toBe(sanitizeCell(value));
  });
});

describe('encode header and row count', () => {
  const headers = FIELD_KEYS.map((field) => COLUMN_HEADERS[field]);

  it('includes the header row only when asked', () => {
    const rows = [blankRow({ name: 'Jane' })];
    expect(parsePlain(encode(rows, { includeHeader: true }).plain)[0]).toEqual(headers);
    expect(parseHtmlTable(encode(rows, { includeHeader: true }).html)[0]?.map((cell) => cell.text)).toEqual(headers);
    expect(parsePlain(encode(rows, { includeHeader: false }).plain)).toHaveLength(1);
    expect(parseHtmlTable(encode(rows, { includeHeader: false }).html)).toHaveLength(1);
  });

  it('never drops a row, even a fully blank one', () => {
    const rows = [blankRow(), blankRow({ name: 'Jane' }), blankRow()];
    const { html, plain } = encode(rows, { includeHeader: false });
    expect(parsePlain(plain)).toEqual([Array(6).fill(''), ['Jane', '', '', '', '', ''], Array(6).fill('')]);
    expect(parseHtmlTable(html)).toHaveLength(3);
  });

  it('handles no rows', () => {
    expect(encode([], { includeHeader: false }).plain).toBe('');
    expect(parseHtmlTable(encode([], { includeHeader: true }).html)).toHaveLength(1);
  });
});

describe('phone test set', () => {
  it('has at least 20 phone formats and every required value', () => {
    const phones = PHONE_CASES.filter((item) => item.kind === 'phone').map((item) => item.value);
    expect(phones.length).toBeGreaterThanOrEqual(20);
    expect(phones.some((value) => /^\d{16,}$/.test(value))).toBe(true);
    const values = PHONE_CASES.map((item) => item.value);
    for (const required of [
      '+91 98765 43210',
      '+1-555-123-4567',
      '+919876543210',
      '0412345678',
      '10-12-2024',
      '(555) 123-4567',
      '+44 (0)20 7946 0958',
      '555.123.4567',
      '1-800-FLOWERS',
      '+91-98765-43210 x204',
      '007',
      '3/4',
      'TRUE',
      '=SUM(1)',
      '1e5',
      'Müller',
      '山田太郎',
      'तुलिका',
    ]) {
      expect(values).toContain(required);
    }
    expect(phones.some((value) => value.includes('; '))).toBe(true);
  });

  it('phoneCaseRows has one row per case', () => {
    expect(phoneCaseRows()).toHaveLength(PHONE_CASES.length);
  });

  describe.each(PHONE_CASES.map((item) => [item.value, item] as const))('%s', (value) => {
    it('survives html and plain in every column', () => {
      const { html, plain } = encode([everyField(value)], { includeHeader: false });
      for (const cell of parseHtmlTable(html)[0] ?? []) {
        expect(cell.text).toBe(value);
        expect(cell.sheets.value).toBe(value);
      }
      for (const cell of parsePlain(plain)[0] ?? []) expect(evaluatePlainCell(cell)).toBe(value);
    });

    it('never reaches a spreadsheet as bare risky text', () => {
      const { plain } = encode([everyField(value)], { includeHeader: false });
      for (const cell of parsePlain(plain)[0] ?? []) {
        if (!cell.startsWith('=')) expect(isRisky(cell)).toBe(false);
      }
      expect(parsePlain(plain)[0]?.[4]).toMatch(/^="/);
    });
  });
});

describe('1,000 rows', () => {
  const rows: CardRow[] = Array.from({ length: 1_000 }, (_, index) => {
    const item = PHONE_CASES[index % PHONE_CASES.length];
    const hostile = HOSTILE_VALUES[index % HOSTILE_VALUES.length] ?? '';
    return {
      name: `山田太郎 ${index}`,
      position: hostile,
      company: item?.value ?? '',
      email: `person${index}@example.com`,
      phone: item?.value ?? '',
      website: index % 7 === 0 ? '' : `www.example${index}.com`,
    };
  });

  it('round-trips every cell through html and plain', () => {
    const { html, plain } = encode(rows, { includeHeader: true });
    const table = parseHtmlTable(html);
    const lines = parsePlain(plain);
    expect(table).toHaveLength(1_001);
    expect(lines).toHaveLength(1_001);
    rows.forEach((row, index) => {
      FIELD_KEYS.forEach((field, column) => {
        const wanted = sanitizeCell(row[field]);
        expect(table[index + 1]?.[column]?.text).toBe(wanted);
        expect(table[index + 1]?.[column]?.sheets.value).toBe(wanted);
        expect(evaluatePlainCell(lines[index + 1]?.[column] ?? '')).toBe(wanted);
      });
    });
  });
});

/** Playwright's own build if present, otherwise the newest headless shell already on this Mac. */
function findChromium(): string | undefined {
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  return readdirSync(cache)
    .filter((name) => name.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map((name) => join(cache, name, 'chrome-headless-shell-mac-x64/chrome-headless-shell'))
    .find((path) => existsSync(path));
}

const chromiumPath = findChromium();

describe.runIf(chromiumPath)('real HTML parser (headless Chromium, no network)', () => {
  let browser: Browser;
  let folder: string;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumPath as string });
    folder = await mkdtemp(join(tmpdir(), 'paste-encode-'));
  });

  afterAll(async () => {
    await browser?.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  async function readInBrowser(html: string) {
    const file = join(folder, 'payload.html');
    // Loaded from UTF-8 bytes, so this also proves the charset declaration works.
    await writeFile(file, html, 'utf8');
    const page = await browser.newPage();
    await page.goto(pathToFileURL(file).href);
    const parsed = await page.evaluate(() => ({
      charset: document.characterSet,
      rootMarker: document.querySelector('table')?.getAttribute('data-sheets-root'),
      origin: document.querySelector('google-sheets-html-origin') !== null,
      tables: document.querySelectorAll('table').length,
      rows: [...document.querySelectorAll('tr')].map((row) =>
        [...row.querySelectorAll('td')].map((cell) => ({
          text: cell.textContent,
          sheets: cell.getAttribute('data-sheets-value'),
          format: cell.getAttribute('style'),
        })),
      ),
    }));
    await page.close();
    return parsed;
  }

  it('reads every phone case and hostile value back exactly', async () => {
    const values = [...PHONE_CASES.map((item) => item.value), ...HOSTILE_VALUES];
    const rows = values.map(everyField);
    const parsed = await readInBrowser(encode(rows, { includeHeader: false }).html);

    expect(parsed.charset).toBe('UTF-8');
    expect(parsed.rootMarker).toBe('1');
    expect(parsed.origin).toBe(true);
    expect(parsed.tables).toBe(1);
    expect(parsed.rows).toHaveLength(values.length);

    parsed.rows.forEach((row, index) => {
      const wanted = sanitizeCell(values[index] ?? '');
      expect(row).toHaveLength(6);
      for (const cell of row) {
        expect(cell.text).toBe(wanted);
        expect(cell.format).toBe('mso-number-format:"\\@"');
        expect(JSON.parse(cell.sheets ?? 'null')).toEqual({ '1': SHEETS_STRING_TYPE_CODE, '2': wanted });
      }
    });
  });
});
