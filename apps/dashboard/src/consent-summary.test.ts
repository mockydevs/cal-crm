import type { ConsentState, ContactSuppression } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  needsConfirmation,
  offeredChange,
  quietHoursSpan,
  shownStates,
  verdictOf,
} from './consent-summary';

const state = (
  channel: ConsentState['channel'],
  status: ConsentState['status'],
  purpose: ConsentState['purpose'] = 'marketing',
): ConsentState => ({
  channel,
  purpose,
  status,
  source: status === 'unknown' ? null : 'user',
  recordedAt: status === 'unknown' ? null : '2026-10-08T12:00:00.000Z',
});
const bounced: ContactSuppression = {
  channel: 'email',
  address: 'maya@example.com',
  reason: 'hard_bounce',
  since: '2026-10-08T12:00:00.000Z',
  until: null,
};
const open = { doNotContact: false, suppressions: [] };

describe('verdictOf', () => {
  it('lets a message through only with consent given and nothing else in the way', () => {
    expect(verdictOf(open, state('email', 'granted'))).toBe('allowed');
    expect(verdictOf(open, state('email', 'unknown'))).toBe('no_consent');
    expect(verdictOf(open, state('email', 'withdrawn'))).toBe('withdrawn');
  });

  it('puts do not contact before everything, as the send check does', () => {
    for (const status of ['granted', 'withdrawn', 'unknown'] as const)
      expect(
        verdictOf({ doNotContact: true, suppressions: [bounced] }, state('email', status)),
      ).toBe('do_not_contact');
  });

  it('puts an address that cannot be sent to before consent, for its own channel only', () => {
    const suppressed = { doNotContact: false, suppressions: [bounced] };
    for (const status of ['granted', 'withdrawn', 'unknown'] as const)
      expect(verdictOf(suppressed, state('email', status))).toBe('suppressed');
    expect(verdictOf(suppressed, state('sms', 'granted'))).toBe('allowed');
    expect(verdictOf(suppressed, state('sms', 'withdrawn'))).toBe('withdrawn');
  });
});

describe('shownStates', () => {
  it('always shows email and texts, and other channels once something is recorded', () => {
    const current = [
      state('email', 'unknown'),
      state('email', 'unknown', 'transactional'),
      state('sms', 'granted'),
      state('sms', 'unknown', 'transactional'),
      state('whatsapp', 'unknown'),
      state('whatsapp', 'withdrawn', 'transactional'),
      state('call', 'unknown'),
      state('call', 'unknown', 'transactional'),
    ];
    expect(shownStates(current).map((row) => `${row.channel}:${row.purpose}`)).toEqual([
      'email:marketing',
      'email:transactional',
      'sms:marketing',
      'sms:transactional',
      'whatsapp:transactional',
    ]);
  });
});

describe('the change a row offers', () => {
  it('offers to withdraw what was given, and to record consent otherwise', () => {
    expect(offeredChange({ status: 'granted' })).toBe('withdrawn');
    expect(offeredChange({ status: 'withdrawn' })).toBe('granted');
    expect(offeredChange({ status: 'unknown' })).toBe('granted');
  });

  it('asks for confirmation only to give consent over a withdrawal', () => {
    expect(needsConfirmation({ status: 'withdrawn' }, 'granted')).toBe(true);
    expect(needsConfirmation({ status: 'unknown' }, 'granted')).toBe(false);
    expect(needsConfirmation({ status: 'granted' }, 'granted')).toBe(false);
    expect(needsConfirmation({ status: 'withdrawn' }, 'withdrawn')).toBe(false);
    expect(needsConfirmation({ status: 'granted' }, 'withdrawn')).toBe(false);
  });
});

describe('quietHoursSpan', () => {
  it('tells an overnight window from one within a day', () => {
    expect(quietHoursSpan('21:00', '08:00')).toBe('overnight');
    expect(quietHoursSpan('23:59', '00:00')).toBe('overnight');
    expect(quietHoursSpan('13:00', '14:30')).toBe('same_day');
    expect(quietHoursSpan('00:00', '23:59')).toBe('same_day');
    expect(quietHoursSpan('09:00', '09:00')).toBe('none');
  });
});
