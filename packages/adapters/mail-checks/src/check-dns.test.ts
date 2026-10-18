import { expect, it } from 'vitest';
import { checkDns } from './index.js';
import { fixtureResolver } from './fixture-resolver.js';

it('returns all five DNS checks without inferring SPF authorization from a DNS-only run', async () => {
  const results = await checkDns(
    { fromDomain: 'example.test', returnPathDomain: 'example.test' },
    fixtureResolver({
      'example.test': {
        TXT: ['v=spf1 -all'],
        MX: [{ priority: 10, exchange: 'mail.example.test' }],
      },
      '_dmarc.example.test': { TXT: ['v=DMARC1; p=reject'] },
    }),
  );
  expect(results.map(({ key, status }) => [key, status])).toEqual([
    ['spf', 'could_not_check'],
    ['dmarc', 'pass'],
    ['dmarc_enforcement', 'pass'],
    ['mx', 'pass'],
    ['reverse_dns', 'could_not_check'],
  ]);
});

it('bounds the entire run when a resolver never answers', async () => {
  const results = await checkDns(
    { fromDomain: 'example.test', returnPathDomain: 'example.test', sendingIp: '192.0.2.1' },
    () => new Promise<never>(() => undefined),
    { maxQueries: 10, timeoutMs: 20 },
  );
  expect(results.every(({ status }) => status === 'could_not_check')).toBe(true);
});

it('shares one query budget across all checks', async () => {
  let queries = 0;
  const results = await checkDns(
    { fromDomain: 'example.test', returnPathDomain: 'example.test', sendingIp: '192.0.2.1' },
    (name, type) => {
      queries += 1;
      return fixtureResolver({})(name, type);
    },
    { maxQueries: 1, timeoutMs: 100 },
  );
  expect(queries).toBe(1);
  expect(results.filter(({ status }) => status === 'could_not_check').length).toBeGreaterThan(0);
});

it.each([
  { maxQueries: 0, timeoutMs: 100 },
  { maxQueries: 2, timeoutMs: 0 },
  { maxQueries: 1.5, timeoutMs: 100 },
  { maxQueries: 1001, timeoutMs: 100 },
  { maxQueries: 2, timeoutMs: 30001 },
])('refuses an invalid trusted DNS budget %j', async (budget) => {
  await expect(
    checkDns(
      { fromDomain: 'example.test', returnPathDomain: 'example.test' },
      fixtureResolver({}),
      budget,
    ),
  ).rejects.toThrow(RangeError);
});
