import { describe, expect, it } from 'vitest';
import type { CardReadData } from '../shared/contracts.ts';
import { isFaxLabel, toRow } from './toRow.ts';

function card(patch: Partial<CardReadData> = {}): CardReadData {
  return {
    transcript: ['x'],
    name: '',
    position: '',
    company: '',
    emails: [],
    phones: [],
    websites: [],
    unreadable: [],
    ...patch,
  };
}

const phones = (...entries: Array<[string, string]>) => entries.map(([number, label]) => ({ number, label }));

describe('toRow', () => {
  it('returns six blank cells for a blank read', () => {
    expect(toRow(card())).toEqual({ name: '', position: '', company: '', email: '', phone: '', website: '' });
  });

  it('maps every field', () => {
    const row = toRow(card({
      name: 'Dr. Jane Doe, PhD',
      position: 'Head of Sales',
      company: 'Acme Ltd',
      emails: ['jane@acme.com'],
      phones: phones(['+91 98765 43210', 'Tel:']),
      websites: ['www.acme.com'],
    }));
    expect(row).toEqual({
      name: 'Dr. Jane Doe, PhD',
      position: 'Head of Sales',
      company: 'Acme Ltd',
      email: 'jane@acme.com',
      phone: '+91 98765 43210',
      website: 'www.acme.com',
    });
  });

  it('joins multiple values in printed order', () => {
    const row = toRow(card({
      emails: ['z@acme.com', 'a@acme.com'],
      phones: phones(['555 2222', 'M:'], ['555 1111', 'T:']),
      websites: ['b.example', 'a.example'],
    }));
    expect(row.email).toBe('z@acme.com; a@acme.com');
    expect(row.phone).toBe('555 2222; 555 1111');
    expect(row.website).toBe('b.example; a.example');
  });

  it('drops exact repeats only', () => {
    expect(toRow(card({ emails: ['a@x.com', 'b@x.com', 'a@x.com'] })).email).toBe('a@x.com; b@x.com');
    expect(toRow(card({ emails: ['a@x.com', 'A@x.com'] })).email).toBe('a@x.com; A@x.com');
    expect(toRow(card({ phones: phones(['555 1111', 'Tel:'], ['555-1111', 'M:']) })).phone).toBe('555 1111; 555-1111');
  });

  it('treats values that differ only by a replaced tab or newline as exact repeats', () => {
    expect(toRow(card({ websites: ['a b.com', 'a\tb.com', 'a\nb.com'] })).website).toBe('a b.com');
  });

  it('drops blank entries instead of leaving stray separators', () => {
    expect(toRow(card({ emails: ['', 'a@x.com', '   ', '\u200B'] })).email).toBe('a@x.com');
    expect(toRow(card({ phones: phones(['', 'Tel:'], ['555 1111', '']) })).phone).toBe('555 1111');
  });

  it('turns a whitespace-only single value into a blank cell', () => {
    expect(toRow(card({ name: '   ', company: '\n\t', position: '\u200B' }))).toMatchObject({ name: '', company: '', position: '' });
  });

  it('never leaves a label in the phone cell', () => {
    expect(toRow(card({ phones: phones(['+1 555 123 4567', 'Tel:']) })).phone).toBe('+1 555 123 4567');
  });

  it.each(['+91 98765 43210', '+1-555-123-4567', '(555) 123-4567', '+44 (0)20 7946 0958', '555.123.4567', '1-800-FLOWERS', '+91-98765-43210 x204', '0412345678'])(
    'keeps %s exactly',
    (number) => {
      expect(toRow(card({ phones: phones([number, 'T:']) })).phone).toBe(number);
    },
  );

  describe('fax exclusion', () => {
    it.each(['Fax', 'FAX', 'fax:', 'F:', 'F', 'f.', '(F)', 'Fx:', 'Facsimile', 'Facsimile:', 'Telefax', 'eFax', 'E-Fax', 'Fax No.', 'Fax #', 'Office Fax', 'Direct Fax:', 'ＦＡＸ'])(
      'excludes a number labelled %s',
      (label) => {
        expect(isFaxLabel(label)).toBe(true);
        expect(toRow(card({ phones: phones(['555 1111', 'Tel:'], ['555 2222', label]) })).phone).toBe('555 1111');
      },
    );

    it.each(['', 'Tel:', 'T', 'M:', 'Mobile', 'Office', 'Direct', 'Toll Free', 'Fairfax', 'Halifax', 'Tel/Fax:', 'Tel & Fax', 'T/F', 'Phone/Fax', 'Fax/Mobile'])(
      'keeps a number labelled %s',
      (label) => {
        expect(isFaxLabel(label)).toBe(false);
        expect(toRow(card({ phones: phones(['555 1111', label]) })).phone).toBe('555 1111');
      },
    );

    it('leaves a blank cell when the only number is a fax', () => {
      expect(toRow(card({ phones: phones(['555 2222', 'Fax']) })).phone).toBe('');
    });

    it('keeps a number printed as both phone and fax under its phone entry', () => {
      expect(toRow(card({ phones: phones(['555 1111', 'Tel:'], ['555 1111', 'Fax:']) })).phone).toBe('555 1111');
    });
  });

  describe('tabs and line breaks', () => {
    it.each([
      ['tab', 'Acme\tLtd'],
      ['line feed', 'Acme\nLtd'],
      ['carriage return', 'Acme\rLtd'],
      ['Windows line break', 'Acme\r\nLtd'],
      ['repeated breaks', 'Acme\n\n\tLtd'],
      ['vertical tab', 'Acme\vLtd'],
      ['form feed', 'Acme\fLtd'],
      ['next line', 'Acme\u0085Ltd'],
      ['line separator', 'Acme\u2028Ltd'],
      ['paragraph separator', 'Acme\u2029Ltd'],
    ])('replaces a %s with one space', (_name, value) => {
      expect(toRow(card({ company: value })).company).toBe('Acme Ltd');
    });

    it('applies to every field, including each value of a multi-value cell', () => {
      const row = toRow(card({
        name: 'Jane\tDoe',
        position: 'Head\nof Sales',
        company: 'Acme\r\nLtd',
        emails: ['a\t@x.com', 'b\n@x.com'],
        phones: phones(['555\t1111', 'Tel:']),
        websites: ['a\n.example'],
      }));
      expect(Object.values(row).join('')).not.toMatch(/[\t\r\n]/);
      expect(row.email).toBe('a @x.com; b @x.com');
    });
  });

  describe('exact text', () => {
    it.each([
      ['Japanese', '山田太郎'],
      ['Hindi with joiners', 'क्\u200Dष तुलिका'],
      ['Arabic', 'محمد علي'],
      ['Korean', '김철수'],
      ['accented Latin', 'José Müller-Lüdenscheidt'],
      ['decomposed accents', 'Jose\u0301'],
      ['fullwidth Latin', 'ＡＣＭＥ'],
      ['ligature', 'Oﬃce'],
      ['zero-width space', 'Jane\u200BDoe'],
      ['double space', 'Jane  Doe'],
      ['non-breaking space', 'Jane\u00A0Doe'],
      ['surrounding spaces', '  Jane Doe  '],
      ['capitals', 'JANE DOE'],
    ])('preserves %s byte for byte', (_name, value) => {
      const cell = toRow(card({ name: value })).name;
      expect(Buffer.from(cell)).toEqual(Buffer.from(value));
    });

    it('does not add or strip website prefixes or fix spellings', () => {
      expect(toRow(card({ websites: ['acme.com', 'https://www.acme.com/', 'WWW.ACME.COM'] })).website).toBe(
        'acme.com; https://www.acme.com/; WWW.ACME.COM',
      );
      expect(toRow(card({ company: 'Acme Compnay' })).company).toBe('Acme Compnay');
    });
  });
});
