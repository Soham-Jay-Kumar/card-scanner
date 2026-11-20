/** Format rules for emails, phones and web addresses, plus how to pull a domain out of each. */
import { domainToASCII } from 'node:url';
import { parsePhoneNumberFromString, type CountryCode, type PhoneNumber } from 'libphonenumber-js/max';
import { MULTI_VALUE_SEPARATOR, type FieldKey } from '../shared/contracts.ts';

/** Email, phone and website cells can hold several values. Other cells are one value. */
export function cellValues(field: FieldKey, cell: string): string[] {
  const isMultiValue = field === 'email' || field === 'phone' || field === 'website';
  return isMultiValue ? cell.split(MULTI_VALUE_SEPARATOR) : [cell];
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const EMAIL_LOCAL_PART = /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u;
const MAX_EMAIL_LOCAL_PART = 64;

/** The address's ASCII domain, or null when it isn't valid email syntax. */
export function emailDomain(email: string): string | null {
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return null;
  const local = email.slice(0, at);
  if (local.length > MAX_EMAIL_LOCAL_PART || !EMAIL_LOCAL_PART.test(local)) return null;
  const domain = domainToASCII(email.slice(at + 1));
  return HOSTNAME.test(domain) ? domain : null;
}

/** The ASCII host of a web address, printed with or without a scheme, or null when invalid. */
export function websiteHost(website: string): string | null {
  if (/\s/.test(website)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(website);
  if (hasScheme && !/^https?:\/\//i.test(website)) return null;
  try {
    const url = new URL(hasScheme ? website : `https://${website}`);
    if (url.username || url.password) return null;
    return HOSTNAME.test(url.hostname) ? url.hostname : null;
  } catch {
    return null;
  }
}

/** Parses exactly this text as one number, using the job's country when none is printed. */
export function parsePhone(number: string, defaultCountry: string | null): PhoneNumber | undefined {
  const country = defaultCountry?.toUpperCase() as CountryCode | undefined;
  return parsePhoneNumberFromString(number, {
    extract: false,
    ...(country ? { defaultCountry: country } : {}),
  });
}

/** Why this phone can't be confirmed, or null when the library confirms it. */
export function phoneProblem(number: string, defaultCountry: string | null): string | null {
  const parsed = parsePhone(number, defaultCountry);
  if (parsed?.isValid()) return null;
  if (!number.trim().startsWith('+') && !defaultCountry) {
    return `"${number}" has no country code and this job has no default country, so it can't be confirmed.`;
  }
  return `"${number}" isn't a valid phone number${defaultCountry ? ` for ${defaultCountry.toUpperCase()}` : ''}.`;
}
