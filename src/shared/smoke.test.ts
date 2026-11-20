import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { FIELD_KEYS, JobPauseError } from './contracts.ts';
import { CONFIG } from './config.ts';

describe('toolchain smoke', () => {
  it('loads contracts and config', () => {
    expect(FIELD_KEYS).toHaveLength(6);
    expect(new JobPauseError('user', 'x').reason).toBe('user');
    expect(CONFIG.model).toBe('gpt-6-luna');
  });
  it('runs node:sqlite under vitest', () => {
    const d = new DatabaseSync(':memory:');
    expect(d.prepare('select 1 as v').get()).toEqual({ v: 1 });
  });
  it('runs sharp under vitest', async () => {
    const b = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer();
    expect(b.length).toBeGreaterThan(0);
  });
  it('builds a strict structured-output format from zod 4', () => {
    const f = zodTextFormat(z.object({ a: z.string(), b: z.array(z.string()) }), 'x');
    expect(f.type).toBe('json_schema');
    expect((f.schema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});
