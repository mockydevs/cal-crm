import { expect, it } from 'vitest';
import { mailboxSetup, mailboxSetupCheck, requestMailboxCheckInput } from './index.js';

it('allows an exact DNS fix while refusing raw vendor fields and unbounded record values', () => {
  const check = {
    key: 'dmarc',
    status: 'fail',
    reason: 'no_record',
    pointsPossible: 14,
    pointsAwarded: 0,
    fix: { kind: 'record', type: 'TXT', name: '_dmarc.example.test', value: 'v=DMARC1; p=none' },
  };
  expect(mailboxSetupCheck.safeParse(check).success).toBe(true);
  expect(
    mailboxSetupCheck.safeParse({ ...check, fix: { ...check.fix, password: 'fixture-secret' } })
      .success,
  ).toBe(false);
  expect(
    mailboxSetupCheck.safeParse({ ...check, fix: { ...check.fix, value: 'x'.repeat(4097) } })
      .success,
  ).toBe(false);
});

it('does not allow unconfirmed evidence to claim awarded setup points', () => {
  expect(
    mailboxSetupCheck.safeParse({
      key: 'dkim',
      status: 'could_not_check',
      reason: 'unsigned_local_copy',
      pointsPossible: 20,
      pointsAwarded: 20,
    }).success,
  ).toBe(false);
});

it('refuses a different point weight even when its awarded points agree', () => {
  expect(
    mailboxSetupCheck.safeParse({
      key: 'dmarc',
      status: 'pass',
      reason: 'verified',
      pointsPossible: 15,
      pointsAwarded: 15,
    }).success,
  ).toBe(false);
});

it('accepts only a mailbox identifier for a check request, never credentials or tenant overrides', () => {
  const input = { id: 'mbx_01h455vb4pex5vsknk084sn02q' };
  expect(requestMailboxCheckInput.safeParse(input).success).toBe(true);
  expect(requestMailboxCheckInput.safeParse({ ...input, password: 'fixture-secret' }).success).toBe(
    false,
  );
  expect(requestMailboxCheckInput.safeParse({ ...input, businessId: 'foreign' }).success).toBe(
    false,
  );
});

it('keeps pending setup responses empty of credentials, raw mail and premature scores', () => {
  const pending = {
    mailboxId: 'mbx_01h455vb4pex5vsknk084sn02q',
    state: 'pending',
    method: 'self',
    trigger: 'manual',
    startedAt: '2026-10-09T03:00:00.000Z',
    finishedAt: null,
    score: null,
    checks: [],
  };
  expect(mailboxSetup.safeParse(pending).success).toBe(true);
  expect(mailboxSetup.safeParse({ ...pending, source: 'raw fixture mail' }).success).toBe(false);
  expect(mailboxSetup.safeParse({ ...pending, password: 'fixture-secret' }).success).toBe(false);
  expect(mailboxSetup.safeParse({ ...pending, score: 100 }).success).toBe(false);
});

it('accepts a complete finished score and rejects inconsistent or duplicated evidence', () => {
  const checks = [
    ['connection', 0],
    ['encryption', 10],
    ['spf', 15],
    ['dkim', 20],
    ['dmarc', 14],
    ['dmarc_enforcement', 4],
    ['reverse_dns', 10],
    ['mx', 6],
    ['blocklists', 15],
    ['unsubscribe', 6],
  ].map(([key, points]) => ({
    key,
    status: 'pass',
    reason: 'verified',
    pointsPossible: points,
    pointsAwarded: points,
  }));
  const finished = {
    mailboxId: 'mbx_01h455vb4pex5vsknk084sn02q',
    state: 'finished',
    method: 'self',
    trigger: 'manual',
    startedAt: '2026-10-09T03:00:00.000Z',
    finishedAt: '2026-10-09T03:00:02.000Z',
    score: 100,
    checks,
  };
  expect(mailboxSetup.safeParse(finished).success).toBe(true);
  expect(mailboxSetup.safeParse({ ...finished, score: 99 }).success).toBe(false);
  expect(mailboxSetup.safeParse({ ...finished, checks: checks.slice(1) }).success).toBe(false);
  expect(
    mailboxSetup.safeParse({ ...finished, checks: [...checks.slice(1), checks[1]] }).success,
  ).toBe(false);
  expect(
    mailboxSetup.safeParse({
      ...finished,
      checks: checks.map((check) => ({ ...check, source: 'raw fixture' })),
    }).success,
  ).toBe(false);
});
