import { describe, expect, it, vi } from 'vitest';
import { createDomainResolver, type DnsClient } from './domains.ts';
import { cellValues, emailDomain, phoneProblem, websiteHost } from './format.ts';
import { editDistance, findNearMiss } from './nearMiss.ts';

describe('cellValues', () => {
  it('splits only multi-value columns', () => {
    expect(cellValues('phone', 'a; b')).toEqual(['a', 'b']);
    expect(cellValues('email', 'a; b')).toEqual(['a', 'b']);
    expect(cellValues('website', 'a; b')).toEqual(['a', 'b']);
    expect(cellValues('company', 'a; b')).toEqual(['a; b']);
  });
});

describe('emailDomain', () => {
  it.each([
    ['jane@acme.com', 'acme.com'],
    ['Jane.Doe@ACME.com', 'acme.com'],
    ['jane+cards@acme.co.uk', 'acme.co.uk'],
    ["o'neil@acme.com", 'acme.com'],
    ['jane@sub.acme.io', 'sub.acme.io'],
    ['jane@müller.de', 'xn--mller-kva.de'],
    ['रमेश@acme.com', 'acme.com'],
  ])('accepts %s', (email, domain) => {
    expect(emailDomain(email)).toBe(domain);
  });

  it.each([
    '',
    'jane',
    'jane@',
    '@acme.com',
    'jane@acme',
    'jane@@acme.com',
    'jane@acme@acme.com',
    'jane doe@acme.com',
    'jane@acme .com',
    '.jane@acme.com',
    'jane.@acme.com',
    'ja..ne@acme.com',
    'jane@acme..com',
    'jane@-acme.com',
    'jane@acme.c',
    'jane@acme.123',
    'a@b.com;c@d.com',
    `${'x'.repeat(65)}@acme.com`,
    '=SUM(1)',
  ])('rejects %j', (email) => {
    expect(emailDomain(email)).toBeNull();
  });
});

describe('websiteHost', () => {
  it.each([
    ['acme.com', 'acme.com'],
    ['www.acme.com', 'www.acme.com'],
    ['WWW.ACME.COM', 'www.acme.com'],
    ['https://acme.com', 'acme.com'],
    ['http://www.acme.co.uk/about', 'www.acme.co.uk'],
    ['HTTPS://acme.com/a?b=c#d', 'acme.com'],
    ['acme.com/contact', 'acme.com'],
    ['acme.com:8080', 'acme.com'],
    ['müller.de', 'xn--mller-kva.de'],
  ])('accepts %s', (website, host) => {
    expect(websiteHost(website)).toBe(host);
  });

  it.each([
    '',
    'acme',
    'www.acme.c',
    'acme .com',
    'ftp://acme.com',
    'javascript:alert(1)',
    'mailto:jane@acme.com',
    'jane@acme.com',
    'https://user:pass@acme.com',
    'http://',
    '192.168.0.1',
    '-acme.com',
    '=SUM(1)',
  ])('rejects %j', (website) => {
    expect(websiteHost(website)).toBeNull();
  });
});

describe('phoneProblem', () => {
  it.each([
    ['+91 98765 43210', null],
    ['+919876543210', null],
    ['+1 213 373 4253', null],
    ['+44 (0)20 7946 0958', null],
    ['+91-98765-43210 x204', null],
    ['+1 (213) 373-4253 ext. 89', null],
    ['(213) 373-4253', 'US'],
    ['98765 43210', 'IN'],
    ['0412345678', 'AU'],
  ])('confirms %s', (number, country) => {
    expect(phoneProblem(number, country)).toBeNull();
  });

  it.each([
    ['+1-555-123-4567', null],
    ['10-12-2024', 'US'],
    ['1-800-FLOWERS', 'US'],
    ['+91 98765', null],
    ['12345678901234567890', 'US'],
    ['Tel: +91 98765 43210', null],
    ['+91 98765 43210 / 11', null],
    ['', 'US'],
  ])('cannot confirm %j', (number, country) => {
    expect(phoneProblem(number, country)).toEqual(expect.any(String));
  });

  it('explains a number with no country code on a job with no default country', () => {
    expect(phoneProblem('(213) 373-4253', null)).toContain('no default country');
  });
});

describe('editDistance', () => {
  it.each([
    ['', '', 0],
    ['abc', '', 3],
    ['acme', 'acme', 0],
    ['acme', 'acrne', 2],
    ['kitten', 'sitting', 3],
  ])('%s to %s is %i', (a, b, distance) => {
    expect(editDistance(a, b)).toBe(distance);
    expect(editDistance(b, a)).toBe(distance);
  });
});

describe('findNearMiss', () => {
  const context = { name: 'Jane Doe', company: 'Acme Corp', websiteHosts: ['www.acme.com'] };

  it.each([
    ['jane', 'acrne.com', 'the rn/m misread between email and website domains', 'website'],
    ['jane', 'acne.com', 'one wrong letter in the email domain', 'website'],
    ['jane', 'acme.co', 'a shortened ending', 'website'],
    ['jane.dae', 'acme.com', 'a misread surname', 'name'],
    ['jnae.doe', 'acme.com', 'a misread name', 'name'],
    ['janedae', 'acme.com', 'a misread joined name', 'name'],
    ['jdoo', 'acme.com', 'a misread initial and surname', 'name'],
    ['jane', 'acrne-corp.com', 'a company in the domain with a misread', undefined],
  ])('flags %s@%s (%s)', (local, domain, _, source) => {
    const miss = findNearMiss(local, domain, context);
    expect(miss).not.toBeNull();
    if (source) expect(miss?.source).toBe(source);
  });

  it('flags a local part close to the company', () => {
    expect(findNearMiss('acmee', 'gmail.com', { name: '', company: 'Acme', websiteHosts: [] })?.source).toBe('company');
  });

  it('compares the email domain with the company when there is no website', () => {
    const miss = findNearMiss('jane', 'acrne.com', { name: 'Jane Doe', company: 'Acme Corp', websiteHosts: [] });
    expect(miss).toMatchObject({ found: 'acrne', similarTo: 'acme', source: 'company' });
  });

  it.each([
    ['jane.doe', 'acme.com'],
    ['janedoe', 'acme.com'],
    ['jane_doe', 'acme.com'],
    ['jane-doe', 'acme.com'],
    ['doe.jane', 'acme.com'],
    ['jdoe', 'acme.com'],
    ['janed', 'acme.com'],
    ['jane', 'acme.com'],
    ['doe', 'acme.com'],
    ['j.doe', 'acme.com'],
    ['JANE.DOE', 'ACME.COM'],
    ['info', 'acme.com'],
    ['sales', 'acme.com'],
  ])('accepts the exact match %s@%s', (local, domain) => {
    expect(findNearMiss(local, domain, context)).toBeNull();
  });

  it.each([
    ['bob', 'gmail.com'],
    ['kevin.smith', 'outlook.com'],
    ['ceo', 'contoso.com'],
    ['jd', 'acme.com'],
    ['frontdesk', 'hotel.com'],
  ])('accepts the unrelated value %s@%s', (local, domain) => {
    expect(findNearMiss(local, domain, context)).toBeNull();
  });

  it('does not call two short unrelated words a near miss', () => {
    expect(findNearMiss('dave', 'acme.com', context)).toBeNull();
    expect(findNearMiss('jo', 'xy.com', { name: 'Al Ng', company: '', websiteHosts: ['ab.com'] })).toBeNull();
  });

  it('copes with a titled name, a middle initial and accents', () => {
    const titled = { name: 'Dr. Jane Q. Doe, PhD', company: '', websiteHosts: [] };
    expect(findNearMiss('jane.doe', 'acme.com', titled)).toBeNull();
    expect(findNearMiss('jqdoe', 'acme.com', { ...titled, name: 'Jane Quincy Doe' })).toBeNull();
    expect(findNearMiss('jose.nunez', 'acme.com', { name: 'José Núñez', company: '', websiteHosts: [] })).toBeNull();
  });

  it('allows an identical domain with a subdomain or a different country ending', () => {
    expect(findNearMiss('jane', 'mail.acme.com', context)).toBeNull();
    expect(findNearMiss('jane', 'acme.co.uk', { ...context, websiteHosts: ['acme.com'] })).toBeNull();
  });

  it('has nothing to compare against for a non-Latin name', () => {
    expect(findNearMiss('taro', 'gmail.com', { name: '山田太郎', company: '', websiteHosts: [] })).toBeNull();
  });
});

describe('createDomainResolver', () => {
  const notFound = () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
  const noData = () => Promise.reject(Object.assign(new Error('nope'), { code: 'ENODATA' }));
  const serverFail = () => Promise.reject(Object.assign(new Error('nope'), { code: 'ESERVFAIL' }));
  const found = () => Promise.resolve(['record']);

  function fakeDns(overrides: Partial<Record<keyof DnsClient, () => Promise<unknown[]>>>) {
    return {
      resolveMx: vi.fn(overrides.resolveMx ?? notFound),
      resolve4: vi.fn(overrides.resolve4 ?? notFound),
      resolve6: vi.fn(overrides.resolve6 ?? notFound),
    };
  }

  it('finds an email domain by MX without asking for addresses', async () => {
    const dns = fakeDns({ resolveMx: found });
    expect(await createDomainResolver(dns)('acme.com', 'email')).toBe('exists');
    expect(dns.resolve4).not.toHaveBeenCalled();
  });

  it('falls back from MX to A, then AAAA, for email', async () => {
    const a = fakeDns({ resolve4: found });
    expect(await createDomainResolver(a)('acme.com', 'email')).toBe('exists');
    const aaaa = fakeDns({ resolve6: found });
    expect(await createDomainResolver(aaaa)('acme.com', 'email')).toBe('exists');
    expect(aaaa.resolveMx).toHaveBeenCalledTimes(1);
    expect(aaaa.resolve4).toHaveBeenCalledTimes(1);
  });

  it('never asks for MX records for a website', async () => {
    const dns = fakeDns({ resolve6: found });
    expect(await createDomainResolver(dns)('acme.com', 'website')).toBe('exists');
    expect(dns.resolveMx).not.toHaveBeenCalled();
  });

  it('reports missing only when DNS positively has nothing', async () => {
    expect(await createDomainResolver(fakeDns({}))('acrne.com', 'email')).toBe('missing');
    expect(
      await createDomainResolver(fakeDns({ resolve4: noData, resolve6: noData }))('acrne.com', 'website'),
    ).toBe('missing');
  });

  it('reports unknown when any lookup errors and none succeeds, after one retry', async () => {
    const dns = fakeDns({ resolve4: serverFail, resolve6: serverFail });
    expect(await createDomainResolver(dns)('acme.com', 'website')).toBe('unknown');
    expect(dns.resolve4).toHaveBeenCalledTimes(2);
  });

  it('recovers when the retry succeeds', async () => {
    const dns = fakeDns({});
    dns.resolve4.mockImplementationOnce(serverFail).mockImplementationOnce(found);
    expect(await createDomainResolver(dns)('acme.com', 'website')).toBe('exists');
  });

  it('times out a lookup that never answers', async () => {
    const dns = fakeDns({ resolve4: () => new Promise(() => {}), resolve6: () => new Promise(() => {}) });
    expect(await createDomainResolver(dns, 5)('acme.com', 'website')).toBe('unknown');
    expect(dns.resolve4).toHaveBeenCalledTimes(2);
  });

  it('caches an answer per domain, ignoring case', async () => {
    const dns = fakeDns({ resolve4: found });
    const resolve = createDomainResolver(dns);
    await resolve('acme.com', 'website');
    await resolve('ACME.com', 'website');
    await resolve('other.com', 'website');
    expect(dns.resolve4).toHaveBeenCalledTimes(2);
  });

  it('shares one lookup between concurrent cards', async () => {
    const dns = fakeDns({ resolve4: found });
    const resolve = createDomainResolver(dns);
    await Promise.all([resolve('acme.com', 'website'), resolve('acme.com', 'website')]);
    expect(dns.resolve4).toHaveBeenCalledTimes(1);
  });

  it('keeps email and website answers separate', async () => {
    const dns = fakeDns({ resolveMx: found, resolve4: notFound, resolve6: notFound });
    const resolve = createDomainResolver(dns);
    expect(await resolve('acme.com', 'email')).toBe('exists');
    expect(await resolve('acme.com', 'website')).toBe('missing');
  });

  it('does not cache unknown, so the next card asks again', async () => {
    const dns = fakeDns({ resolve4: serverFail, resolve6: serverFail });
    const resolve = createDomainResolver(dns);
    expect(await resolve('acme.com', 'website')).toBe('unknown');
    await Promise.resolve();
    dns.resolve4.mockImplementation(found);
    expect(await resolve('acme.com', 'website')).toBe('exists');
  });
});
