import { expect, it } from 'vitest';
import { evaluateMailboxAdmission, mailboxDailyAllowance } from './index.js';

it('ramps automated mail from 50 to the chosen cap over 28 days, without exceeding small caps', () => {
  expect(mailboxDailyAllowance(300, true, 0)).toBe(50);
  expect(mailboxDailyAllowance(300, true, 1)).toBe(59);
  expect(mailboxDailyAllowance(300, true, 14)).toBe(179);
  expect(mailboxDailyAllowance(300, true, 27)).toBe(300);
  expect(mailboxDailyAllowance(300, true, 100)).toBe(300);
  expect(mailboxDailyAllowance(300, true, -3)).toBe(50);
  expect(mailboxDailyAllowance(300, true, 1.9)).toBe(59);
  expect(mailboxDailyAllowance(20, true, 0)).toBe(20);
  expect(mailboxDailyAllowance(300, false, 0)).toBe(300);
});

it('holds a temporary provider pause until its boundary and admits a first reservation', () => {
  const facts = {
    nowMs: 100_000,
    dailyLimit: 300,
    warmupEnabled: false,
    elapsedDays: 0,
    recentAll: 0,
    recentAutomated: 0,
    earliestReservationMs: null,
    lastReservationMs: null,
    pacingPerMinute: 5,
    pausedUntilMs: 200_000,
    lane: 'transactional' as const,
  };
  expect(evaluateMailboxAdmission(facts)).toEqual({
    action: 'defer',
    reason: 'provider_temporary',
    retryAtMs: 200_000,
  });
  expect(evaluateMailboxAdmission({ ...facts, pausedUntilMs: 100_000 })).toEqual({
    action: 'allow',
  });
  expect(evaluateMailboxAdmission({ ...facts, pausedUntilMs: null })).toEqual({ action: 'allow' });
  expect(evaluateMailboxAdmission({ ...facts, pausedUntilMs: null, recentAll: 300 })).toEqual({
    action: 'defer',
    reason: 'mailbox_daily_limit',
    retryAtMs: 86_500_000,
  });
  expect(
    evaluateMailboxAdmission({
      ...facts,
      pausedUntilMs: null,
      lane: 'automation',
      recentAutomated: 299,
    }),
  ).toEqual({ action: 'allow' });
});

it('reconsiders a warmup hold at the next daily increase before the rolling usage expires', () => {
  expect(
    evaluateMailboxAdmission({
      nowMs: 100_000,
      dailyLimit: 300,
      warmupEnabled: true,
      elapsedDays: 0.75,
      recentAll: 50,
      recentAutomated: 50,
      earliestReservationMs: 50_000,
      lastReservationMs: 90_000,
      pacingPerMinute: 5,
      pausedUntilMs: null,
      lane: 'automation',
    }),
  ).toEqual({ action: 'defer', reason: 'mailbox_warmup_limit', retryAtMs: 21_700_000 });
});

it('defers full rolling daily budgets and closely spaced messages, preserving reply warmup priority', () => {
  const facts = {
    nowMs: 100_000,
    dailyLimit: 300,
    warmupEnabled: true,
    elapsedDays: 0,
    recentAll: 50,
    recentAutomated: 50,
    earliestReservationMs: 50_000,
    lastReservationMs: 90_000,
    pacingPerMinute: 2,
    pausedUntilMs: null,
    lane: 'campaign' as const,
  };
  expect(evaluateMailboxAdmission(facts)).toEqual({
    action: 'defer',
    reason: 'mailbox_warmup_limit',
    retryAtMs: 86_450_000,
  });
  expect(evaluateMailboxAdmission({ ...facts, lane: 'reply' })).toEqual({
    action: 'defer',
    reason: 'mailbox_pacing',
    retryAtMs: 120_000,
  });
  expect(evaluateMailboxAdmission({ ...facts, recentAll: 300 })).toEqual({
    action: 'defer',
    reason: 'mailbox_daily_limit',
    retryAtMs: 86_450_000,
  });
  expect(evaluateMailboxAdmission({ ...facts, lane: 'reply', lastReservationMs: 60_000 })).toEqual({
    action: 'allow',
  });
});
