import { expect, it } from 'vitest';
import { scoreMailboxChecks } from './index.js';

const checked = {
  connection: 'pass',
  encryption: 'pass',
  spf: 'pass',
  dkim: 'pass',
  dmarc: 'fail',
  dmarc_enforcement: 'fail',
  reverse_dns: 'fail',
  mx: 'pass',
  blocklists: 'pass',
  unsubscribe: 'pass',
} as const;

it('reproduces the documented 72, 86, 96 and 100 setup journey from independently verified checks', () => {
  expect(scoreMailboxChecks(checked).score).toBe(72);
  const monitoring = { ...checked, dmarc: 'pass' as const };
  expect(scoreMailboxChecks(monitoring).score).toBe(86);
  const reverseDns = { ...monitoring, reverse_dns: 'pass' as const };
  expect(scoreMailboxChecks(reverseDns).score).toBe(96);
  const enforced = { ...reverseDns, dmarc_enforcement: 'pass' as const };
  expect(scoreMailboxChecks(enforced).score).toBe(100);
});

it('awards inapplicable checks their points while retaining their distinct status', () => {
  const scored = scoreMailboxChecks({
    ...checked,
    reverse_dns: 'not_applicable',
    blocklists: 'not_applicable',
    unsubscribe: 'not_applicable',
  });
  expect(scored.score).toBe(82);
  expect(scored.checks).toEqual(
    expect.arrayContaining([
      { key: 'reverse_dns', status: 'not_applicable', pointsPossible: 10, pointsAwarded: 10 },
      { key: 'blocklists', status: 'not_applicable', pointsPossible: 15, pointsAwarded: 15 },
      { key: 'unsubscribe', status: 'not_applicable', pointsPossible: 6, pointsAwarded: 6 },
    ]),
  );
});

it('awards no points for unconfirmed evidence instead of converting it to a pass', () => {
  const scored = scoreMailboxChecks({
    ...checked,
    encryption: 'could_not_check',
    spf: 'could_not_check',
    dkim: 'could_not_check',
    reverse_dns: 'could_not_check',
    blocklists: 'could_not_check',
  });
  expect(scored.score).toBe(12);
  expect(scored.checks.filter((check) => check.status === 'could_not_check')).toHaveLength(5);
  expect(scored.checks).toContainEqual({
    key: 'dkim',
    status: 'could_not_check',
    pointsPossible: 20,
    pointsAwarded: 0,
  });
});
