import { describe, expect, it } from 'vitest';

import type { CardRow } from '../../src/shared/contracts.ts';
import type { TruthSet } from '../synth/truth.ts';
import { classifyField, FAKE_WARNING, formatReport, scoreResults } from './score.ts';

const row = (patch: Partial<CardRow> = {}): CardRow => ({
  name: 'Fern Barnes',
  position: 'Buyer',
  company: 'Acme Tools',
  email: 'fern@acmetools.com',
  phone: '+1 415 555 0132',
  website: '',
  ...patch,
});
const printed = ['Fern Barnes', 'Buyer', 'Acme Tools', '+1 415 555 0132', 'fern@acmetools.com'];

const truth = (): TruthSet => ({
  version: 1,
  source: 'hand-labelled',
  files: [
    { file: 'a.jpg', cards: [{ row: row(), printed, difficulty: 'easy' }] },
    { file: 'b.jpg', cards: [{ row: row({ name: 'Ana Ruiz' }), difficulty: 'hard', buckets: ['sheet-30+'] }, { row: row({ name: 'Bo Li' }), difficulty: 'hard', buckets: ['sheet-30+'] }] },
    { file: 'c.jpg', expect: 'no_card', cards: [] },
  ],
});
const files = [
  { file: 'a.jpg', stage: 'cropped' },
  { file: 'b.jpg', stage: 'cropped' },
  { file: 'c.jpg', stage: 'no_card' },
];

describe('classifyField', () => {
  it('needs an exact match, down to the case', () => {
    expect(classifyField('Fern', 'Fern', [])).toBe('exact');
    expect(classifyField('Fern', 'fern', ['Fern'])).toBe('misread');
  });
  it('tells a misread from an invention', () => {
    expect(classifyField('fern@acmetools.com', 'fern@acrnetools.com', printed)).toBe('misread');
    expect(classifyField('Buyer', 'Vice President of Global Sales', printed)).toBe('invented');
  });
  it('counts a blank-truth field as invented even when the text is printed', () => {
    expect(classifyField('', 'acmetools.com', printed)).toBe('invented');
  });
  it('counts a value left out as missing', () => {
    expect(classifyField('Fern', '', printed)).toBe('missing');
  });
});

describe('scoreResults', () => {
  it('scores a perfect run', () => {
    const report = scoreResults({
      truth: truth(),
      files,
      reader: 'live',
      cards: [
        { file: 'a.jpg', index: 0, status: 'verified', row: row() },
        { file: 'b.jpg', index: 0, status: 'verified', row: row({ name: 'Ana Ruiz' }) },
        { file: 'b.jpg', index: 1, status: 'verified', row: row({ name: 'Bo Li' }) },
      ],
    });
    expect(report.overall.accuracy).toBe(1);
    expect(report.overall.verifiedAccuracy).toBe(1);
    expect(report.targets.every((target) => target.met)).toBe(true);
    expect(report.buckets.find((bucket) => bucket.bucket === 'sheet-30+')?.cards).toBe(2);
  });

  it('names a wrong verified value, a lost card and a wrong order', () => {
    const report = scoreResults({
      truth: truth(),
      files,
      reader: 'live',
      cards: [
        { file: 'a.jpg', index: 0, status: 'verified', row: row({ email: 'fern@acrnetools.com' }) },
        { file: 'b.jpg', index: 0, status: 'verified', row: row({ name: 'Bo Li' }) },
      ],
    });
    expect(report.wrongVerified.filter((error) => error.status === 'verified')).toHaveLength(1);
    expect(report.cardsLost).toBe(1);
    expect(report.overall.lostCards).toBe(1);
    expect(report.targets[0]?.met).toBe(false);

    const shuffled = scoreResults({
      truth: truth(),
      files,
      reader: 'live',
      cards: [
        { file: 'b.jpg', index: 0, status: 'verified', row: row({ name: 'Bo Li' }) },
        { file: 'b.jpg', index: 1, status: 'verified', row: row({ name: 'Ana Ruiz' }) },
      ],
    });
    expect(shuffled.outOfOrderFiles).toEqual(['b.jpg']);
  });

  it('notices a file that ended wrongly', () => {
    const report = scoreResults({ truth: truth(), reader: 'live', cards: [], files: [{ file: 'a.jpg', stage: 'failed' }, { file: 'c.jpg', stage: 'cropped' }] });
    expect(report.fileProblems).toEqual(['b.jpg: no record of this file', 'c.jpg: expected no_card, ended as cropped']);
  });

  it('says plainly that a fake run proves nothing about Luna, and passes no target', () => {
    const report = scoreResults({ truth: truth(), files, cards: [], reader: 'fake' });
    expect(report.warning).toBe(FAKE_WARNING);
    const text = formatReport(report);
    expect(text).toContain('say nothing about real Luna accuracy');
    expect(text).not.toContain('MET');
  });
});
