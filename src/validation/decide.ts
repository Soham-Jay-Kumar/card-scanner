/**
 * Stages 7 and 8. A card is verified only when all three reads succeeded, every
 * field is unanimous and every check passed. This is strict on purpose: no value
 * may reach the spreadsheet on one unchecked reading, so anything less goes to a
 * person with the majority values pre-selected.
 */
import {
  COLUMN_HEADERS,
  FIELD_KEYS,
  READ_VARIANTS,
  type CardDecision,
  type CardRow,
  type CheckName,
  type CheckResult,
  type DecisionService,
  type FieldConsensus,
  type FieldConsensusMap,
  type FieldKey,
  type QualityIssue,
  type QualityReport,
  type ReadRecord,
  type ReadVariant,
} from '../shared/contracts.ts';
import { normalizeText } from '../shared/text.ts';
import type { ResolveDomain } from './domains.ts';
import { cellValues, emailDomain, phoneProblem, websiteHost } from './format.ts';
import { findNearMiss, type NearMiss } from './nearMiss.ts';

const result = (check: CheckName, field: FieldKey | null, passed: boolean, detail: string): CheckResult => ({
  check,
  field,
  passed,
  detail,
});

function readsCheck(goodReads: number): CheckResult {
  const total = READ_VARIANTS.length;
  const passed = goodReads === total;
  const detail = passed
    ? 'All three reads of this card succeeded.'
    : `Only ${goodReads} of ${total} reads of this card succeeded, so its values could not be fully cross-checked.`;
  return result('agreement', null, passed, detail);
}

function describeReading(variant: ReadVariant, value: string | null): string {
  if (value === null) return `read ${variant} failed`;
  return value === '' ? `read ${variant} found nothing` : `read ${variant} found "${value}"`;
}

function agreementCheck(consensus: FieldConsensus): CheckResult {
  const label = COLUMN_HEADERS[consensus.field];
  const passed = consensus.agreement === 'unanimous';
  const readings = READ_VARIANTS.map((variant) => describeReading(variant, consensus.values[variant])).join(', ');
  const lead = consensus.agreement === 'majority' ? 'Two of the three reads agree' : 'The reads disagree';
  const detail = passed ? `${label}: all three reads agree.` : `${label}: ${lead}: ${readings}.`;
  return result('agreement', consensus.field, passed, detail);
}

/** The value must be printed on the card, or the model invented or "corrected" it. */
function verbatimCheck(consensus: FieldConsensus, reads: ReadRecord[]): CheckResult {
  const { field } = consensus;
  const label = COLUMN_HEADERS[field];
  const problems: string[] = [];

  for (const variant of READ_VARIANTS) {
    const cell = consensus.values[variant];
    if (!cell) continue;
    const outcome = reads.find((read) => read.variant === variant)?.outcome;
    const transcript = outcome?.ok ? normalizeText(outcome.data.transcript.join(' ')) : '';
    for (const value of cellValues(field, cell)) {
      if (!transcript.includes(normalizeText(value))) problems.push(`"${value}" (read ${variant})`);
    }
  }

  if (problems.length > 0) {
    const detail = `${label}: ${problems.join(', ')} is not in the text that read saw on the card, so it may be invented or corrected.`;
    return result('verbatim', field, false, detail);
  }
  return result('verbatim', field, true, `${label}: the value matches the text read from the card.`);
}

function formatCheck(field: FieldKey, cell: string, defaultCountry: string | null): CheckResult | null {
  if (cell === '') return null;
  const label = COLUMN_HEADERS[field];
  const values = cellValues(field, cell);
  let problems: string[];

  if (field === 'email') {
    problems = values.filter((value) => !emailDomain(value)).map((value) => `"${value}" isn't a valid email address.`);
  } else if (field === 'phone') {
    problems = values.flatMap((value) => phoneProblem(value, defaultCountry) ?? []);
  } else if (field === 'website') {
    problems = values.filter((value) => !websiteHost(value)).map((value) => `"${value}" isn't a valid web address.`);
  } else {
    return null;
  }

  if (problems.length > 0) return result('format', field, false, `${label}: ${problems.join(' ')}`);
  return result('format', field, true, `${label}: the format is valid.`);
}

async function realDomainCheck(
  field: 'email' | 'website',
  cell: string,
  resolveDomain: ResolveDomain,
): Promise<CheckResult | null> {
  if (cell === '') return null;
  const label = COLUMN_HEADERS[field];
  const domainOf = field === 'email' ? emailDomain : websiteHost;

  const problems = await Promise.all(
    cellValues(field, cell).map(async (value) => {
      const domain = domainOf(value);
      if (!domain) return `No domain could be found in "${value}".`;
      const status = await resolveDomain(domain, field).catch(() => 'unknown' as const);
      if (status === 'exists') return null;
      return status === 'missing'
        ? `The domain "${domain}" doesn't exist, so it may be misread.`
        : `The domain "${domain}" couldn't be confirmed because the lookup got no answer.`;
    }),
  );

  const failed = problems.filter((problem) => problem !== null);
  if (failed.length > 0) return result('real_domain', field, false, `${label}: ${failed.join(' ')}`);
  return result('real_domain', field, true, `${label}: the domain exists.`);
}

function nearMissDetail(email: string, miss: NearMiss): string {
  const sourceName = { name: 'the name', company: 'the company', website: 'the website' }[miss.source];
  return `Email: "${miss.found}" in ${email} is very close to, but not the same as, "${miss.similarTo}" from ${sourceName}. One of them may be misread, for example "rn" for "m".`;
}

function nearMissCheck(row: CardRow): CheckResult | null {
  if (row.email === '') return null;
  const websiteHosts = row.website === '' ? [] : cellValues('website', row.website).flatMap((site) => websiteHost(site) ?? []);
  const context = { name: row.name, company: row.company, websiteHosts };

  for (const email of cellValues('email', row.email)) {
    const domain = emailDomain(email);
    if (!domain) continue;
    const miss = findNearMiss(email.slice(0, email.indexOf('@')), domain, context);
    if (miss) return result('near_miss', 'email', false, nearMissDetail(email, miss));
  }
  return result('near_miss', 'email', true, 'Email: nothing on this card almost matches it.');
}

function unsafeStartCheck(field: FieldKey, cell: string): CheckResult | null {
  if (cell === '') return null;
  const label = COLUMN_HEADERS[field];
  const unsafe = cellValues(field, cell).find((value) => /^[=@]/.test(normalizeText(value)));
  if (unsafe === undefined) return result('unsafe_start', field, true, `${label}: the value starts safely.`);
  const start = normalizeText(unsafe).charAt(0);
  return result('unsafe_start', field, false, `${label}: "${unsafe}" starts with "${start}", which a spreadsheet could treat as a formula.`);
}

/**
 * Any read flagging a field fails it, even when all three agree on blank:
 * extraction leaves unreadable values blank, and that must never pass as a
 * verified blank. The reads are checked as well as the consensus for that reason.
 */
function unreadableCheck(consensus: FieldConsensus, reads: ReadRecord[]): CheckResult {
  const label = COLUMN_HEADERS[consensus.field];
  const flaggedByRead = reads.some(
    ({ outcome }) => outcome.ok && outcome.data.unreadable.includes(consensus.field),
  );
  return consensus.unreadable || flaggedByRead
    ? result('unreadable', consensus.field, false, `${label}: something is printed here but could not be read with certainty.`)
    : result('unreadable', consensus.field, true, `${label}: no read marked this as unreadable.`);
}

const QUALITY_ISSUE_DETAILS: Record<QualityIssue, string> = {
  low_resolution: 'This card has too few pixels to read reliably.',
  blurry: 'This card looks blurry.',
  too_dark: 'This card looks too dark.',
  too_bright: 'This card looks too bright.',
  location_uncertain: "The app couldn't locate this card reliably, so check it against the photo.",
};

function qualityCheck(quality: QualityReport | null): CheckResult {
  if (quality === null) return result('quality', null, true, 'No image quality report was available for this card.');
  if (quality.ok) return result('quality', null, true, 'The image quality is good enough to read.');
  const details = quality.issues.map((issue) => QUALITY_ISSUE_DETAILS[issue]);
  return result('quality', null, false, details.join(' ') || 'The image quality is too poor to trust without a person checking.');
}

function missingNameCheck(consensus: FieldConsensus): CheckResult {
  if (normalizeText(consensus.chosen) !== '') return result('missing_name', 'name', true, 'A name was found.');
  const detail =
    consensus.agreement === 'split'
      ? 'The reads disagree on the name, so none could be chosen.'
      : 'No name was found on this card. A back side uploaded alone has no name.';
  return result('missing_name', 'name', false, detail);
}

function chosenRow(consensus: FieldConsensusMap): CardRow {
  return Object.fromEntries(FIELD_KEYS.map((field) => [field, consensus[field].chosen])) as CardRow;
}

/** Card-level problems affect every field, so the reviewer sees all six highlighted. */
function fieldsToFlag(checks: CheckResult[]): FieldKey[] {
  const failed = checks.filter((check) => !check.passed);
  if (failed.some((check) => check.field === null)) return [...FIELD_KEYS];
  return FIELD_KEYS.filter((field) => failed.some((check) => check.field === field));
}

export function createDecide(resolveDomain: ResolveDomain): DecisionService['decide'] {
  return async ({ reads, consensus, quality, defaultCountry }): Promise<CardDecision> => {
    const row = chosenRow(consensus);
    const goodReads = READ_VARIANTS.filter((variant) =>
      reads.some((read) => read.variant === variant && read.outcome.ok),
    ).length;

    const domainChecks = await Promise.all([
      realDomainCheck('email', row.email, resolveDomain),
      realDomainCheck('website', row.website, resolveDomain),
    ]);

    const checks = [
      readsCheck(goodReads),
      ...FIELD_KEYS.flatMap((field) => [
        agreementCheck(consensus[field]),
        verbatimCheck(consensus[field], reads),
        formatCheck(field, row[field], defaultCountry),
        unsafeStartCheck(field, row[field]),
        unreadableCheck(consensus[field], reads),
      ]),
      ...domainChecks,
      nearMissCheck(row),
      qualityCheck(quality),
      missingNameCheck(consensus.name),
    ].filter((check) => check !== null);

    const verified =
      goodReads === READ_VARIANTS.length &&
      FIELD_KEYS.every((field) => consensus[field].agreement === 'unanimous') &&
      checks.every((check) => check.passed);

    return {
      status: verified ? 'verified' : 'needs_review',
      row,
      consensus,
      checks,
      flaggedFields: verified ? [] : fieldsToFlag(checks),
    };
  };
}
