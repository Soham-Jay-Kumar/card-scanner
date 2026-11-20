import { describe, expect, it } from 'vitest';
import type { CardRow } from '../shared/contracts.ts';
import { findPossibleDuplicates, findSharedOnSheet } from './duplicates.ts';

const row = (patch: Partial<CardRow>): CardRow => ({
  name: '',
  position: '',
  company: '',
  email: '',
  phone: '',
  website: '',
  ...patch,
});

describe('findPossibleDuplicates', () => {
  it('points each later card at the earliest card it shares a contact with', () => {
    const links = findPossibleDuplicates(
      [
        { cardId: 'a', row: row({ email: 'a@x.com' }) },
        { cardId: 'b', row: row({ email: 'b@x.com' }) },
        { cardId: 'c', row: row({ email: 'b@x.com; a@x.com' }) },
        { cardId: 'd', row: row({ email: 'c@x.com; b@x.com' }) },
      ],
      null,
    );
    expect([...links]).toEqual([
      ['a', null],
      ['b', null],
      ['c', 'a'],
      ['d', 'b'],
    ]);
  });

  it('links through a shared phone even when emails differ', () => {
    const links = findPossibleDuplicates(
      [
        { cardId: 'a', row: row({ email: 'a@x.com', phone: '+1 213 373 4253' }) },
        { cardId: 'b', row: row({ email: 'b@x.com', phone: '(213) 373-4253' }) },
      ],
      'US',
    );
    expect(links.get('b')).toBe('a');
  });

  it('compares unparseable phones by digits, ignoring ones too short to mean anything', () => {
    const links = findPossibleDuplicates(
      [
        { cardId: 'a', row: row({ phone: '12-34' }) },
        { cardId: 'b', row: row({ phone: '1 2 3 4' }) },
        { cardId: 'c', row: row({ phone: '12345678' }) },
        { cardId: 'd', row: row({ phone: '1234-5678' }) },
      ],
      null,
    );
    expect(links.get('b')).toBeNull();
    expect(links.get('d')).toBe('c');
  });

  it('never links a card to itself when it repeats a value', () => {
    const links = findPossibleDuplicates([{ cardId: 'a', row: row({ email: 'a@x.com; A@X.COM' }) }], null);
    expect(links.get('a')).toBeNull();
  });

  it('gives a card with no row no link, and lets others skip past it', () => {
    const links = findPossibleDuplicates(
      [
        { cardId: 'a', row: null },
        { cardId: 'b', row: row({ email: 'a@x.com' }) },
        { cardId: 'c', row: row({ email: 'a@x.com' }) },
      ],
      null,
    );
    expect(links.get('a')).toBeNull();
    expect(links.get('c')).toBe('b');
  });

  it('stays quick with 5,000 cards all sharing one phone', () => {
    const cards = Array.from({ length: 5_000 }, (_, index) => ({
      cardId: `card-${index}`,
      row: row({ phone: '+91 98765 43210', email: `p${index}@x.com` }),
    }));
    const started = performance.now();
    const links = findPossibleDuplicates(cards, null);
    // Generous, because other work shares this machine. A nested scan would need 12.5M comparisons.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(links.get('card-4999')).toBe('card-0');
  });
});

describe('findSharedOnSheet', () => {
  const card = (cardId: string, email: string, sourceFileIds: string[]) => ({
    cardId,
    row: row({ email }),
    sourceFileIds,
  });

  it('finds every card sharing an address in one file, and no others', () => {
    const shared = findSharedOnSheet([
      card('a', 'x@acme.com', ['f1']),
      card('b', 'y@acme.com; X@ACME.com', ['f1']),
      card('c', 'x@acme.com', ['f1']),
      card('d', 'x@acme.com', ['f2']),
      card('e', 'z@acme.com', ['f1']),
    ]);
    expect([...shared].sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not count a card repeating an address in its own cell', () => {
    expect(findSharedOnSheet([card('a', 'x@acme.com; X@acme.com', ['f1'])]).size).toBe(0);
  });

  it('skips a card with no row and a blank email', () => {
    const shared = findSharedOnSheet([
      { cardId: 'a', row: null, sourceFileIds: ['f1'] },
      card('b', '', ['f1']),
      card('c', '', ['f1']),
    ]);
    expect(shared.size).toBe(0);
  });
});
