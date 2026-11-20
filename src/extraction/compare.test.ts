import { describe, expect, it } from 'vitest';
import {
  FIELD_KEYS,
  type CardReadData,
  type LlmFailure,
  type ReadOutcome,
  type ReadRecord,
  type ReadVariant,
} from '../shared/contracts.ts';
import { compare } from './compare.ts';

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

function record(variant: ReadVariant, outcome: ReadOutcome): ReadRecord {
  return { cardId: 'card', variant, outcome, model: 'gpt-6-luna', usage: null, createdAt: '2026-11-06T00:00:00.000Z' };
}

const good = (variant: ReadVariant, patch: Partial<CardReadData> = {}) => record(variant, { ok: true, data: card(patch) });
const failed = (variant: ReadVariant, failure: LlmFailure = 'refused') => record(variant, { ok: false, failure, detail: 'x' });

/** Three good reads that differ only in the given patches. */
const threeReads = (a: Partial<CardReadData>, b: Partial<CardReadData>, c: Partial<CardReadData>) => [good('A', a), good('B', b), good('C', c)];
const companies = (a: string, b: string, c: string) =>
  compare(threeReads({ company: a }, { company: b }, { company: c })).company;
const emails = (a: string[], b: string[], c: string[]) =>
  compare(threeReads({ emails: a }, { emails: b }, { emails: c })).email;
const phone = (number: string) => ({ phones: [{ number, label: 'Tel:' }] });

describe('compare: agreement outcomes', () => {
  it('is unanimous when all three reads match', () => {
    const result = companies('Acme', 'Acme', 'Acme');
    expect(result).toMatchObject({
      field: 'company',
      agreement: 'unanimous',
      chosen: 'Acme',
      values: { A: 'Acme', B: 'Acme', C: 'Acme' },
      candidates: [{ value: 'Acme', reads: ['A', 'B', 'C'] }],
      unreadable: false,
    });
  });

  it.each([
    ['A and B', 'Acme', 'Acme', 'Acne', ['A', 'B'], ['C']],
    ['A and C', 'Acme', 'Acne', 'Acme', ['A', 'C'], ['B']],
    ['B and C', 'Acne', 'Acme', 'Acme', ['B', 'C'], ['A']],
  ])('is a majority when %s match', (_who, a, b, c, topReads, otherReads) => {
    const result = companies(a, b, c);
    expect(result.agreement).toBe('majority');
    expect(result.chosen).toBe('Acme');
    expect(result.candidates).toEqual([
      { value: 'Acme', reads: topReads },
      { value: 'Acne', reads: otherReads },
    ]);
  });

  it('is split when no two reads match, with an empty chosen value', () => {
    const result = companies('Acme', 'Acne', 'Arne');
    expect(result.agreement).toBe('split');
    expect(result.chosen).toBe('');
    expect(result.candidates).toEqual([
      { value: 'Acme', reads: ['A'] },
      { value: 'Acne', reads: ['B'] },
      { value: 'Arne', reads: ['C'] },
    ]);
  });

  it('returns all six fields, each tagged with its own key', () => {
    const result = compare(threeReads({}, {}, {}));
    expect(Object.keys(result)).toEqual([...FIELD_KEYS]);
    for (const field of FIELD_KEYS) expect(result[field].field).toBe(field);
  });

  it('compares each field independently', () => {
    const result = compare(threeReads(
      { name: 'Jane', company: 'Acme', emails: ['a@x.com'] },
      { name: 'Jane', company: 'Acme', emails: ['b@x.com'] },
      { name: 'Jane', company: 'Acne', emails: ['c@x.com'] },
    ));
    expect(result.name.agreement).toBe('unanimous');
    expect(result.company.agreement).toBe('majority');
    expect(result.email.agreement).toBe('split');
  });

  it('does not depend on the order of the records', () => {
    const reads = threeReads({ company: 'Acme' }, { company: 'Acme' }, { company: 'Acne' });
    expect(compare([...reads].reverse())).toEqual(compare(reads));
  });
});

describe('compare: failed reads', () => {
  it('one failed read: two matching reads are a majority, never unanimous', () => {
    const result = compare([failed('A'), good('B', { company: 'Acme' }), good('C', { company: 'Acme' })]).company;
    expect(result.agreement).toBe('majority');
    expect(result.chosen).toBe('Acme');
    expect(result.values).toEqual({ A: null, B: 'Acme', C: 'Acme' });
    expect(result.candidates).toEqual([{ value: 'Acme', reads: ['B', 'C'] }]);
  });

  it('one failed read: two different reads are split', () => {
    const result = compare([good('A', { company: 'Acme' }), failed('B', 'incomplete'), good('C', { company: 'Acne' })]).company;
    expect(result.agreement).toBe('split');
    expect(result.chosen).toBe('');
    expect(result.values).toEqual({ A: 'Acme', B: null, C: 'Acne' });
  });

  it('two failed reads: one good read is split, never trusted on its own', () => {
    const result = compare([failed('A'), failed('B', 'schema_invalid'), good('C', { company: 'Acme' })]).company;
    expect(result.agreement).toBe('split');
    expect(result.chosen).toBe('');
    expect(result.candidates).toEqual([{ value: 'Acme', reads: ['C'] }]);
  });

  it('three failed reads: every field is split with no candidates', () => {
    const result = compare([failed('A'), failed('B'), failed('C', 'retries_exhausted')]);
    for (const field of FIELD_KEYS) {
      expect(result[field]).toEqual({
        field,
        values: { A: null, B: null, C: null },
        agreement: 'split',
        chosen: '',
        candidates: [],
        unreadable: false,
      });
    }
  });

  it('counts a missing record as a failed read', () => {
    const result = compare([good('A', { company: 'Acme' }), good('B', { company: 'Acme' })]).company;
    expect(result.agreement).toBe('majority');
    expect(result.values.C).toBeNull();
  });

  it('handles no reads at all', () => {
    expect(compare([]).name).toMatchObject({ agreement: 'split', chosen: '', candidates: [] });
  });

  it('a repeated variant can never make up the three reads needed for unanimous', () => {
    const result = compare([good('A', { company: 'Acme' }), good('A', { company: 'Acme' }), good('A', { company: 'Acme' })]).company;
    expect(result.agreement).toBe('split');
  });

  it('two blank reads with one failure are a majority for blank, not unanimous', () => {
    const result = compare([good('A'), good('B'), failed('C')]).website;
    expect(result).toMatchObject({ agreement: 'majority', chosen: '' });
  });
});

describe('compare: blanks', () => {
  it('three blanks are unanimous for blank', () => {
    const result = companies('', '', '');
    expect(result).toMatchObject({ agreement: 'unanimous', chosen: '', candidates: [{ value: '', reads: ['A', 'B', 'C'] }] });
  });

  it('two blanks beat one value', () => {
    const result = companies('', 'Acme', '');
    expect(result.agreement).toBe('majority');
    expect(result.chosen).toBe('');
    expect(result.candidates).toEqual([
      { value: '', reads: ['A', 'C'] },
      { value: 'Acme', reads: ['B'] },
    ]);
  });

  it('two values beat one blank', () => {
    const result = companies('Acme', '', 'Acme');
    expect(result).toMatchObject({ agreement: 'majority', chosen: 'Acme' });
    expect(result.candidates[1]).toEqual({ value: '', reads: ['B'] });
  });

  it('one blank and two different values are split', () => {
    expect(companies('', 'Acme', 'Acne').agreement).toBe('split');
  });

  it('a whitespace-only reading is a blank', () => {
    expect(companies('', '   ', '\u200B')).toMatchObject({ agreement: 'unanimous', chosen: '' });
  });

  it('empty multi-value lists are unanimous blanks', () => {
    expect(emails([], [], [])).toMatchObject({ agreement: 'unanimous', chosen: '' });
  });
});

describe('compare: real misreads are detected', () => {
  it('rn versus m is a real difference', () => {
    const result = emails(['jane@acme.com'], ['jane@acrne.com'], ['jane@acme.com']);
    expect(result.agreement).toBe('majority');
    expect(result.chosen).toBe('jane@acme.com');
    expect(result.candidates[1]).toEqual({ value: 'jane@acrne.com', reads: ['B'] });
  });

  it('rn versus m in a name is a real difference', () => {
    expect(companies('Bernard', 'Bemard', 'Bernard').agreement).toBe('majority');
  });

  it('0 versus O is a real difference', () => {
    expect(companies('ACME 2O24', 'ACME 2024', 'ACME 2O24').agreement).toBe('majority');
    expect(emails(['a@x0.com'], ['a@xo.com'], ['a@xO.com']).agreement).toBe('majority');
  });

  it('1 versus l is a real difference', () => {
    expect(companies('Bell', 'Be1l', 'Bel1').agreement).toBe('split');
  });

  it('a Cyrillic lookalike is a real difference', () => {
    expect(companies('Acme', '\u0410cme', 'Acme').agreement).toBe('majority');
  });
});

describe('compare: phones', () => {
  const phones = (a: string, b: string, c: string) => compare(threeReads(phone(a), phone(b), phone(c))).phone;

  it('treats spacing-only differences as agreement', () => {
    const result = phones('+91 98765 43210', '+91 9876543210', '+91-98765-43210');
    expect(result.agreement).toBe('unanimous');
    expect(result.candidates).toHaveLength(1);
  });

  it('treats a lost + as a real difference', () => {
    const result = phones('+91 98765 43210', '91 98765 43210', '+91 98765 43210');
    expect(result.agreement).toBe('majority');
    expect(result.chosen).toBe('+91 98765 43210');
  });

  it('treats a changed digit as a real difference', () => {
    expect(phones('555 1234', '555 1235', '555 1236').agreement).toBe('split');
  });

  it('keeps the chosen value exactly as printed, not as the digits-only key', () => {
    expect(phones('+1 (555) 123-4567', '+1 (555) 123-4567', '+15551234567').chosen).toBe('+1 (555) 123-4567');
  });

  it('compares multi-value cells regardless of order', () => {
    const a = { phones: [{ number: '555 1111', label: 'T' }, { number: '555 2222', label: 'M' }] };
    const b = { phones: [{ number: '555 2222', label: 'M' }, { number: '555 1111', label: 'T' }] };
    const result = compare(threeReads(a, b, a)).phone;
    expect(result.agreement).toBe('unanimous');
    expect(result.chosen).toBe('555 1111; 555 2222');
  });

  it('compares after fax numbers are removed', () => {
    const withFax = { phones: [{ number: '555 1111', label: 'Tel:' }, { number: '555 2222', label: 'Fax' }] };
    const without = { phones: [{ number: '555 1111', label: 'Tel:' }] };
    const result = compare(threeReads(withFax, without, withFax)).phone;
    expect(result.agreement).toBe('unanimous');
    expect(result.values).toEqual({ A: '555 1111', B: '555 1111', C: '555 1111' });
  });
});

describe('compare: case', () => {
  it('ignores case for email', () => {
    expect(emails(['Jane@Acme.com'], ['jane@acme.com'], ['JANE@ACME.COM']).agreement).toBe('unanimous');
  });

  it('ignores case for website', () => {
    const websites = (value: string) => ({ websites: [value] });
    expect(compare(threeReads(websites('WWW.ACME.COM'), websites('www.acme.com'), websites('Www.Acme.Com'))).website.agreement).toBe('unanimous');
  });

  it.each(['name', 'position', 'company'] as const)('keeps case significant for %s', (field) => {
    const result = compare(threeReads({ [field]: 'Jane Doe' }, { [field]: 'JANE DOE' }, { [field]: 'Jane Doe' }))[field];
    expect(result.agreement).toBe('majority');
    expect(result.candidates).toHaveLength(2);
  });
});

describe('compare: multi-value order', () => {
  it('treats reordered emails as agreement', () => {
    const result = emails(['a@x.com', 'b@x.com'], ['b@x.com', 'a@x.com'], ['a@x.com', 'b@x.com']);
    expect(result.agreement).toBe('unanimous');
    expect(result.chosen).toBe('a@x.com; b@x.com');
  });

  it('treats a missing value as a real difference', () => {
    expect(emails(['a@x.com', 'b@x.com'], ['a@x.com'], ['a@x.com', 'b@x.com']).agreement).toBe('majority');
  });
});

describe('compare: chosen text when reads match cosmetically', () => {
  it('picks the most common exact string', () => {
    const result = emails(['jane@acme.com'], ['Jane@Acme.com'], ['Jane@Acme.com']);
    expect(result.agreement).toBe('unanimous');
    expect(result.chosen).toBe('Jane@Acme.com');
  });

  it('resolves a three-way tie to read A', () => {
    expect(emails(['Jane@acme.com'], ['jane@Acme.com'], ['JANE@acme.com']).chosen).toBe('Jane@acme.com');
  });

  it('resolves a two-way tie to the earlier read', () => {
    expect(emails(['a@x.com'], ['b@x.com'], ['A@X.COM'])).toMatchObject({ agreement: 'majority', chosen: 'a@x.com' });
    expect(compare([failed('A'), good('B', { emails: ['Z@x.com'] }), good('C', { emails: ['z@x.com'] })]).email.chosen).toBe('Z@x.com');
  });

  it('keeps each read in values exactly as it came', () => {
    expect(emails(['jane@acme.com'], ['Jane@Acme.com'], ['Jane@Acme.com']).values).toEqual({
      A: 'jane@acme.com',
      B: 'Jane@Acme.com',
      C: 'Jane@Acme.com',
    });
  });

  it('treats a zero-width character as cosmetic, and never strips it from the values', () => {
    const result = companies('Ac\u200Bme', 'Acme', 'Acme');
    expect(result.agreement).toBe('unanimous');
    expect(result.chosen).toBe('Acme');
    expect(result.values.A).toBe('Ac\u200Bme');
  });

  it('a zero-width tie goes to the earliest read, exactly as read', () => {
    expect(compare([good('A', { company: 'Ac\u200Bme' }), good('B', { company: 'Acme' })]).company.chosen).toBe('Ac\u200Bme');
  });

  it('treats composed and decomposed accents as cosmetic', () => {
    expect(companies('Jose\u0301', 'Jos\u00E9', 'Jos\u00E9')).toMatchObject({ agreement: 'unanimous', chosen: 'Jos\u00E9' });
  });
});

describe('compare: non-Latin text', () => {
  it.each(['山田太郎', 'तुलिका', 'محمد علي', '김철수'])('keeps %s byte for byte', (name) => {
    const result = compare(threeReads({ name }, { name }, { name })).name;
    expect(result.agreement).toBe('unanimous');
    expect(Buffer.from(result.chosen)).toEqual(Buffer.from(name));
  });

  it('detects a changed character', () => {
    expect(companies('山田太郎', '山田大郎', '山田太郎').agreement).toBe('majority');
  });
});

describe('compare: unreadable', () => {
  it('is true when any one read flagged the field, and only for that field', () => {
    const result = compare(threeReads({}, { unreadable: ['email'] }, {}));
    expect(result.email.unreadable).toBe(true);
    expect(result.name.unreadable).toBe(false);
  });

  it('keeps the flag on an otherwise unanimous blank', () => {
    const result = compare(threeReads({ unreadable: ['name'] }, { unreadable: ['name'] }, { unreadable: ['name'] })).name;
    expect(result).toMatchObject({ agreement: 'unanimous', chosen: '', unreadable: true });
  });

  it('keeps the flag when the flagging read lost the vote', () => {
    const result = compare(threeReads({ company: 'Acme' }, { company: 'Acme' }, { unreadable: ['company'] })).company;
    expect(result).toMatchObject({ agreement: 'majority', chosen: 'Acme', unreadable: true });
  });
});
