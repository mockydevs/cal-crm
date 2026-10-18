import { describe, expect, it } from 'vitest';

import { createHostResolver, type DnsLookups } from './sites-dns.js';

const failing = (): Promise<string[]> => Promise.reject(new Error('ENOTFOUND'));

function dns(records: {
  cname?: Record<string, string>;
  a?: Record<string, string[]>;
  aaaa?: Record<string, string[]>;
}): DnsLookups & { asked: string[] } {
  const asked: string[] = [];
  const from =
    (table: Record<string, string[]> | undefined) =>
    (hostname: string): Promise<string[]> => {
      const found = table?.[hostname];
      return found === undefined ? failing() : Promise.resolve(found);
    };
  return {
    asked,
    resolveCname: (hostname) => {
      asked.push(hostname);
      const next = records.cname?.[hostname];
      return next === undefined ? failing() : Promise.resolve([next]);
    },
    resolve4: from(records.a),
    resolve6: from(records.aaaa),
  };
}

describe('looking a host name up', () => {
  it('follows the CNAME chain and gathers both kinds of address', async () => {
    const resolve = createHostResolver(
      dns({
        cname: { 'www.example.com': 'sites.crm.example', 'sites.crm.example': 'edge.crm.example' },
        a: { 'www.example.com': ['203.0.113.10'] },
        aaaa: { 'www.example.com': ['2001:db8::10'] },
      }),
    );
    expect(await resolve('www.example.com')).toEqual({
      cnames: ['sites.crm.example', 'edge.crm.example'],
      addresses: ['203.0.113.10', '2001:db8::10'],
    });
  });

  it('answers with nothing for a name that does not resolve', async () => {
    expect(await createHostResolver(dns({}))('nowhere.example.com')).toEqual({
      cnames: [],
      addresses: [],
    });
  });

  it('stops at a loop and after five hops', async () => {
    const loop = dns({ cname: { 'a.example': 'b.example', 'b.example': 'a.example' } });
    // a → b → a: the second "a" is new to the list, the next "b" is not.
    expect((await createHostResolver(loop)('a.example')).cnames).toEqual([
      'b.example',
      'a.example',
    ]);
    const long = dns({
      cname: Object.fromEntries(
        Array.from({ length: 9 }, (_, n) => [`h${String(n)}.example`, `h${String(n + 1)}.example`]),
      ),
    });
    expect((await createHostResolver(long)('h0.example')).cnames).toHaveLength(5);
    expect(long.asked).toHaveLength(5);
  });

  it('is made with the system resolver by default', () => {
    expect(typeof createHostResolver()).toBe('function');
  });
});
