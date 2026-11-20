import { describe, expect, it } from 'vitest';
import { zodTextFormat } from 'openai/helpers/zod';
import { FIELD_KEYS, SCHEMA_NAMES, type CardReadData } from '../shared/contracts.ts';
import { cardReadSchema } from './schema.ts';

const format = zodTextFormat(cardReadSchema, SCHEMA_NAMES.read);
const jsonSchema = format.schema as {
  type: string;
  additionalProperties: boolean;
  required: string[];
  properties: Record<string, {
    type: string;
    items: {
      type?: string;
      enum?: string[];
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, unknown>;
    };
  }>;
};

const valid: CardReadData = {
  transcript: ['Jane Doe'],
  name: 'Jane Doe',
  position: '',
  company: '',
  emails: [],
  phones: [{ number: '+1 555 123 4567', label: 'Tel:' }],
  websites: [],
  unreadable: ['company'],
};

const EXPECTED_KEYS = ['transcript', 'name', 'position', 'company', 'emails', 'phones', 'websites', 'unreadable'];

describe('cardReadSchema', () => {
  it('converts with zodTextFormat as a strict format under the shared name', () => {
    expect(format.type).toBe('json_schema');
    expect(format.name).toBe('card_read');
    expect(format.strict).toBe(true);
    expect(jsonSchema.type).toBe('object');
  });

  it('puts transcript first in both the Zod shape and the generated JSON schema', () => {
    expect(Object.keys(cardReadSchema.shape)).toEqual(EXPECTED_KEYS);
    expect(Object.keys(jsonSchema.properties)).toEqual(EXPECTED_KEYS);
    expect(jsonSchema.required[0]).toBe('transcript');
  });

  it('requires every property and forbids extras at every object level', () => {
    expect([...jsonSchema.required].sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(jsonSchema.additionalProperties).toBe(false);

    const phoneItem = jsonSchema.properties.phones!.items;
    expect(phoneItem.additionalProperties).toBe(false);
    expect([...phoneItem.required!].sort()).toEqual(['label', 'number']);
    expect(Object.keys(phoneItem.properties!)).toEqual(['number', 'label']);
  });

  it('limits unreadable to the six field keys', () => {
    expect(jsonSchema.properties.unreadable!.items.enum).toEqual([...FIELD_KEYS]);
    expect(cardReadSchema.safeParse({ ...valid, unreadable: ['address'] }).success).toBe(false);
  });

  it('accepts a matching answer unchanged', () => {
    expect(cardReadSchema.parse(valid)).toEqual(valid);
  });

  it.each(EXPECTED_KEYS)('rejects an answer missing %s', (key) => {
    const { [key as keyof CardReadData]: _omitted, ...rest } = valid;
    expect(cardReadSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects extra keys', () => {
    expect(cardReadSchema.safeParse({ ...valid, address: 'x' }).success).toBe(false);
    const phones = [{ number: '1', label: '', extension: '2' }];
    expect(cardReadSchema.safeParse({ ...valid, phones }).success).toBe(false);
  });
});
