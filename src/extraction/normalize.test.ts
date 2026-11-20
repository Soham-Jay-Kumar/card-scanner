import { describe, expect, it } from 'vitest';
import { FIELD_KEYS, type FieldKey } from '../shared/contracts.ts';
import { comparisonKey } from './normalize.ts';

const same = (field: FieldKey, a: string, b: string) => comparisonKey(field, a) === comparisonKey(field, b);

describe('comparisonKey', () => {
  describe('name, position and company', () => {
    it.each(['name', 'position', 'company'] as const)('%s ignores spacing and Unicode form but keeps case', (field) => {
      expect(same(field, 'Jane  Doe', ' Jane Doe ')).toBe(true);
      expect(same(field, 'Jose\u0301', 'Jos\u00E9')).toBe(true);
      expect(same(field, 'Jane\u200BDoe', 'JaneDoe')).toBe(true);
      expect(same(field, 'Jane Doe', 'JANE DOE')).toBe(false);
    });
  });

  describe('email and website', () => {
    it.each(['email', 'website'] as const)('%s ignores case', (field) => {
      expect(same(field, 'Jane@Acme.COM', 'jane@acme.com')).toBe(true);
    });

    it.each(['email', 'website'] as const)('%s compares as a set', (field) => {
      expect(same(field, 'a.com; b.com', 'b.com; a.com')).toBe(true);
      expect(same(field, 'a.com; b.com', 'A.COM; B.COM')).toBe(true);
      expect(same(field, 'a.com; b.com', 'a.com')).toBe(false);
      expect(same(field, 'a.com; b.com', 'a.com; c.com')).toBe(false);
    });

    it('treats an added www or https as a real difference', () => {
      expect(same('website', 'acme.com', 'www.acme.com')).toBe(false);
      expect(same('website', 'acme.com', 'https://acme.com')).toBe(false);
    });
  });

  describe('phone', () => {
    it.each([
      ['+91 98765 43210', '+919876543210'],
      ['+91 98765 43210', '+91-98765-43210'],
      ['(555) 123-4567', '555.123.4567'],
      ['(+91) 98765 43210', '+91 98765 43210'],
      ['+1 555\u00A0123 4567', '+1 555 123 4567'],
      ['＋１ ５５５ １２３ ４５６７', '+1 555 123 4567'],
      ['+1 555 123 4567; 555 000 1111', '555-000-1111; +1-555-123-4567'],
    ])('tolerates formatting between %s and %s', (a, b) => {
      expect(same('phone', a, b)).toBe(true);
    });

    it.each([
      ['a lost +', '+91 98765 43210', '91 98765 43210'],
      ['a changed digit', '+91 98765 43210', '+91 98765 43211'],
      ['a dropped digit', '+91 98765 43210', '+91 98765 4321'],
      ['a dropped leading zero', '0412345678', '412345678'],
      ['a dropped trunk zero', '+44 (0)20 7946 0958', '+44 20 7946 0958'],
      ['a letter O for a zero', '555-0123', '555-O123'],
      ['a changed vanity letter', '1-800-FLOWERS', '1-800-FLOWERZ'],
      ['a label left in the number', 'Tel: 555 1234', '555 1234'],
      ['a missing number', '555 1111; 555 2222', '555 1111'],
    ])('detects %s', (_name, a, b) => {
      expect(same('phone', a, b)).toBe(false);
    });
  });

  it('gives every field an empty key for a blank cell', () => {
    for (const field of FIELD_KEYS) expect(comparisonKey(field, '')).toBe('');
  });
});
