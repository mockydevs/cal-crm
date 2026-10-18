import { fixtureResolver } from '@repo/mail-checks/testing';
import { describe, expect, it } from 'vitest';

import { checkDomain } from './domain.js';

describe('checkDomain', () => {
  it('accepts a domain with MX records, asking nothing more', async () => {
    const resolve = fixtureResolver({
      'example.com': { MX: [{ exchange: 'mx.example.com', priority: 10 }] },
    });
    await expect(checkDomain('example.com', { resolve })).resolves.toEqual({
      kind: 'accepts_mail',
      via: 'mx',
    });
    expect(resolve.queries).toEqual([['example.com', 'MX']]);
  });

  it('reads a null MX (RFC 7505) as a domain that accepts no mail', async () => {
    const resolve = fixtureResolver({ 'example.com': { MX: [{ exchange: '.', priority: 0 }] } });
    await expect(checkDomain('example.com', { resolve })).resolves.toEqual({
      kind: 'invalid',
      reason: 'no_mail_accepted',
    });
    expect(resolve.queries).toEqual([['example.com', 'MX']]);
  });

  it('still accepts a domain that lists a null MX beside real exchangers', async () => {
    const resolve = fixtureResolver({
      'example.com': {
        MX: [
          { exchange: '', priority: 0 },
          { exchange: 'mx.example.com', priority: 10 },
        ],
      },
    });
    await expect(checkDomain('example.com', { resolve })).resolves.toEqual({
      kind: 'accepts_mail',
      via: 'mx',
    });
  });

  it('reads a domain that does not exist (NXDOMAIN) as not found', async () => {
    const resolve = fixtureResolver({});
    await expect(checkDomain('nowhere.example', { resolve })).resolves.toEqual({
      kind: 'invalid',
      reason: 'domain_not_found',
    });
    expect(resolve.queries).toEqual([
      ['nowhere.example', 'MX'],
      ['nowhere.example', 'A'],
      ['nowhere.example', 'AAAA'],
    ]);
  });

  it('takes an address record as the implicit MX of RFC 5321 5.1', async () => {
    const v4 = fixtureResolver({ 'example.com': { A: ['192.0.2.1'] } });
    await expect(checkDomain('example.com', { resolve: v4 })).resolves.toEqual({
      kind: 'accepts_mail',
      via: 'address',
    });
    const v6 = fixtureResolver({ 'example.com': { AAAA: ['2001:db8::1'] } });
    await expect(checkDomain('example.com', { resolve: v6 })).resolves.toEqual({
      kind: 'accepts_mail',
      via: 'address',
    });
  });

  it('refuses a domain that exists but has neither MX nor address records', async () => {
    const resolve = fixtureResolver({ 'example.com': { TXT: ['v=spf1 -all'] } });
    await expect(checkDomain('example.com', { resolve })).resolves.toEqual({
      kind: 'invalid',
      reason: 'no_mail_server',
    });
  });

  it.each(['ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED'])(
    'never calls a domain invalid when its MX lookup fails with %s',
    async (code) => {
      const resolve = fixtureResolver({ 'example.com': { error: code } });
      await expect(checkDomain('example.com', { resolve })).resolves.toEqual({
        kind: 'unknown',
        reason: 'dns_unavailable',
        code,
      });
    },
  );

  it('says unknown when there is no MX and an address lookup fails', async () => {
    const resolve = fixtureResolver({ 'example.com': {} });
    const failing = Object.assign(
      (name: string, type: 'A' | 'AAAA' | 'MX' | 'TXT' | 'PTR' | 'NS') =>
        type === 'AAAA'
          ? Promise.reject(Object.assign(new Error('servfail'), { code: 'ESERVFAIL' }))
          : resolve(name, type),
      { queries: resolve.queries },
    );
    await expect(checkDomain('example.com', { resolve: failing })).resolves.toEqual({
      kind: 'unknown',
      reason: 'dns_unavailable',
      code: 'ESERVFAIL',
    });
  });

  it('reads an answer of the wrong shape as a failed lookup', async () => {
    const resolve = () => Promise.resolve('not records');
    await expect(checkDomain('example.com', { resolve })).resolves.toEqual({
      kind: 'unknown',
      reason: 'dns_unavailable',
      code: 'EBADRESP',
    });
  });

  it('gives up once the query budget is spent', async () => {
    const resolve = fixtureResolver({});
    await expect(
      checkDomain('nowhere.example', { resolve, budget: { maxQueries: 1, timeoutMs: 1000 } }),
    ).resolves.toEqual({ kind: 'unknown', reason: 'dns_unavailable', code: 'EBUDGET' });
  });

  it('gives up when the resolver does not answer in time', async () => {
    const resolve = () => new Promise<never>(() => undefined);
    await expect(
      checkDomain('example.com', { resolve, budget: { maxQueries: 6, timeoutMs: 20 } }),
    ).resolves.toEqual({ kind: 'unknown', reason: 'dns_unavailable', code: 'ETIMEOUT' });
  });

  it('turns a thrown resolver into unknown rather than a crash', async () => {
    const resolve = () => {
      throw new Error('broken');
    };
    await expect(checkDomain('example.com', { resolve })).resolves.toEqual({
      kind: 'unknown',
      reason: 'dns_unavailable',
      code: 'EUNKNOWN',
    });
  });
});
