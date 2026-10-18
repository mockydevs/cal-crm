import { describe, expect, it } from 'vitest';
import { blockedFor, checked, open, unchecked } from '../../e2e/email-verification-fixtures';
import { actionsOf, isExpired, reasonsOf, statusOf } from './rules';

describe('statusOf', () => {
  it('puts a block first, with its reason, whatever the check found', () => {
    expect(
      statusOf({ delivery: blockedFor('hard_bounce'), verification: checked('valid') }),
    ).toEqual({ kind: 'blocked', reason: 'hard_bounce' });
    expect(
      statusOf({
        delivery: blockedFor('manual'),
        verification: checked('valid', { excluded: true }),
      }),
    ).toEqual({ kind: 'blocked', reason: 'manual' });
  });

  it('puts an exclusion before what a check found', () => {
    expect(
      statusOf({ delivery: open, verification: checked('invalid', { excluded: true }) }),
    ).toEqual({ kind: 'excluded' });
  });

  it.each([
    ['invalid', 'mailbox', 'invalid'],
    ['risky', 'mailbox', 'risky'],
    ['unknown', 'domain', 'unknown'],
    ['valid', 'mailbox', 'verified'],
    ['valid', 'domain', 'domain_checked'],
    ['valid', null, 'domain_checked'],
  ] as const)('reads %s at %s depth as %s', (status, depth, kind) => {
    expect(statusOf({ delivery: open, verification: checked(status, { depth }) })).toEqual({
      kind,
    });
  });

  it('says Not verified before any check', () => {
    expect(statusOf({ delivery: open, verification: unchecked() })).toEqual({
      kind: 'not_verified',
    });
  });

  it('says nothing new when the server says nothing about verification', () => {
    expect(statusOf({ delivery: open })).toBeUndefined();
    expect(statusOf({ delivery: open, verification: null })).toBeUndefined();
    expect(statusOf({})).toBeUndefined();
    expect(statusOf({ delivery: blockedFor('complaint') })).toEqual({
      kind: 'blocked',
      reason: 'complaint',
    });
  });
});

describe('reasonsOf', () => {
  it('keeps role and free provider apart as hints, each reason once', () => {
    expect(
      reasonsOf(checked('risky', { reasons: ['role', 'catch_all', 'free_provider', 'catch_all'] })),
    ).toEqual({ problems: ['catch_all'], hints: ['role', 'free_provider'] });
    expect(reasonsOf(null)).toEqual({ problems: [], hints: [] });
  });
});

describe('isExpired', () => {
  const now = new Date('2027-01-15T09:00:00.000Z');
  it('is expired at and after its expiry, and never without one', () => {
    expect(isExpired(checked('valid'), now)).toBe(true);
    expect(isExpired(checked('valid'), new Date('2027-01-15T08:59:59.000Z'))).toBe(false);
    expect(isExpired(unchecked(), now)).toBe(false);
    expect(isExpired(undefined, now)).toBe(false);
  });
});

describe('actionsOf', () => {
  it('offers Verify before a check and Re-verify after one', () => {
    expect(actionsOf({ delivery: open, verification: unchecked() }, false)).toEqual({
      verify: 'verify',
      exclusion: 'exclude',
      block: 'block',
    });
    expect(actionsOf({ delivery: open, verification: checked('risky') }, false).verify).toBe(
      'reverify',
    );
  });

  it('offers no check of an excluded address, and offers to include it', () => {
    expect(
      actionsOf({ delivery: open, verification: checked('valid', { excluded: true }) }, true),
    ).toEqual({ verify: null, exclusion: 'include', block: 'block' });
  });

  it('lifts a block a person or a check made at once', () => {
    for (const reason of ['manual', 'invalid'] as const)
      expect(
        actionsOf({ delivery: blockedFor(reason), verification: unchecked() }, false).block,
      ).toBe('unblock');
    expect(
      actionsOf({ delivery: { status: 'blocked', reason: null, since: null } }, false).block,
    ).toBe('unblock');
  });

  it('lifts a hard bounce only for someone who may manage verification', () => {
    const bounced = { delivery: blockedFor('hard_bounce'), verification: checked('invalid') };
    expect(actionsOf(bounced, true).block).toBe('unblock_bounce');
    expect(actionsOf(bounced, false).block).toBeNull();
  });

  it('explains an opt-out instead of lifting it', () => {
    for (const reason of ['complaint', 'unsubscribe'] as const)
      expect(actionsOf({ delivery: blockedFor(reason) }, true).block).toBe('opted_out');
  });
});
