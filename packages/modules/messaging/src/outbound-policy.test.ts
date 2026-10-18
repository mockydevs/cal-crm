import { expect, it } from 'vitest';
import {
  evaluateDoNotDisturb,
  evaluateOutboundPolicy,
  outboundLanePriority,
  type OutboundPolicyFacts,
  type OutboundPolicyDecision,
} from './index.js';

const permitted: OutboundPolicyFacts = {
  contactActive: true,
  senderActive: true,
  doNotContact: false,
  consent: 'granted',
  suppression: null,
  timing: 'open',
  recentMessages: 0,
  frequencyLimit: 10,
};

it('allows delivery only when the current policy facts permit it', () => {
  expect(evaluateOutboundPolicy(permitted)).toEqual({ action: 'allow' });
});

const refusals: readonly {
  readonly label: string;
  readonly patch: Partial<OutboundPolicyFacts>;
  readonly expected: OutboundPolicyDecision;
}[] = [
  {
    label: 'inactive contact',
    patch: { contactActive: false },
    expected: { action: 'refuse', reason: 'contact_inactive' },
  },
  {
    label: 'inactive sender',
    patch: { senderActive: false },
    expected: { action: 'refuse', reason: 'sender_inactive' },
  },
  {
    label: 'do not contact',
    patch: { doNotContact: true },
    expected: { action: 'refuse', reason: 'do_not_contact' },
  },
  {
    label: 'withdrawn consent',
    patch: { consent: 'withdrawn' },
    expected: { action: 'refuse', reason: 'consent_withdrawn' },
  },
  {
    label: 'missing consent',
    patch: { consent: 'unknown' },
    expected: { action: 'refuse', reason: 'consent_required' },
  },
  {
    label: 'unknown timing',
    patch: { timing: 'unknown' },
    expected: { action: 'refuse', reason: 'timing_unknown' },
  },
];
it.each(refusals)('refuses $label with an allowlisted reason', ({ patch, expected }) => {
  expect(evaluateOutboundPolicy({ ...permitted, ...patch })).toEqual(expected);
});

it.each(['hard_bounce', 'complaint', 'unsubscribe', 'invalid', 'manual'] as const)(
  'refuses an active %s suppression and preserves its reason',
  (suppression) => {
    expect(evaluateOutboundPolicy({ ...permitted, suppression })).toEqual({
      action: 'refuse',
      reason: 'suppressed',
      suppressionReason: suppression,
    });
  },
);

it('refuses a channel that has do not disturb on, under the reason do not contact has', () => {
  const channel = { action: 'refuse', reason: 'do_not_contact', scope: 'channel' };
  expect(evaluateOutboundPolicy({ ...permitted, channelDoNotDisturb: true })).toEqual(channel);
  // Off, or not known to the caller, changes nothing.
  expect(evaluateOutboundPolicy({ ...permitted, channelDoNotDisturb: false })).toEqual({
    action: 'allow',
  });
  // Every channel at once is said first, and as it always was: with no scope.
  expect(
    evaluateOutboundPolicy({ ...permitted, doNotContact: true, channelDoNotDisturb: true }),
  ).toEqual({ action: 'refuse', reason: 'do_not_contact' });
  // It comes before what the address or the consent would say, and is permanent: quiet
  // hours and the daily cap never turn it into a wait.
  expect(
    evaluateOutboundPolicy({
      ...permitted,
      channelDoNotDisturb: true,
      suppression: 'hard_bounce',
      consent: 'withdrawn',
      timing: 'quiet',
      recentMessages: 10,
    }),
  ).toEqual(channel);
  // A contact in the trash and a sender that is off are still said before it.
  expect(
    evaluateOutboundPolicy({ ...permitted, channelDoNotDisturb: true, contactActive: false }),
  ).toEqual({ action: 'refuse', reason: 'contact_inactive' });
  expect(
    evaluateOutboundPolicy({ ...permitted, channelDoNotDisturb: true, senderActive: false }),
  ).toEqual({ action: 'refuse', reason: 'sender_inactive' });
});

it('records suppression before considering absent consent or deferred work', () => {
  expect(
    evaluateOutboundPolicy({
      ...permitted,
      suppression: 'complaint',
      consent: 'unknown',
      timing: 'quiet',
      recentMessages: 10,
    }),
  ).toEqual({ action: 'refuse', reason: 'suppressed', suppressionReason: 'complaint' });
});

it('never turns an opt-out into a temporary quiet-hours delay', () => {
  expect(
    evaluateOutboundPolicy({
      ...permitted,
      doNotContact: true,
      consent: 'withdrawn',
      timing: 'quiet',
      recentMessages: 10,
    }),
  ).toEqual({ action: 'refuse', reason: 'do_not_contact' });
  expect(evaluateOutboundPolicy({ ...permitted, consent: 'withdrawn', timing: 'quiet' })).toEqual({
    action: 'refuse',
    reason: 'consent_withdrawn',
  });
});

it('defers a permitted message during quiet hours', () => {
  expect(evaluateOutboundPolicy({ ...permitted, timing: 'quiet' })).toEqual({
    action: 'defer',
    reason: 'quiet_hours',
  });
});

it('lets a reminder of the contact’s own appointment through quiet hours, and nothing else', () => {
  const reminder = { ...permitted, lane: 'automation' as const, ownAppointment: true };
  expect(evaluateOutboundPolicy({ ...reminder, timing: 'quiet' })).toEqual({ action: 'allow' });
  expect(evaluateOutboundPolicy({ ...reminder, timing: 'unknown' })).toEqual({ action: 'allow' });
  expect(evaluateOutboundPolicy({ ...reminder, ownAppointment: false, timing: 'quiet' })).toEqual({
    action: 'defer',
    reason: 'quiet_hours',
  });
  // Consent, opt-outs and the daily cap still hold it.
  expect(evaluateOutboundPolicy({ ...reminder, timing: 'quiet', consent: 'withdrawn' })).toEqual({
    action: 'refuse',
    reason: 'consent_withdrawn',
  });
  expect(
    evaluateOutboundPolicy({ ...reminder, timing: 'quiet', recentMessages: 99, frequencyLimit: 1 }),
  ).toEqual({ action: 'defer', reason: 'frequency_cap' });
});

it.each([
  [0, 1, 'allow'],
  [1, 1, 'defer'],
  [2, 1, 'defer'],
  [9, 10, 'allow'],
  [10, 10, 'defer'],
  [11, 10, 'defer'],
] as const)(
  'checks frequency at %i messages against a cap of %i',
  (recentMessages, frequencyLimit, action) => {
    expect(evaluateOutboundPolicy({ ...permitted, recentMessages, frequencyLimit })).toEqual(
      action === 'allow' ? { action } : { action, reason: 'frequency_cap' },
    );
  },
);

it('keeps replies and transactional work ahead of automation and campaigns', () => {
  expect(
    (['reply', 'transactional', 'automation', 'campaign'] as const).map((lane) =>
      outboundLanePriority(lane),
    ),
  ).toEqual([0, 0, 1, 2]);
});

it('lets a person answer someone who emailed in, with no consent recorded', () => {
  const unknown = { ...permitted, consent: 'unknown' as const };
  expect(evaluateOutboundPolicy({ ...unknown, lane: 'reply', inboundBasis: true })).toEqual({
    action: 'allow',
  });
  // Only the reply lane, and only after they wrote; a withdrawal still wins.
  for (const facts of [
    { ...unknown, lane: 'reply' as const, inboundBasis: false },
    { ...unknown, lane: 'automation' as const, inboundBasis: true },
    { ...unknown, lane: 'transactional' as const, inboundBasis: true },
  ])
    expect(evaluateOutboundPolicy(facts)).toEqual({ action: 'refuse', reason: 'consent_required' });
  expect(
    evaluateOutboundPolicy({
      ...permitted,
      consent: 'withdrawn',
      lane: 'reply',
      inboundBasis: true,
    }),
  ).toEqual({ action: 'refuse', reason: 'consent_withdrawn' });
});

it('holds only workflow and campaign messages for the daily cap, and every lane for quiet hours', () => {
  const capped = { ...permitted, recentMessages: 99 };
  for (const lane of ['reply', 'transactional'] as const) {
    expect(evaluateOutboundPolicy({ ...capped, lane })).toEqual({ action: 'allow' });
    expect(evaluateOutboundPolicy({ ...capped, timing: 'quiet', lane })).toEqual({
      action: 'defer',
      reason: 'quiet_hours',
    });
  }
  for (const lane of ['automation', 'campaign', undefined] as const)
    expect(evaluateOutboundPolicy({ ...capped, ...(lane === undefined ? {} : { lane }) })).toEqual({
      action: 'defer',
      reason: 'frequency_cap',
    });
});

it('gives the do not disturb refusal alone, which the full policy gives the same way', () => {
  expect(evaluateDoNotDisturb({ doNotContact: false })).toBeUndefined();
  expect(evaluateDoNotDisturb({ doNotContact: false, channelDoNotDisturb: false })).toBeUndefined();
  expect(evaluateDoNotDisturb({ doNotContact: true, channelDoNotDisturb: true })).toEqual({
    action: 'refuse',
    reason: 'do_not_contact',
  });
  expect(evaluateDoNotDisturb({ doNotContact: false, channelDoNotDisturb: true })).toEqual({
    action: 'refuse',
    reason: 'do_not_contact',
    scope: 'channel',
  });
  expect(evaluateOutboundPolicy({ ...permitted, channelDoNotDisturb: true })).toEqual(
    evaluateDoNotDisturb({ doNotContact: false, channelDoNotDisturb: true }),
  );
});
