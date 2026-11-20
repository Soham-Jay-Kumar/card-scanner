import { describe, expect, it, vi } from 'vitest';
import { compare } from '../extraction/compare.ts';
import {
  FIELD_KEYS,
  READ_VARIANTS,
  type CardReadData,
  type CheckName,
  type FieldKey,
  type QualityIssue,
  type QualityReport,
  type ReadRecord,
  type ReadVariant,
} from '../shared/contracts.ts';
import { createDecisionService } from './index.ts';
import type { ResolveDomain } from './domains.ts';

const card = (patch: Partial<CardReadData> = {}): CardReadData => ({
  transcript: [
    'Dr. Jane Doe, PhD',
    'Chief Executive Officer',
    'Acme Corp',
    'jane.doe@acme.com',
    'Tel: +1 213 373 4253',
    'www.acme.com',
  ],
  name: 'Dr. Jane Doe, PhD',
  position: 'Chief Executive Officer',
  company: 'Acme Corp',
  emails: ['jane.doe@acme.com'],
  phones: [{ number: '+1 213 373 4253', label: 'Tel' }],
  websites: ['www.acme.com'],
  unreadable: [],
  ...patch,
});

const goodRead = (variant: ReadVariant, data: CardReadData): ReadRecord => ({
  cardId: 'card-1',
  variant,
  outcome: { ok: true, data },
  model: 'gpt-6-luna',
  usage: null,
  createdAt: '2026-11-06T00:00:00.000Z',
});

const failedRead = (variant: ReadVariant): ReadRecord => ({
  cardId: 'card-1',
  variant,
  outcome: { ok: false, failure: 'incomplete', detail: 'cut off' },
  model: 'gpt-6-luna',
  usage: null,
  createdAt: '2026-11-06T00:00:00.000Z',
});

const threeReads = (data: CardReadData): ReadRecord[] => READ_VARIANTS.map((variant) => goodRead(variant, data));

const goodQuality: QualityReport = {
  ok: true,
  width: 1600,
  height: 900,
  blurScore: 300,
  meanLuminance: 140,
  issues: [],
};

const allExist: ResolveDomain = async () => 'exists';

async function decide(
  reads: ReadRecord[],
  options: { resolveDomain?: ResolveDomain; quality?: QualityReport | null; defaultCountry?: string | null } = {},
) {
  const { decide: run } = createDecisionService({ resolveDomain: options.resolveDomain ?? allExist });
  return run({
    reads,
    consensus: compare(reads),
    quality: options.quality === undefined ? goodQuality : options.quality,
    defaultCountry: options.defaultCountry ?? null,
  });
}

function failed(decision: Awaited<ReturnType<typeof decide>>, check: CheckName, field?: FieldKey | null) {
  return decision.checks.filter(
    (item) => item.check === check && !item.passed && (field === undefined || item.field === field),
  );
}

describe('verified', () => {
  it('needs three good reads, unanimity and every check passed', async () => {
    const decision = await decide(threeReads(card()));
    expect(decision.status).toBe('verified');
    expect(decision.flaggedFields).toEqual([]);
    expect(decision.checks.every((item) => item.passed)).toBe(true);
    expect(decision.row).toEqual({
      name: 'Dr. Jane Doe, PhD',
      position: 'Chief Executive Officer',
      company: 'Acme Corp',
      email: 'jane.doe@acme.com',
      phone: '+1 213 373 4253',
      website: 'www.acme.com',
    });
  });

  it('counts a field blank in all three reads as verified blank', async () => {
    const decision = await decide(threeReads(card({ websites: [], position: '' })));
    expect(decision.status).toBe('verified');
    expect(decision.row.website).toBe('');
    expect(decision.row.position).toBe('');
  });

  it('ran every kind of check, and each explains itself', async () => {
    const decision = await decide(threeReads(card()));
    const kinds = new Set(decision.checks.map((item) => item.check));
    for (const check of [
      'verbatim',
      'agreement',
      'format',
      'real_domain',
      'near_miss',
      'unsafe_start',
      'unreadable',
      'quality',
      'missing_name',
    ] as const) {
      expect(kinds.has(check)).toBe(true);
    }
    for (const item of decision.checks) expect(item.detail.length).toBeGreaterThan(10);
  });

  it('hands back the consensus it was given', async () => {
    const reads = threeReads(card());
    const consensus = compare(reads);
    const { decide: run } = createDecisionService({ resolveDomain: allExist });
    const decision = await run({ reads, consensus, quality: goodQuality, defaultCountry: null });
    expect(decision.consensus).toBe(consensus);
  });
});

describe('reads', () => {
  it.each(READ_VARIANTS)('sends the card to review when read %s fails, keeping the majority values', async (lost) => {
    const reads = READ_VARIANTS.map((variant) => (variant === lost ? failedRead(variant) : goodRead(variant, card())));
    const decision = await decide(reads);
    expect(decision.status).toBe('needs_review');
    expect(decision.row.name).toBe('Dr. Jane Doe, PhD');
    expect(decision.row.phone).toBe('+1 213 373 4253');
    expect(failed(decision, 'agreement', null)[0]?.detail).toBe(
      'Only 2 of 3 reads of this card succeeded, so its values could not be fully cross-checked.',
    );
    expect(decision.flaggedFields).toEqual([...FIELD_KEYS]);
  });

  it('never verifies on one reading', async () => {
    const decision = await decide([goodRead('A', card()), failedRead('B'), failedRead('C')]);
    expect(decision.status).toBe('needs_review');
    expect(decision.flaggedFields.length).toBeGreaterThan(0);
  });

  it('survives every read failing', async () => {
    const decision = await decide(READ_VARIANTS.map(failedRead));
    expect(decision.status).toBe('needs_review');
    expect(decision.row).toEqual({ name: '', position: '', company: '', email: '', phone: '', website: '' });
  });

  it('does not verify when only two reads were passed in', async () => {
    const decision = await decide([goodRead('A', card()), goodRead('B', card())]);
    expect(decision.status).toBe('needs_review');
  });
});

describe('agreement', () => {
  it('flags only the disputed field and pre-selects the majority', async () => {
    const reads = [
      goodRead('A', card()),
      goodRead('B', card()),
      goodRead('C', card({ company: 'Acne Corp', transcript: card().transcript.concat('Acne Corp') })),
    ];
    const decision = await decide(reads);
    expect(decision.status).toBe('needs_review');
    expect(decision.row.company).toBe('Acme Corp');
    expect(decision.flaggedFields).toEqual(['company']);
    expect(failed(decision, 'agreement', 'company')[0]?.detail).toContain('read C found "Acne Corp"');
    expect(failed(decision, 'agreement', 'company')[0]?.detail).toContain('Two of the three reads agree');
  });

  it('leaves a three-way split blank for the reviewer', async () => {
    const extra = ['Acme Corp', 'Acne Corp', 'Acrne Corp'];
    const reads = READ_VARIANTS.map((variant, index) =>
      goodRead(variant, card({ company: extra[index] ?? '', transcript: card().transcript.concat(extra) })),
    );
    const decision = await decide(reads);
    expect(decision.status).toBe('needs_review');
    expect(decision.row.company).toBe('');
    expect(failed(decision, 'agreement', 'company')[0]?.detail).toContain('The reads disagree');
  });

  it('treats one read finding a value and two finding nothing as a dispute', async () => {
    const reads = [goodRead('A', card()), goodRead('B', card()), goodRead('C', card({ websites: [] }))];
    const decision = await decide(reads);
    expect(decision.status).toBe('needs_review');
    expect(decision.flaggedFields).toContain('website');
    expect(failed(decision, 'agreement', 'website')[0]?.detail).toContain('read C found nothing');
  });
});

describe('verbatim', () => {
  it('fails a value missing from the transcript of the read that produced it', async () => {
    const data = card({ company: 'Acme Corporation' });
    const decision = await decide(threeReads(data));
    expect(decision.status).toBe('needs_review');
    expect(failed(decision, 'verbatim', 'company')).toHaveLength(1);
    expect(decision.flaggedFields).toEqual(['company']);
  });

  it('fails when only one read invented the value', async () => {
    const invented = card({ name: 'Dr. Jane Doe, PhD', transcript: ['Chief Executive Officer', 'Acme Corp'] });
    const reads = [goodRead('A', card()), goodRead('B', card()), goodRead('C', invented)];
    const decision = await decide(reads);
    expect(failed(decision, 'verbatim', 'name')[0]?.detail).toContain('(read C)');
    expect(decision.status).toBe('needs_review');
  });

  it('checks each value in a multi-value cell', async () => {
    const data = card({
      phones: [
        { number: '+1 213 373 4253', label: 'Tel' },
        { number: '+1 213 373 4254', label: 'Mobile' },
      ],
    });
    const decision = await decide(threeReads(data));
    expect(failed(decision, 'verbatim', 'phone')[0]?.detail).toContain('+1 213 373 4254');
  });

  it('accepts every value when all are printed, even on separate lines', async () => {
    const data = card({
      transcript: card().transcript.concat('+1 213 373 4254'),
      phones: [
        { number: '+1 213 373 4253', label: 'Tel' },
        { number: '+1 213 373 4254', label: 'Mobile' },
      ],
    });
    expect((await decide(threeReads(data))).status).toBe('verified');
  });

  it('accepts a value printed across two lines', async () => {
    const data = card({
      position: 'Chief Executive Officer, Americas',
      transcript: ['Dr. Jane Doe, PhD', 'Chief Executive Officer,', 'Americas', 'Acme Corp', 'jane.doe@acme.com', '+1 213 373 4253', 'www.acme.com'],
    });
    expect((await decide(threeReads(data))).status).toBe('verified');
  });

  it('compares with normalizeText, so spacing and Unicode form do not matter', async () => {
    const data = card({
      company: 'Café  Acme',
      transcript: card().transcript.concat('Cafe\u0301 \u00A0Acme'),
    });
    const decision = await decide(threeReads(data));
    expect(failed(decision, 'verbatim')).toEqual([]);
  });

  it('does not ignore letter case: a corrected value is a changed value', async () => {
    const data = card({ company: 'ACME CORP' });
    expect(failed(await decide(threeReads(data)), 'verbatim', 'company')).toHaveLength(1);
  });
});

describe('format', () => {
  it('fails bad email syntax', async () => {
    const data = card({ emails: ['jane.doe@acme'], transcript: ['Dr. Jane Doe, PhD', 'Chief Executive Officer', 'Acme Corp', 'jane.doe@acme', '+1 213 373 4253', 'www.acme.com'] });
    const decision = await decide(threeReads(data));
    expect(failed(decision, 'format', 'email')[0]?.detail).toContain("isn't a valid email address");
  });

  it('fails a phone the library cannot confirm', async () => {
    const data = card({ phones: [{ number: '+1 555 123 4567', label: '' }], transcript: card().transcript.concat('+1 555 123 4567') });
    const decision = await decide(threeReads(data));
    expect(failed(decision, 'format', 'phone')).toHaveLength(1);
    expect(decision.status).toBe('needs_review');
  });

  it('fails a vanity number, because the library cannot confirm it', async () => {
    const data = card({ phones: [{ number: '1-800-FLOWERS', label: '' }], transcript: card().transcript.concat('1-800-FLOWERS') });
    expect(failed(await decide(threeReads(data), { defaultCountry: 'US' }), 'format', 'phone')).toHaveLength(1);
  });

  it('uses the job default country for numbers with no country code', async () => {
    const data = card({ phones: [{ number: '98765 43210', label: '' }], transcript: card().transcript.concat('98765 43210') });
    expect((await decide(threeReads(data), { defaultCountry: 'IN' })).status).toBe('verified');
    const noCountry = await decide(threeReads(data));
    expect(failed(noCountry, 'format', 'phone')[0]?.detail).toContain('no default country');
  });

  it('accepts a lower-case default country', async () => {
    const data = card({ phones: [{ number: '98765 43210', label: '' }], transcript: card().transcript.concat('98765 43210') });
    expect((await decide(threeReads(data), { defaultCountry: 'in' })).status).toBe('verified');
  });

  it('checks every phone in a cell', async () => {
    const data = card({
      phones: [
        { number: '+1 213 373 4253', label: '' },
        { number: '+1 213', label: '' },
      ],
      transcript: card().transcript.concat('+1 213'),
    });
    expect(failed(await decide(threeReads(data)), 'format', 'phone')[0]?.detail).toContain('"+1 213"');
  });

  it('fails a bad web address', async () => {
    const data = card({ websites: ['www.acme.c'], transcript: card().transcript.concat('www.acme.c') });
    expect(failed(await decide(threeReads(data)), 'format', 'website')).toHaveLength(1);
  });
});

describe('real_domain', () => {
  it('asks about the email and website domains with the right kind', async () => {
    const resolveDomain = vi.fn<ResolveDomain>(async () => 'exists');
    await decide(threeReads(card()), { resolveDomain });
    expect(resolveDomain).toHaveBeenCalledWith('acme.com', 'email');
    expect(resolveDomain).toHaveBeenCalledWith('www.acme.com', 'website');
  });

  it.each([
    ['missing', "doesn't exist"],
    ['unknown', "couldn't be confirmed"],
  ] as const)('does not pass on %s', async (status, wording) => {
    const decision = await decide(threeReads(card()), { resolveDomain: async () => status });
    expect(decision.status).toBe('needs_review');
    expect(failed(decision, 'real_domain', 'email')[0]?.detail).toContain(wording);
    expect(failed(decision, 'real_domain', 'website')).toHaveLength(1);
    expect(decision.flaggedFields).toEqual(['email', 'website']);
  });

  it('treats a resolver that throws as unknown, never as a pass', async () => {
    const decision = await decide(threeReads(card()), {
      resolveDomain: async () => {
        throw new Error('network down');
      },
    });
    expect(decision.status).toBe('needs_review');
    expect(failed(decision, 'real_domain')).toHaveLength(2);
  });

  it('checks every address in a multi-value cell', async () => {
    const data = card({
      emails: ['jane.doe@acme.com', 'j.doe@example.org'],
      transcript: card().transcript.concat('j.doe@example.org'),
    });
    const resolveDomain: ResolveDomain = async (domain) => (domain === 'example.org' ? 'missing' : 'exists');
    const decision = await decide(threeReads(data), { resolveDomain });
    expect(failed(decision, 'real_domain', 'email')[0]?.detail).toContain('example.org');
  });

  it('skips the lookup for a blank field', async () => {
    const resolveDomain = vi.fn<ResolveDomain>(async () => 'exists');
    await decide(threeReads(card({ emails: [], websites: [] })), { resolveDomain });
    expect(resolveDomain).not.toHaveBeenCalled();
  });
});

describe('near_miss', () => {
  it('catches the same misread in all three reads', async () => {
    const data = card({
      emails: ['jane.doe@acrne.com'],
      transcript: card().transcript.concat('jane.doe@acrne.com'),
    });
    const decision = await decide(threeReads(data));
    expect(decision.status).toBe('needs_review');
    expect(decision.flaggedFields).toEqual(['email']);
    expect(failed(decision, 'near_miss', 'email')[0]?.detail).toContain('acrne');
  });

  it('passes an exact match', async () => {
    expect(failed(await decide(threeReads(card())), 'near_miss')).toEqual([]);
  });
});

describe('unsafe_start', () => {
  it.each(FIELD_KEYS)('fails %s starting with = or @', async (field) => {
    for (const value of ['=SUM(1)', '@acme']) {
      const patch: Partial<CardReadData> =
        field === 'email'
          ? { emails: [value] }
          : field === 'phone'
            ? { phones: [{ number: value, label: '' }] }
            : field === 'website'
              ? { websites: [value] }
              : { [field]: value };
      const data = card({ ...patch, transcript: card().transcript.concat(value) });
      const decision = await decide(threeReads(data));
      expect(failed(decision, 'unsafe_start', field)[0]?.detail).toContain('formula');
      expect(decision.status).toBe('needs_review');
      expect(decision.flaggedFields).toContain(field);
    }
  });

  it('catches an unsafe value later in a multi-value cell', async () => {
    const data = card({
      websites: ['www.acme.com', '=evil.com'],
      transcript: card().transcript.concat('=evil.com'),
    });
    expect(failed(await decide(threeReads(data)), 'unsafe_start', 'website')).toHaveLength(1);
  });

  it('catches a fullwidth equals sign', async () => {
    const data = card({ company: '＝SUM(1)', transcript: card().transcript.concat('＝SUM(1)') });
    expect(failed(await decide(threeReads(data)), 'unsafe_start', 'company')).toHaveLength(1);
  });

  it('does not treat a leading + as unsafe, because phones are protected at paste', async () => {
    expect(failed(await decide(threeReads(card())), 'unsafe_start')).toEqual([]);
  });
});

describe('unreadable', () => {
  it('flags a field any read marked unreadable', async () => {
    const reads = [goodRead('A', card()), goodRead('B', card()), goodRead('C', card({ unreadable: ['phone'] }))];
    const decision = await decide(reads);
    expect(decision.status).toBe('needs_review');
    expect(decision.flaggedFields).toEqual(['phone']);
    expect(failed(decision, 'unreadable', 'phone')).toHaveLength(1);
  });
});

describe('unreadable on a blank field', () => {
  it('fails when all three reads agree on blank but one flagged it', async () => {
    const reads = [
      goodRead('A', card({ websites: [], unreadable: ['website'] })),
      goodRead('B', card({ websites: [] })),
      goodRead('C', card({ websites: [] })),
    ];
    const decision = await decide(reads);
    expect(decision.consensus.website).toMatchObject({ agreement: 'unanimous', chosen: '' });
    expect(decision.status).toBe('needs_review');
    expect(decision.flaggedFields).toEqual(['website']);
    expect(failed(decision, 'unreadable', 'website')).toHaveLength(1);
  });

  it('fails from the reads themselves even if the consensus missed the flag', async () => {
    const reads = threeReads(card({ position: '', unreadable: ['position'] }));
    const consensus = compare(reads);
    consensus.position.unreadable = false;
    const { decide: run } = createDecisionService({ resolveDomain: allExist });
    const decision = await run({ reads, consensus, quality: goodQuality, defaultCountry: null });
    expect(decision.status).toBe('needs_review');
    expect(decision.flaggedFields).toEqual(['position']);
  });
});

describe('quality', () => {
  const poor = (issues: QualityIssue[]): QualityReport => ({ ...goodQuality, ok: false, issues });

  it('sends a poor image to review and flags every field', async () => {
    const decision = await decide(threeReads(card()), { quality: poor(['blurry']) });
    expect(decision.status).toBe('needs_review');
    expect(failed(decision, 'quality', null)[0]?.detail).toBe('This card looks blurry.');
    expect(decision.flaggedFields).toEqual([...FIELD_KEYS]);
  });

  it('explains a card the app could not locate reliably', async () => {
    const decision = await decide(threeReads(card()), { quality: poor(['location_uncertain']) });
    expect(decision.status).toBe('needs_review');
    expect(failed(decision, 'quality', null)[0]?.detail).toBe(
      "The app couldn't locate this card reliably, so check it against the photo.",
    );
  });

  it.each(['low_resolution', 'blurry', 'too_dark', 'too_bright', 'location_uncertain'] as const)(
    'has plain wording for %s',
    async (issue) => {
      const decision = await decide(threeReads(card()), { quality: poor([issue]) });
      const detail = failed(decision, 'quality', null)[0]?.detail ?? '';
      expect(detail.length).toBeGreaterThan(10);
      expect(detail).not.toContain('_');
    },
  );

  it('joins several issues', async () => {
    const decision = await decide(threeReads(card()), { quality: poor(['blurry', 'too_dark']) });
    expect(failed(decision, 'quality', null)[0]?.detail).toBe('This card looks blurry. This card looks too dark.');
  });

  it('still explains a poor report with no listed issues', async () => {
    const decision = await decide(threeReads(card()), { quality: poor([]) });
    expect(failed(decision, 'quality', null)[0]?.detail).toContain('too poor');
  });

  it('only fails on an explicit false', async () => {
    const decision = await decide(threeReads(card()), { quality: null });
    expect(failed(decision, 'quality')).toEqual([]);
    expect(decision.status).toBe('verified');
  });
});

describe('missing_name', () => {
  it('sends a card with no name to review', async () => {
    const decision = await decide(threeReads(card({ name: '' })));
    expect(decision.status).toBe('needs_review');
    expect(decision.flaggedFields).toEqual(['name']);
    expect(failed(decision, 'missing_name', 'name')[0]?.detail).toContain('No name was found');
  });

  it('says so when the reads disagree on the name', async () => {
    const names = ['Jane Doe', 'June Doe', 'Jade Doe'];
    const reads = READ_VARIANTS.map((variant, index) =>
      goodRead(variant, card({ name: names[index] ?? '', transcript: card().transcript.concat(names) })),
    );
    expect(failed(await decide(reads), 'missing_name', 'name')[0]?.detail).toContain('disagree');
  });
});

describe('invariants', () => {
  it('a needs_review card always tells the reviewer what to look at', async () => {
    const scenarios = [
      decide(threeReads(card({ name: '' }))),
      decide(threeReads(card()), { resolveDomain: async () => 'unknown' }),
      decide(threeReads(card()), { quality: { ...goodQuality, ok: false, issues: ['blurry'] } }),
      decide([goodRead('A', card()), failedRead('B'), failedRead('C')]),
      decide(READ_VARIANTS.map(failedRead)),
    ];
    for (const decision of await Promise.all(scenarios)) {
      expect(decision.status).toBe('needs_review');
      expect(decision.flaggedFields.length).toBeGreaterThan(0);
      for (const check of decision.checks.filter((item) => !item.passed && item.field)) {
        expect(decision.flaggedFields).toContain(check.field);
      }
    }
  });

  it('verified never coexists with a failed check', async () => {
    const decision = await decide(threeReads(card({ name: '' })));
    expect(decision.status === 'verified' && decision.checks.some((item) => !item.passed)).toBe(false);
  });
});
