import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import {
  changeOf,
  eventTypesOf,
  rulePasses,
  SCORE_ACTION_EVENTS,
  scoreKeyOf,
  type LiveRule,
} from './rules.js';

const TAG = '01890a5d-ac96-774b-bcce-b302099a8057';
const FORM = '01890a5d-ac96-774b-bcce-b302099a8058';

const rule = (action: LiveRule['action'], qualifier: LiveRule['qualifier'] = {}): LiveRule => ({
  id: '01890a5d-ac96-774b-bcce-b302099a8059',
  action,
  qualifier,
  hasTagId: null,
  calculation: 'add',
  points: 1,
});

describe('which events a rule scores', () => {
  it('scores each email event by its own event, an unsubscribe only from email', () => {
    expect(rulePasses(rule('email_event', { event: 'bounced' }), 'message.bounced', {})).toBe(true);
    expect(rulePasses(rule('email_event', { event: 'bounced' }), 'message.complained', {})).toBe(
      false,
    );
    const unsubscribed = rule('email_event', { event: 'unsubscribed' });
    expect(rulePasses(unsubscribed, 'consent.withdrawn', { channel: 'email' })).toBe(true);
    expect(rulePasses(unsubscribed, 'consent.withdrawn', { channel: 'sms' })).toBe(false);
  });

  it('scores a reply by any channel, or by the one it names', () => {
    expect(rulePasses(rule('contact_replied'), 'message.received', { channel: 'webchat' })).toBe(
      true,
    );
    const bySms = rule('contact_replied', { channel: 'sms' });
    expect(rulePasses(bySms, 'message.received', { channel: 'sms' })).toBe(true);
    expect(rulePasses(bySms, 'message.received', { channel: 'email' })).toBe(false);
    expect(rulePasses(bySms, 'message.auto_reply_received', { channel: 'sms' })).toBe(false);
  });

  it('scores a form submission of any form or of the one it names', () => {
    expect(rulePasses(rule('form_submitted'), 'form.submitted', { formId: FORM })).toBe(true);
    const one = rule('form_submitted', { formId: FORM });
    expect(rulePasses(one, 'form.submitted', { formId: FORM })).toBe(true);
    expect(rulePasses(one, 'form.submitted', { formId: TAG })).toBe(false);
  });

  it('scores a change to the status it names, never a reschedule', () => {
    const confirmed = rule('appointment_status', { status: 'confirmed' });
    expect(
      rulePasses(confirmed, 'appointment.status_changed', {
        status: 'confirmed',
        previousStatus: 'booked',
      }),
    ).toBe(true);
    expect(
      rulePasses(confirmed, 'appointment.status_changed', {
        status: 'confirmed',
        previousStatus: 'confirmed',
        rescheduled: true,
      }),
    ).toBe(false);
    expect(
      rulePasses(confirmed, 'appointment.status_changed', {
        status: 'cancelled',
        previousStatus: 'booked',
      }),
    ).toBe(false);
  });

  it('scores the tag it names, added or removed, however the event writes its id', () => {
    const added = rule('contact_tag', { change: 'added', tagId: TAG });
    expect(rulePasses(added, 'tag.assigned', { tagId: toPublicId('tag', TAG) })).toBe(true);
    expect(rulePasses(added, 'tag.assigned', { tagId: TAG })).toBe(true);
    expect(rulePasses(added, 'tag.removed', { tagId: TAG })).toBe(false);
    expect(rulePasses(added, 'tag.assigned', { tagId: FORM })).toBe(false);
    const removed = rule('contact_tag', { change: 'removed', tagId: TAG });
    expect(rulePasses(removed, 'tag.removed', { tagId: TAG })).toBe(true);
  });

  it('scores the rest on their events alone', () => {
    expect(rulePasses(rule('appointment_booked'), 'appointment.booked', {})).toBe(true);
    expect(rulePasses(rule('payment_received'), 'payment.recorded', {})).toBe(true);
    expect(rulePasses(rule('payment_received'), 'invoice.paid', {})).toBe(false);
    expect(rulePasses(rule('trigger_link_clicked'), 'trigger_link.clicked', {})).toBe(true);
    for (const type of SCORE_ACTION_EVENTS.contact_changed)
      expect(rulePasses(rule('contact_changed'), type, {})).toBe(true);
  });

  it('never listens to the score changing, so no rule scores its own change', () => {
    expect(Object.values(SCORE_ACTION_EVENTS).flat()).not.toContain('contact.score_changed');
  });
});

describe('what a profile listens to and gives', () => {
  it('lists each event type once', () => {
    expect(
      eventTypesOf([rule('contact_tag'), rule('contact_tag'), rule('payment_received')]),
    ).toEqual(['payment.recorded', 'tag.assigned', 'tag.removed']);
  });

  it('adds or subtracts the points', () => {
    expect(changeOf({ calculation: 'add', points: 5 })).toBe(5);
    expect(changeOf({ calculation: 'subtract', points: 5 })).toBe(-5);
  });
});

describe('what a change to a score is keyed by', () => {
  const event = { id: 'event-1', commandId: 'command-1' };
  it('keys Contact changed by the command, so one save scores once', () => {
    expect(scoreKeyOf(rule('contact_changed'), event, 'contact-1')).toBe(
      'cmd:command-1:rule:01890a5d-ac96-774b-bcce-b302099a8059:contact:contact-1',
    );
  });

  it('keys every other rule, and an event no command wrote, by the event', () => {
    expect(scoreKeyOf(rule('payment_received'), event, 'contact-1')).toBe(
      'event:event-1:rule:01890a5d-ac96-774b-bcce-b302099a8059',
    );
    expect(scoreKeyOf(rule('contact_changed'), { id: 'event-1', commandId: null }, 'c')).toBe(
      'event:event-1:rule:01890a5d-ac96-774b-bcce-b302099a8059',
    );
  });
});
