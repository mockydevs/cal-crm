import { describe, expect, it } from 'vitest';

import { countEmailStep, emailSkipReason, type EmailStepGroup } from './email-step-statistics.js';

const group = (patch: Partial<EmailStepGroup>): EmailStepGroup => ({
  runStatus: 'succeeded',
  runError: null,
  messageStatus: 'sent',
  messageError: null,
  messageDetail: null,
  unsubscribed: false,
  count: 1,
  ...patch,
});

describe('emailSkipReason', () => {
  it.each([
    ['consent_required', null, 'no_consent'],
    ['consent_withdrawn', null, 'unsubscribed'],
    ['do_not_contact', 'channel', 'do_not_contact'],
    ['suppressed', 'unsubscribe', 'unsubscribed'],
    ['suppressed', 'complaint', 'complained'],
    ['suppressed', 'hard_bounce', 'bounced_before'],
    ['suppressed', 'invalid', 'bounced_before'],
    ['suppressed', 'manual', 'suppressed'],
    ['suppressed', null, 'suppressed'],
    ['no_email_address', null, 'no_email_address'],
    ['recipient_changed', null, 'no_email_address'],
    ['contact_inactive', null, 'contact_removed'],
    ['timing_unknown', null, 'no_time_zone'],
    ['mailbox_required', null, 'mailbox_unavailable'],
    ['mailbox_use_disabled', null, 'mailbox_unavailable'],
    ['unsubscribe_unavailable', null, 'unsubscribe_unavailable'],
  ])('%s (%s) is skipped as %s', (code, detail, reason) => {
    expect(emailSkipReason(code, detail)).toBe(reason);
  });

  it.each(['delivery_rejected', 'delivery_unknown', 'missing_values', 'template_unavailable'])(
    '%s is a failure',
    (code) => {
      expect(emailSkipReason(code, null)).toBeUndefined();
    },
  );

  it('has no reason for no code', () => {
    expect(emailSkipReason(null, null)).toBeUndefined();
  });
});

describe('countEmailStep', () => {
  it('counts nothing as nothing, and what is not measured as null', () => {
    expect(countEmailStep([])).toEqual({
      total: 0,
      waiting: 0,
      sent: 0,
      delivered: null,
      bounced: 0,
      failed: 0,
      skipped: { total: 0, reasons: [] },
      unsubscribed: 0,
      opened: null,
      clicked: null,
    });
  });

  it('sorts every way a visit ends', () => {
    const counts = countEmailStep([
      group({ count: 10 }),
      group({ messageStatus: 'delivered', count: 2 }),
      group({ messageStatus: 'read', unsubscribed: true, count: 1 }),
      group({ messageStatus: 'bounced', count: 3 }),
      group({ messageStatus: 'queued', count: 4 }),
      group({ messageStatus: 'sending', count: 1 }),
      group({ messageStatus: 'unknown', messageError: 'delivery_unknown', count: 2 }),
      group({ messageStatus: 'failed', messageError: 'delivery_rejected', count: 1 }),
      group({ messageStatus: 'failed', messageError: 'attachments_unavailable', count: 1 }),
      // Refused as it was about to leave: the contact unsubscribed after it was queued.
      group({ messageStatus: 'failed', messageError: 'consent_withdrawn', count: 2 }),
      group({
        messageStatus: 'failed',
        messageError: 'suppressed',
        messageDetail: 'complaint',
        count: 1,
      }),
      // Refused as the step ran.
      group({ runStatus: 'failed', runError: 'consent_required', messageStatus: null, count: 5 }),
      group({ runStatus: 'failed', runError: 'consent_withdrawn', messageStatus: null, count: 1 }),
      group({ runStatus: 'failed', runError: 'no_email_address', messageStatus: null, count: 2 }),
      group({ runStatus: 'failed', runError: 'missing_values', messageStatus: null, count: 3 }),
      group({ runStatus: 'failed', runError: null, messageStatus: null, count: 1 }),
      // A run that went on with no message it can show for it.
      group({ messageStatus: null, count: 1 }),
    ]);
    expect(counts).toEqual({
      total: 41,
      waiting: 5,
      sent: 16,
      delivered: null,
      bounced: 3,
      failed: 9,
      skipped: {
        total: 11,
        reasons: [
          { reason: 'no_consent', count: 5 },
          { reason: 'unsubscribed', count: 3 },
          { reason: 'no_email_address', count: 2 },
          { reason: 'complained', count: 1 },
        ],
      },
      unsubscribed: 1,
      opened: null,
      clicked: null,
    });
    expect(counts.waiting + counts.sent + counts.failed + counts.skipped.total).toBe(counts.total);
  });
});
