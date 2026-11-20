/**
 * Finds cards that share contact details. Across files that means the same
 * person. Within one file it can also mean a card read its neighbour's email,
 * so that case goes to a person. Each search is one pass with a hash map, so
 * 1,000+ cards from a few sheets cost the same per card as 10.
 */
import {
  FIELD_KEYS,
  MULTI_VALUE_SEPARATOR,
  type CardDecision,
  type CardRow,
  type CheckResult,
} from '../shared/contracts.ts';
import { normalizeText } from '../shared/text.ts';
import { parsePhone } from '../validation/format.ts';

export interface DuplicateCandidate {
  cardId: string;
  /** null for a card with no values yet, or one a person rejected. */
  row: CardRow | null;
  sourceFileIds: string[];
}

/** Fewer digits than this can't identify anyone, for example a bare extension. */
const MIN_PHONE_DIGITS = 7;

function phoneKey(phone: string, defaultCountry: string | null): string | null {
  const parsed = parsePhone(phone, defaultCountry);
  if (parsed) return parsed.ext ? `${parsed.number}x${parsed.ext}` : parsed.number;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= MIN_PHONE_DIGITS ? digits : null;
}

/** Each address in the cell on its own, ignoring case. */
function emailKeys(row: CardRow): Set<string> {
  const keys = row.email.split(MULTI_VALUE_SEPARATOR).map((email) => normalizeText(email).toLowerCase());
  return new Set(keys.filter(Boolean));
}

function contactKeys(row: CardRow, defaultCountry: string | null): Set<string> {
  const keys = new Set<string>();
  for (const email of emailKeys(row)) keys.add(`email:${email}`);
  for (const phone of row.phone.split(MULTI_VALUE_SEPARATOR)) {
    const key = phoneKey(phone, defaultCountry);
    if (key) keys.add(`phone:${key}`);
  }
  return keys;
}

/**
 * Takes cards in upload order. Each later card points at the earliest card it
 * shares a contact with. The first card of a group points at nothing.
 */
export function findPossibleDuplicates(
  cards: Array<Pick<DuplicateCandidate, 'cardId' | 'row'>>,
  defaultCountry: string | null,
): Map<string, string | null> {
  const firstSeen = new Map<string, number>();
  const links = new Map<string, string | null>();

  cards.forEach(({ cardId, row }, position) => {
    const keys = row ? contactKeys(row, defaultCountry) : new Set<string>();
    let earliest = Number.POSITIVE_INFINITY;
    for (const key of keys) earliest = Math.min(earliest, firstSeen.get(key) ?? Number.POSITIVE_INFINITY);
    for (const key of keys) if (!firstSeen.has(key)) firstSeen.set(key, position);
    links.set(cardId, cards[earliest]?.cardId ?? null);
  });

  return links;
}

/** The cards that share an email with another card from the same source file. */
export function findSharedOnSheet(cards: DuplicateCandidate[]): Set<string> {
  const firstCardWith = new Map<string, string>();
  const shared = new Set<string>();

  for (const { cardId, row, sourceFileIds } of cards) {
    if (!row) continue;
    for (const email of emailKeys(row)) {
      for (const fileId of sourceFileIds) {
        const key = `${fileId} ${email}`;
        const first = firstCardWith.get(key);
        if (first === undefined) {
          firstCardWith.set(key, cardId);
        } else if (first !== cardId) {
          shared.add(first);
          shared.add(cardId);
        }
      }
    }
  }
  return shared;
}

const SHARED_ON_SHEET_CHECK: CheckResult = {
  check: 'shared_on_sheet',
  field: 'email',
  passed: false,
  detail:
    "This email also appears on another card in the same photo, so one card may have picked up its neighbour's text. Check it against the image.",
};

/** The decision for a verified card going to review. The row stays here for the reviewer. */
export function sendToReview(decision: CardDecision, row: CardRow): CardDecision {
  const alreadyChecked = decision.checks.some((check) => check.check === SHARED_ON_SHEET_CHECK.check);
  return {
    ...decision,
    status: 'needs_review',
    row,
    checks: alreadyChecked ? decision.checks : [...decision.checks, SHARED_ON_SHEET_CHECK],
    flaggedFields: FIELD_KEYS.filter((field) => field === 'email' || decision.flaggedFields.includes(field)),
  };
}
