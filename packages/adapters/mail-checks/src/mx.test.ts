import { describe, expect, it } from 'vitest';

import { fixtureResolver } from './fixture-resolver.js';
import { checkMx } from './mx.js';

describe('the MX check', () => {
  it('passes with mail exchangers, listed by priority', async () => {
    const resolve = fixtureResolver({
      'example.test': {
        MX: [
          { exchange: 'b.example.test', priority: 20 },
          { exchange: 'A.Example.Test.', priority: 10 },
        ],
      },
    });
    expect(await checkMx('Example.Test.', resolve)).toEqual({
      key: 'mx',
      status: 'pass',
      reason: 'mx_found',
      found: {
        domain: 'example.test',
        exchangers: [
          { exchange: 'a.example.test', priority: 10 },
          { exchange: 'b.example.test', priority: 20 },
        ],
      },
    });
  });

  it.each(['', '.'])(
    'fails a null MX (%j): the domain says it accepts no mail (RFC 7505)',
    async (exchange) => {
      const resolve = fixtureResolver({ 'example.test': { MX: [{ exchange, priority: 0 }] } });
      expect(await checkMx('example.test', resolve)).toEqual({
        key: 'mx',
        status: 'fail',
        reason: 'null_mx',
        found: { domain: 'example.test' },
      });
    },
  );

  it.each([
    ['an address of its own', { A: ['192.0.2.1'] }, 'address'],
    ['only an IPv6 address', { AAAA: ['2001:db8::1'] }, 'address'],
    ['no address either', { TXT: ['v=spf1 -all'] }, 'none'],
  ] as const)(
    'fails without MX records, noting the implicit MX when the domain has %s',
    async (_case, entry, implicitMx) => {
      const resolve = fixtureResolver({ 'example.test': entry });
      expect(await checkMx('example.test', resolve)).toEqual({
        key: 'mx',
        status: 'fail',
        reason: 'no_mx',
        found: { domain: 'example.test', implicitMx },
      });
    },
  );

  it('notes when the implicit MX itself could not be looked up', async () => {
    const resolve = fixtureResolver({
      'example.test': { TXT: ['v=spf1 -all'] },
      'nothing.test': { error: 'ESERVFAIL' },
    });
    // The domain has no MX for sure; whether it has an address is unknown.
    const flaky = (name: string, type: Parameters<typeof resolve>[1]) =>
      type === 'MX' ? resolve(name, type) : resolve('nothing.test', type);
    expect(await checkMx('example.test', flaky)).toEqual({
      key: 'mx',
      status: 'fail',
      reason: 'no_mx',
      found: { domain: 'example.test', implicitMx: 'unknown' },
    });
  });

  it("couldn't check when the MX lookup fails", async () => {
    const resolve = fixtureResolver({ 'example.test': { error: 'ETIMEOUT' } });
    expect(await checkMx('example.test', resolve)).toEqual({
      key: 'mx',
      status: 'could_not_check',
      reason: 'dns_error',
      found: { domain: 'example.test', code: 'ETIMEOUT' },
    });
  });

  it('never invents an MX record to publish', async () => {
    const results = await Promise.all([
      checkMx('none.test', fixtureResolver({})),
      checkMx(
        'null.test',
        fixtureResolver({ 'null.test': { MX: [{ exchange: '', priority: 0 }] } }),
      ),
    ]);
    for (const result of results) expect(result).not.toHaveProperty('fix');
  });
});
