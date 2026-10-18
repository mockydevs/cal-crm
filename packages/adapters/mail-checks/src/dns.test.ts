import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  budgetedResolver,
  lookupAddresses,
  lookupMx,
  lookupPtr,
  lookupTxt,
  reverseName,
  sameAddress,
  sendingAddress,
} from './dns.js';
import { fixtureResolver } from './fixture-resolver.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('lookups', () => {
  it('read records, telling no records apart from a failure to look', async () => {
    const resolve = fixtureResolver({
      'example.test': {
        TXT: ['v=spf1 -all', ['v=spf1 ', 'include:a.test ~all']],
        MX: [{ exchange: 'MX.Example.Test.', priority: 10 }],
      },
      'down.test': { error: 'ESERVFAIL' },
    });

    expect(await lookupTxt(resolve, 'example.test')).toEqual({
      kind: 'found',
      records: ['v=spf1 -all', 'v=spf1 include:a.test ~all'],
    });
    expect(await lookupMx(resolve, 'Example.Test.')).toEqual({
      kind: 'found',
      records: [{ exchange: 'mx.example.test', priority: 10 }],
    });
    expect(await lookupAddresses(resolve, 'example.test', 'A')).toEqual({ kind: 'none' });
    expect(await lookupTxt(resolve, 'missing.test')).toEqual({ kind: 'none' });
    expect(await lookupTxt(resolve, 'down.test')).toEqual({ kind: 'error', code: 'ESERVFAIL' });
  });

  it('treat an answer of the wrong shape as a failure to look, never as records', async () => {
    const odd = () => Promise.resolve([{ unexpected: true }]);
    expect(await lookupTxt(odd, 'x.test')).toEqual({ kind: 'error', code: 'EBADRESP' });
    expect(await lookupMx(odd, 'x.test')).toEqual({ kind: 'error', code: 'EBADRESP' });
    expect(await lookupAddresses(odd, 'x.test', 'A')).toEqual({ kind: 'error', code: 'EBADRESP' });
    expect(await lookupTxt(() => Promise.resolve('v=spf1'), 'x.test')).toEqual({
      kind: 'error',
      code: 'EBADRESP',
    });
  });

  it('treat an empty answer as no records, and a rejection without a code as unknown', async () => {
    expect(await lookupTxt(() => Promise.resolve([]), 'x.test')).toEqual({ kind: 'none' });
    expect(await lookupTxt(() => Promise.reject(new Error('boom')), 'x.test')).toEqual({
      kind: 'error',
      code: 'EUNKNOWN',
    });
  });

  it('look up an address by its reverse name, as names in lower case', async () => {
    const resolve = fixtureResolver({ '10.2.0.192.in-addr.arpa': { PTR: ['Mail.Example.Test.'] } });
    expect(await lookupPtr(resolve, '192.0.2.10')).toEqual({
      kind: 'found',
      records: ['mail.example.test'],
    });
  });
});

describe('addresses', () => {
  it.each([
    ['192.0.2.10', '10.2.0.192.in-addr.arpa'],
    // RFC 3596 section 2.5's own example.
    [
      '4321:0:1:2:3:4:567:89ab',
      'b.a.9.8.7.6.5.0.4.0.0.0.3.0.0.0.2.0.0.0.1.0.0.0.0.0.0.0.1.2.3.4.ip6.arpa',
    ],
    ['2001:db8::1', '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa'],
  ])('give %s the reverse name %s', (ip, name) => {
    expect(reverseName(ip)).toBe(name);
  });

  it('read an IPv4-mapped IPv6 address as the IPv4 address it carries', () => {
    expect(sendingAddress('::ffff:192.0.2.10')).toEqual({ ip: '192.0.2.10', family: 4 });
    expect(sendingAddress('::FFFF:c000:020a')).toEqual({ ip: '192.0.2.10', family: 4 });
    expect(sendingAddress('2001:DB8::1')).toEqual({ ip: '2001:db8::1', family: 6 });
    expect(sendingAddress('not an address')).toBeUndefined();
  });

  it('compare IPv6 addresses by value, not spelling', () => {
    expect(sameAddress('2001:DB8:0::1', '2001:db8::0:1')).toBe(true);
    expect(sameAddress('2001:db8::1', '2001:db8::2')).toBe(false);
    expect(sameAddress('192.0.2.10', '192.0.2.10')).toBe(true);
    expect(sameAddress('192.0.2.10', '2001:db8::1')).toBe(false);
  });
});

describe('the DNS budget', () => {
  it('refuses queries past the query budget', async () => {
    const resolve = budgetedResolver(fixtureResolver({ 'a.test': { A: ['192.0.2.1'] } }), {
      maxQueries: 2,
      timeoutMs: 1000,
    });
    await resolve('a.test', 'A');
    await resolve('a.test', 'A');
    await expect(resolve('a.test', 'A')).rejects.toMatchObject({ code: 'EBUDGET' });
  });

  it("gives up once the deadline passes, so a slow server can't hang the worker", async () => {
    vi.useFakeTimers();
    const resolve = budgetedResolver(() => new Promise(() => undefined), {
      maxQueries: 10,
      timeoutMs: 1000,
    });
    const pending = resolve('slow.test', 'TXT');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ETIMEOUT' });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    await expect(resolve('later.test', 'TXT')).rejects.toMatchObject({ code: 'ETIMEOUT' });
  });

  it('passes answers and errors through within the budget', async () => {
    const resolve = budgetedResolver(
      fixtureResolver({ 'a.test': { A: ['192.0.2.1'] }, 'b.test': { error: 'EREFUSED' } }),
      { maxQueries: 5, timeoutMs: 1000 },
    );
    expect(await resolve('a.test', 'A')).toEqual(['192.0.2.1']);
    await expect(resolve('b.test', 'A')).rejects.toMatchObject({ code: 'EREFUSED' });
  });
});
