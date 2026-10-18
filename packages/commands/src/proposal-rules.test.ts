import { proposalStatuses, type ProposalStatus } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import {
  decideApply,
  decideDismiss,
  decideUndo,
  type ProposalState,
  type UndoPlan,
} from './proposal-rules.js';

const NOW = new Date('2026-10-10T09:00:00.000Z');
const BEFORE = new Date('2026-10-10T08:59:59.999Z');
const AFTER = new Date('2026-10-10T09:00:00.001Z');

const state = (status: ProposalStatus, changes: Partial<ProposalState> = {}): ProposalState => ({
  status,
  expiresAt: null,
  revision: 'thread:4',
  ...changes,
});

describe('decideApply', () => {
  it('runs a waiting proposal made on the record as it is now', () => {
    expect(decideApply(state('pending'), NOW, 'thread:4')).toEqual({ action: 'run' });
    expect(decideApply(state('pending', { expiresAt: AFTER }), NOW, 'thread:4')).toEqual({
      action: 'run',
    });
  });

  it('refuses a waiting proposal once the record has moved on', () => {
    expect(decideApply(state('pending'), NOW, 'thread:5')).toEqual({
      action: 'refuse',
      reason: 'stale',
    });
    expect(decideApply(state('pending', { revision: '' }), NOW, 'thread:4')).toEqual({
      action: 'refuse',
      reason: 'stale',
    });
  });

  it('refuses a waiting proposal from the moment its time is up', () => {
    for (const expiresAt of [BEFORE, NOW])
      expect(decideApply(state('pending', { expiresAt }), NOW, 'thread:4')).toEqual({
        action: 'refuse',
        reason: 'expired',
      });
  });

  it('says a proposal is expired rather than stale when it is both', () => {
    expect(decideApply(state('pending', { expiresAt: BEFORE }), NOW, 'thread:5')).toEqual({
      action: 'refuse',
      reason: 'expired',
    });
  });

  it('answers an applied proposal as done, whatever has changed or passed since', () => {
    expect(decideApply(state('applied'), NOW, 'thread:4')).toEqual({ action: 'repeat' });
    expect(decideApply(state('applied', { expiresAt: BEFORE }), NOW, 'thread:9')).toEqual({
      action: 'repeat',
    });
  });

  it.each(['dismissed', 'expired', 'undone'] as const)(
    'never runs a %s proposal, even made on the record as it is',
    (status) => {
      expect(decideApply(state(status), NOW, 'thread:4')).toEqual({
        action: 'refuse',
        reason: status,
      });
    },
  );

  it('has an answer for every status there is', () => {
    expect(
      proposalStatuses.map((status) => decideApply(state(status), NOW, 'thread:4').action),
    ).toEqual(['run', 'repeat', 'refuse', 'refuse', 'refuse']);
  });
});

describe('decideDismiss', () => {
  it('dismisses a waiting proposal, and needs no fingerprint to', () => {
    expect(decideDismiss({ status: 'pending', expiresAt: null }, NOW)).toEqual({
      action: 'dismiss',
    });
    expect(decideDismiss({ status: 'pending', expiresAt: AFTER }, NOW)).toEqual({
      action: 'dismiss',
    });
  });

  it('answers a dismissed proposal as done', () => {
    expect(decideDismiss({ status: 'dismissed', expiresAt: null }, NOW)).toEqual({
      action: 'repeat',
    });
    expect(decideDismiss({ status: 'dismissed', expiresAt: BEFORE }, NOW)).toEqual({
      action: 'repeat',
    });
  });

  it('refuses a waiting proposal whose time is up: it is expired, not dismissed', () => {
    for (const expiresAt of [BEFORE, NOW])
      expect(decideDismiss({ status: 'pending', expiresAt }, NOW)).toEqual({
        action: 'refuse',
        reason: 'expired',
      });
  });

  it.each(['applied', 'expired', 'undone'] as const)(
    'never dismisses a proposal that is %s',
    (status) => {
      expect(decideDismiss({ status, expiresAt: null }, NOW)).toEqual({
        action: 'refuse',
        reason: status,
      });
    },
  );
});

describe('decideUndo', () => {
  const reverse: UndoPlan = { kind: 'conversation_status', input: { status: 'open' } };
  const never: UndoPlan = { impossible: 'message_sent' };

  it('reverses an applied proposal with the command that was worked out when it was applied', () => {
    expect(decideUndo({ status: 'applied', undo: reverse })).toEqual({
      action: 'run',
      kind: 'conversation_status',
      input: { status: 'open' },
    });
  });

  it('refuses, with the reason, where nothing can reverse it', () => {
    expect(decideUndo({ status: 'applied', undo: never })).toEqual({
      action: 'refuse',
      reason: 'impossible',
      why: 'message_sent',
    });
  });

  it('answers an undone proposal as done, and never reverses it twice', () => {
    expect(decideUndo({ status: 'undone', undo: reverse })).toEqual({ action: 'repeat' });
    expect(decideUndo({ status: 'undone', undo: never })).toEqual({ action: 'repeat' });
  });

  it.each(['pending', 'dismissed', 'expired'] as const)(
    'refuses to undo a %s proposal: nothing was applied',
    (status) => {
      expect(decideUndo({ status, undo: null })).toEqual({
        action: 'refuse',
        reason: 'not_applied',
      });
      // Even were a way back recorded on it, which the database refuses.
      expect(decideUndo({ status, undo: reverse })).toEqual({
        action: 'refuse',
        reason: 'not_applied',
      });
    },
  );

  it('refuses an applied proposal with no way back recorded, rather than guess one', () => {
    expect(decideUndo({ status: 'applied', undo: null })).toEqual({
      action: 'refuse',
      reason: 'not_applied',
    });
  });
});
