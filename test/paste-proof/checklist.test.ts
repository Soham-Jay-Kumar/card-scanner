/** Keeps the checklist in step with the test set, so a person never checks an old list. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PHONE_CASES } from '../../src/paste/phoneCases.ts';

const checklist = readFileSync(join(import.meta.dirname, 'CHECKLIST.md'), 'utf8');

describe('paste checklist', () => {
  it('lists every value in the paste test set', () => {
    const absent = PHONE_CASES.filter((item) => !checklist.includes(`\`${item.value}\``)).map((item) => item.value);
    expect(absent).toEqual([]);
  });

  it('covers every route, and photos of 30 or more cards', () => {
    for (const route of ['1. Sheets, normal', '2. Sheets, values only', '3. Excel web, normal', '4. Excel web, values only', '5. Desktop Excel, normal', '6. Desktop Excel, values only', '30+ cards, Google Sheets', '30+ cards, Excel for the web']) {
      expect(checklist).toContain(route);
    }
  });
});
