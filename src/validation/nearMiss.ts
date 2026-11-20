/**
 * Catches the misread that every read shares, such as `rn` for `m`: an email
 * almost matches the name, company or website on the same card, but not quite.
 * An exact match or a clearly unrelated value is fine.
 */
import { normalizeText } from '../shared/text.ts';

export type NearMissSource = 'name' | 'company' | 'website';

export interface NearMiss {
  /** The part of the email that looks misread. */
  found: string;
  /** What it almost matches. */
  similarTo: string;
  source: NearMissSource;
}

/** Above this share of changed characters, two strings are unrelated rather than misread. */
const MAX_CHANGED_SHARE = 0.4;
const MAX_EDIT_DISTANCE = 2;
/** Forms built from an initial match too much at distance 2: `dave` is not `djane`. */
const MAX_INITIAL_FORM_DISTANCE = 1;

/** Shared mailboxes are never built from a person's name. */
const ROLE_MAILBOXES = new Set([
  'admin',
  'contact',
  'enquiries',
  'enquiry',
  'hello',
  'help',
  'hr',
  'info',
  'inquiries',
  'mail',
  'marketing',
  'office',
  'sales',
  'service',
  'services',
  'support',
  'team',
]);

/** The com in acme.com.au says nothing about the company. */
const GENERIC_LABELS = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org', 'www']);

export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function isNear(a: string, b: string, maxDistance: number = MAX_EDIT_DISTANCE): boolean {
  if (a === b) return false;
  const distance = editDistance(a, b);
  return distance <= maxDistance && distance / Math.max(a.length, b.length) <= MAX_CHANGED_SHARE;
}

/** Lower case with accents removed, so `Müller` can be compared with `muller`. */
const fold = (text: string): string => normalizeText(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

const wordsOf = (text: string): string[] => fold(text).split(/[^a-z0-9]+/).filter((word) => word.length >= 2);

/** Names as they usually appear in addresses: jane, doe, janedoe, doejane, and jdoe, janed. */
function nameForms(name: string): { full: string[]; initial: string[] } {
  const words = wordsOf(name);
  const full = new Set(words);
  const initial = new Set<string>();
  for (const first of words) {
    for (const last of words) {
      if (first === last) continue;
      full.add(first + last);
      initial.add(first.charAt(0) + last);
      initial.add(first + last.charAt(0));
    }
  }
  const lastWord = words.at(-1);
  if (lastWord) {
    full.add(words.join(''));
    initial.add(words.slice(0, -1).map((word) => word.charAt(0)).join('') + lastWord);
  }
  return { full: [...full], initial: [...initial] };
}

function companyForms(company: string): string[] {
  const words = wordsOf(company);
  return words.length > 0 ? [...new Set([...words, words.join('')])] : [];
}

/** The labels of a domain worth comparing: `acme` from both www.acme.com and acme.co.uk. */
function domainLabels(domain: string): string[] {
  return fold(domain)
    .split('.')
    .slice(0, -1)
    .filter((label) => label.length >= 3 && !GENERIC_LABELS.has(label));
}

/** Drops whole trailing labels the two hosts share, so `.com` can't dilute a real difference. */
function withoutSharedSuffix(a: string, b: string): [string, string] {
  const aLabels = a.split('.');
  const bLabels = b.split('.');
  while (aLabels.length > 0 && aLabels.at(-1) === bLabels.at(-1)) {
    aLabels.pop();
    bLabels.pop();
  }
  return [aLabels.join('.'), bLabels.join('.')];
}

interface KnownForm {
  source: NearMissSource;
  maxDistance: number;
}

function findNear(subject: string, known: Map<string, KnownForm>): NearMiss | null {
  const pieces = subject.split(/[._+-]+/).filter(Boolean);
  const whole = pieces.join('');
  if (known.has(whole)) return null;
  for (const piece of new Set([whole, ...pieces])) {
    if (known.has(piece)) continue;
    for (const [form, { source, maxDistance }] of known) {
      if (isNear(piece, form, maxDistance)) return { found: piece, similarTo: form, source };
    }
  }
  return null;
}

export interface NearMissContext {
  name: string;
  company: string;
  /** ASCII website hosts on this card. */
  websiteHosts: string[];
}

/** Checks one valid email. email is local@domain, with domain in ASCII. */
export function findNearMiss(local: string, domain: string, context: NearMissContext): NearMiss | null {
  const hosts = context.websiteHosts.map((host) => host.toLowerCase().replace(/^www\./, ''));
  const emailHost = domain.toLowerCase();
  for (const host of hosts) {
    const [emailPart, websitePart] = withoutSharedSuffix(emailHost, host);
    if (isNear(emailPart, websitePart)) return { found: emailHost, similarTo: host, source: 'website' };
  }

  const known = new Map<string, KnownForm>();
  const remember = (forms: string[], source: NearMissSource, maxDistance: number = MAX_EDIT_DISTANCE) => {
    for (const form of forms) if (!known.has(form)) known.set(form, { source, maxDistance });
  };
  const { full, initial } = nameForms(context.name);
  remember(full, 'name');
  remember(initial, 'name', MAX_INITIAL_FORM_DISTANCE);
  remember(companyForms(context.company), 'company');
  remember(hosts.flatMap(domainLabels), 'website');

  const foldedLocal = fold(local);
  const subjects = [...(ROLE_MAILBOXES.has(foldedLocal) ? [] : [foldedLocal]), ...domainLabels(emailHost)];
  for (const subject of subjects) {
    const match = findNear(subject, known);
    if (match) return match;
  }
  return null;
}
