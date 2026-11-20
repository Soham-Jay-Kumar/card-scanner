/** Real DNS lookups for the real_domain check. Tests inject resolveDomain and never reach this. */
import { Resolver } from 'node:dns/promises';

export type DomainStatus = 'exists' | 'missing' | 'unknown';
export type ResolveDomain = (domain: string, kind: 'email' | 'website') => Promise<DomainStatus>;

/** The parts of node's Resolver that are used here, so tests can fake DNS. */
export interface DnsClient {
  resolveMx(domain: string): Promise<unknown[]>;
  resolve4(domain: string): Promise<unknown[]>;
  resolve6(domain: string): Promise<unknown[]>;
}

const DNS_TIMEOUT_MS = 4_000;
/** DNS answering "no such name" or "no such record". Anything else says nothing about the domain. */
const NOT_FOUND_CODES = new Set(['ENOTFOUND', 'ENODATA']);

type Answer = 'found' | 'none' | 'error';

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS lookup timed out')), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createDomainResolver(
  dns: DnsClient = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 }),
  timeoutMs: number = DNS_TIMEOUT_MS,
): ResolveDomain {
  const cache = new Map<string, Promise<DomainStatus>>();

  async function ask(query: () => Promise<unknown[]>): Promise<Answer> {
    try {
      return (await withTimeout(query(), timeoutMs)).length > 0 ? 'found' : 'none';
    } catch (error) {
      return NOT_FOUND_CODES.has((error as NodeJS.ErrnoException).code ?? '') ? 'none' : 'error';
    }
  }

  async function lookUp(domain: string, kind: 'email' | 'website'): Promise<DomainStatus> {
    const addressQueries = [() => dns.resolve4(domain), () => dns.resolve6(domain)];
    const queries = kind === 'email' ? [() => dns.resolveMx(domain), ...addressQueries] : addressQueries;
    let anyError = false;
    for (const query of queries) {
      const answer = await ask(query);
      if (answer === 'found') return 'exists';
      if (answer === 'error') anyError = true;
    }
    return anyError ? 'unknown' : 'missing';
  }

  async function lookUpWithRetry(domain: string, kind: 'email' | 'website'): Promise<DomainStatus> {
    const first = await lookUp(domain, kind);
    return first === 'unknown' ? lookUp(domain, kind) : first;
  }

  return (domain, kind) => {
    const key = `${kind}:${domain.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const result = lookUpWithRetry(domain, kind);
    cache.set(key, result);
    // A network blip is not an answer about the domain, so the next card asks again.
    void result.then((status) => {
      if (status === 'unknown') cache.delete(key);
    });
    return result;
  };
}
