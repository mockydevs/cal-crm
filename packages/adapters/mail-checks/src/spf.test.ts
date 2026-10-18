import { describe, expect, it } from 'vitest';

import { fixtureResolver, type FixtureZone } from './fixture-resolver.js';
import { checkSpf, staticSpfProblem } from './spf.js';

const ip = '192.0.2.10';
const other = '198.51.100.1';
const domain = 'rp.example.test';

function includeChain(length: number): FixtureZone {
  const zone: Record<string, { TXT: string[] }> = {};
  for (let index = 0; index < length; index++)
    zone[`i${String(index)}.example.test`] = {
      TXT: [
        index < length - 1
          ? `v=spf1 include:i${String(index + 1)}.example.test -all`
          : 'v=spf1 -all',
      ],
    };
  return zone;
}

describe('SPF with the sending IP', () => {
  it.each([
    ['192.0.2.10', 'ip4:192.0.2.10'],
    ['2001:db8::10', 'ip6:2001:db8::10'],
  ])('offers a missing record using the observed address %s', async (sendingIp, mechanism) => {
    const result = await checkSpf({ returnPathDomain: domain, sendingIp }, fixtureResolver({}));
    expect(result).toMatchObject({
      status: 'fail',
      reason: 'no_record',
      fix: { kind: 'record', type: 'TXT', name: domain, value: `v=spf1 ${mechanism} ~all` },
    });
  });
  it('rejects malformed resolver answers inside an include', async () => {
    const record = 'v=spf1 include:child.example.test -all';
    const result = await checkSpf({ returnPathDomain: domain, sendingIp: ip }, (name) =>
      Promise.resolve(name === domain ? [[record]] : [`v=spf1 ip4:${ip} -all`]),
    );
    expect(result).toMatchObject({ status: 'could_not_check', reason: 'dns_error' });
  });
  it('requires sender identity for a macro found inside an include', async () => {
    const record = 'v=spf1 include:child.example.test -all';
    expect(
      await checkSpf(
        { returnPathDomain: domain, sendingIp: ip },
        fixtureResolver({
          [domain]: { TXT: [record] },
          'child.example.test': { TXT: ['v=spf1 exists:%{l}.example.test -all'] },
        }),
      ),
    ).toMatchObject({
      status: 'could_not_check',
      reason: 'sender_identity_required',
      found: { record },
    });
  });
  it('does not invent an exact fix past an earlier negatively qualified match', async () => {
    const record = 'v=spf1 ?a:host.example.test -all';
    const result = await checkSpf(
      { returnPathDomain: domain, sendingIp: ip },
      fixtureResolver({ [domain]: { TXT: [record] }, 'host.example.test': { A: [ip] } }),
    );
    expect(result.status).toBe('fail');
    expect(result).not.toHaveProperty('fix');
  });
  it('cannot authorize a sender-specific macro without the actual sender identity', async () => {
    const record = 'v=spf1 include:%{l}.example.test -all';
    const resolve = fixtureResolver({
      [domain]: { TXT: [record] },
      'postmaster.example.test': { TXT: [`v=spf1 ip4:${ip} -all`] },
    });
    expect(await checkSpf({ returnPathDomain: domain, sendingIp: ip }, resolve)).toMatchObject({
      status: 'could_not_check',
      reason: 'sender_identity_required',
      found: { record },
    });
  });
  it('passes when the Return-Path domain allows the IP', async () => {
    const resolve = fixtureResolver({ [domain]: { TXT: [`v=spf1 ip4:${ip} -all`] } });
    expect(await checkSpf({ returnPathDomain: domain, sendingIp: ip }, resolve)).toEqual({
      key: 'spf',
      status: 'pass',
      reason: 'ip_allowed',
      found: { domain, ip, record: `v=spf1 ip4:${ip} -all`, lookups: 0 },
    });
  });

  it.each(['-all', '~all', '?all'])(
    "fails when %s leaves the IP out, fixing it by adding the IP before the record's all",
    async (all) => {
      const record = `v=spf1 include:_spf.example.net ${all}`;
      const resolve = fixtureResolver({
        [domain]: { TXT: [record] },
        '_spf.example.net': { TXT: ['v=spf1 ip4:203.0.113.0/24 -all'] },
      });
      expect(await checkSpf({ returnPathDomain: domain, sendingIp: other }, resolve)).toEqual({
        key: 'spf',
        status: 'fail',
        reason: 'ip_not_allowed',
        found: { domain, ip: other, record, lookups: 1 },
        fix: {
          kind: 'record',
          type: 'TXT',
          name: domain,
          value: `v=spf1 include:_spf.example.net ip4:${other} ${all}`,
        },
      });
    },
  );

  it("adds the mechanism the provider's context proves, before a redirect, and an IPv6 address as ip6", async () => {
    const resolve = fixtureResolver({
      [domain]: { TXT: ['v=spf1 a redirect=_spf.example.net'] },
      '_spf.example.net': { TXT: ['v=spf1 -all'] },
    });
    expect(
      await checkSpf(
        { returnPathDomain: domain, sendingIp: other, spfAuthorize: 'include:_spf.google.com' },
        resolve,
      ),
    ).toMatchObject({
      reason: 'ip_not_allowed',
      fix: { value: 'v=spf1 a include:_spf.google.com redirect=_spf.example.net' },
    });
    const six = fixtureResolver({ [domain]: { TXT: ['v=spf1 -all'] } });
    expect(
      await checkSpf({ returnPathDomain: domain, sendingIp: '2001:db8::5' }, six),
    ).toMatchObject({ fix: { value: 'v=spf1 ip6:2001:db8::5 -all' } });
  });

  it("flags a fix that would take the record past SPF's 10 lookups", async () => {
    const terms = Array.from({ length: 10 }, (_, index) => `a:h${String(index)}.example.test`);
    const record = `v=spf1 ${terms.join(' ')} -all`;
    const zone: Record<string, { TXT?: string[]; A?: string[] }> = { [domain]: { TXT: [record] } };
    for (let index = 0; index < 10; index++)
      zone[`h${String(index)}.example.test`] = { A: ['203.0.113.9'] };
    expect(
      await checkSpf(
        { returnPathDomain: domain, sendingIp: other, spfAuthorize: 'include:_spf.google.com' },
        fixtureResolver(zone),
      ),
    ).toMatchObject({ reason: 'ip_not_allowed', fix: { exceedsLookupLimit: true } });
  });

  it("doesn't offer a fix the record already has", async () => {
    const resolve = fixtureResolver({ [domain]: { TXT: [`v=spf1 ?ip4:${other} ?all`] } });
    // ip4 matched with "?": neutral, so the IP isn't allowed, but adding it again fixes nothing.
    const result = await checkSpf({ returnPathDomain: domain, sendingIp: other }, resolve);
    expect(result).toMatchObject({ status: 'fail', reason: 'ip_not_allowed' });
    expect(result).not.toHaveProperty('fix');
  });

  it('fixes a missing record with the observed IP or a mechanism proved by provider context', async () => {
    const resolve = fixtureResolver({ [domain]: { TXT: ['google-site-verification=abc'] } });
    expect(await checkSpf({ returnPathDomain: domain, sendingIp: ip }, resolve)).toEqual({
      key: 'spf',
      status: 'fail',
      reason: 'no_record',
      found: { domain, ip },
      fix: {
        kind: 'record',
        type: 'TXT',
        name: domain,
        value: `v=spf1 ip4:${ip} ~all`,
      },
    });
    expect(
      await checkSpf(
        { returnPathDomain: domain, sendingIp: ip, spfAuthorize: 'include:_spf.google.com' },
        resolve,
      ),
    ).toMatchObject({
      reason: 'no_record',
      fix: {
        kind: 'record',
        type: 'TXT',
        name: domain,
        value: 'v=spf1 include:_spf.google.com ~all',
      },
    });
  });

  it('fails more than one SPF record, an invalid one and one past 10 lookups, without inventing a fix', async () => {
    const multiple = fixtureResolver({ [domain]: { TXT: ['v=spf1 -all', 'v=spf1 ~all'] } });
    const invalid = fixtureResolver({ [domain]: { TXT: ['v=spf1 foo:bar -all'] } });
    const tooMany = fixtureResolver({
      [domain]: { TXT: ['v=spf1 include:i0.example.test -all'] },
      ...includeChain(12),
    });
    const results = await Promise.all([
      checkSpf({ returnPathDomain: domain, sendingIp: ip }, multiple),
      checkSpf({ returnPathDomain: domain, sendingIp: ip }, invalid),
      checkSpf({ returnPathDomain: domain, sendingIp: ip }, tooMany),
    ]);
    expect(results.map((result) => [result.status, result.reason])).toEqual([
      ['fail', 'multiple_records'],
      ['fail', 'invalid_record'],
      ['fail', 'too_many_lookups'],
    ]);
    for (const result of results) expect(result).not.toHaveProperty('fix');
    expect(results[0].found).toEqual({ domain, ip, records: ['v=spf1 -all', 'v=spf1 ~all'] });
    expect(results[1].found).toEqual({ domain, ip, record: 'v=spf1 foo:bar -all' });
    expect(results[2].found).toMatchObject({ domain, ip, lookups: 11 });
  });

  it("couldn't check when DNS fails", async () => {
    const resolve = fixtureResolver({ [domain]: { error: 'ESERVFAIL' } });
    expect(await checkSpf({ returnPathDomain: domain, sendingIp: ip }, resolve)).toEqual({
      key: 'spf',
      status: 'could_not_check',
      reason: 'dns_error',
      found: { domain, ip, code: 'ESERVFAIL' },
    });
  });

  it("couldn't check when a lookup inside the evaluation fails", async () => {
    const resolve = fixtureResolver({
      [domain]: { TXT: ['v=spf1 include:broken.example.test -all'] },
      'broken.example.test': { error: 'ETIMEOUT' },
    });
    expect(await checkSpf({ returnPathDomain: domain, sendingIp: ip }, resolve)).toMatchObject({
      status: 'could_not_check',
      reason: 'dns_error',
      found: { domain, ip, record: 'v=spf1 include:broken.example.test -all' },
    });
  });
});

describe('SPF without the sending IP (DNS only)', () => {
  it("never passes, keeping the record it found: whether it allows the sender can't be known", async () => {
    const record = 'v=spf1 include:%{d}._spf.example.net -all';
    const resolve = fixtureResolver({ [domain]: { TXT: [record] } });
    expect(await checkSpf({ returnPathDomain: domain }, resolve)).toEqual({
      key: 'spf',
      status: 'could_not_check',
      reason: 'no_sending_ip',
      found: { domain, record },
    });
  });

  it('fails what DNS alone proves: no record, more than one, or a record that is invalid as written', async () => {
    const cases: [FixtureZone, string][] = [
      [{ [domain]: { TXT: ['other'] } }, 'no_record'],
      [{}, 'no_record'],
      [{ [domain]: { TXT: ['v=spf1 -all', 'V=SPF1 ~all'] } }, 'multiple_records'],
      [{ [domain]: { TXT: ['v=spf1 ip4:192.0.2.300 -all'] } }, 'invalid_record'],
    ];
    for (const [zone, reason] of cases)
      expect(await checkSpf({ returnPathDomain: domain }, fixtureResolver(zone))).toMatchObject({
        status: 'fail',
        reason,
      });
  });

  it("couldn't check when the TXT lookup fails", async () => {
    expect(
      await checkSpf(
        { returnPathDomain: domain },
        fixtureResolver({ [domain]: { error: 'EREFUSED' } }),
      ),
    ).toEqual({
      key: 'spf',
      status: 'could_not_check',
      reason: 'dns_error',
      found: { domain, code: 'EREFUSED' },
    });
  });
});

describe('static SPF problems', () => {
  it.each([
    ['v=spf1 -all', undefined],
    ['v=spf1 +a mx/24 ptr exists:%{i}.x.test ip4:192.0.2.0/24 ip6:2001:db8::/32 ?all', undefined],
    ['v=spf1 include:a.test exp=explain.%{d} -all', undefined],
    ['v=spf1 future-mod=value -all', undefined],
    ['v=spf1 a:%{l}.example.test -all', undefined],
    ['v=spf1 foo:bar -all', 'invalid_record'],
    ['v=spf1 ip4:192.0.2.300 -all', 'invalid_record'],
    ['v=spf1 ip4:192.0.2.0/33 -all', 'invalid_record'],
    ['v=spf1 ip6:2001:db8::/129 -all', 'invalid_record'],
    ['v=spf1 ip6:not-an-address -all', 'invalid_record'],
    ['v=spf1 include: -all', 'invalid_record'],
    ['v=spf1 exists -all', 'invalid_record'],
    ['v=spf1 redirect=a.test redirect=b.test', 'invalid_record'],
    ['v=spf1 exp=a.test exp=b.test -all', 'invalid_record'],
    ['v=spf1 9bad=value -all', 'invalid_record'],
    ['v=spf1 *all', 'invalid_record'],
  ] as const)('reads %j as %s', (record, problem) => {
    expect(staticSpfProblem(record)).toBe(problem);
  });

  it('does not infer executed lookups from the number of conditional terms', () => {
    const many = `v=spf1 ${Array.from({ length: 11 }, () => 'a').join(' ')} -all`;
    expect(staticSpfProblem(many)).toBeUndefined();
    expect(
      staticSpfProblem(`v=spf1 ${Array.from({ length: 10 }, () => 'mx').join(' ')} -all`),
    ).toBe(undefined);
  });
});
