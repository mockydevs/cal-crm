import { describe, expect, it } from 'vitest';

import {
  bounceRateExceeded,
  CAMPAIGN_BOUNCE_PAUSE,
  campaignAllows,
  campaignDailyAllowance,
  campaignDailyCeiling,
  escapeHtml,
  hasUnsubscribeField,
  htmlMergeValues,
  htmlWithUnsubscribe,
  planRelease,
  recipientOutcome,
  skipReasonOfPolicy,
  textWithUnsubscribe,
  UNSUBSCRIBE_PLACEHOLDER,
  withUnsubscribeAddress,
  type ReleaseFacts,
} from './campaign-rules.js';

const mailbox = {
  dailyLimit: 1000,
  warmupEnabled: false,
  elapsedDays: 40,
  pacingPerMinute: 30,
  useForConversations: false,
  recentAll: 0,
  recentAutomated: 0,
  earliestReservationMs: null,
  inFlight: 0,
};
const start = new Date('2026-03-02T09:00:00Z');
const facts = (changes: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  now: start,
  startedAt: start,
  timeZone: 'America/New_York',
  batches: null,
  batchNumber: 0,
  batchReleased: 0,
  pending: 500,
  mailbox,
  businessLimit: null,
  businessReleased: 0,
  agencyLimit: null,
  agencyReleased: 0,
  ...changes,
});

describe('what a campaign takes in each status', () => {
  it('is edited and sent only as a draft, and held or stopped only once started', () => {
    expect(campaignAllows('draft', 'edit')).toBe(true);
    expect(campaignAllows('draft', 'send')).toBe(true);
    expect(campaignAllows('draft', 'pause')).toBe(false);
    expect(campaignAllows('scheduled', 'cancel')).toBe(true);
    expect(campaignAllows('scheduled', 'edit')).toBe(false);
    expect(campaignAllows('sending', 'pause')).toBe(true);
    expect(campaignAllows('sending', 'resume')).toBe(false);
    expect(campaignAllows('paused', 'resume')).toBe(true);
    expect(campaignAllows('paused', 'cancel')).toBe(true);
    for (const ended of ['sent', 'cancelled', 'failed'] as const)
      for (const action of ['edit', 'delete', 'send', 'pause', 'resume', 'cancel'] as const)
        expect(campaignAllows(ended, action)).toBe(false);
  });
});

describe('why a recipient is skipped', () => {
  it("names each of the policy's refusals, and nothing for a delay", () => {
    expect(skipReasonOfPolicy({ action: 'allow' })).toBeNull();
    expect(skipReasonOfPolicy({ action: 'defer', reason: 'quiet_hours' })).toBeNull();
    const refused = (reason: Parameters<typeof skipReasonOfPolicy>[0]) =>
      skipReasonOfPolicy(reason);
    expect(refused({ action: 'refuse', reason: 'consent_required' })).toBe('no_consent');
    expect(refused({ action: 'refuse', reason: 'consent_withdrawn' })).toBe('unsubscribed');
    expect(refused({ action: 'refuse', reason: 'do_not_contact' })).toBe('do_not_contact');
    expect(refused({ action: 'refuse', reason: 'do_not_contact', scope: 'channel' })).toBe(
      'do_not_contact',
    );
    expect(refused({ action: 'refuse', reason: 'contact_inactive' })).toBe('contact_removed');
    expect(refused({ action: 'refuse', reason: 'sender_inactive' })).toBe('mailbox_unavailable');
    expect(refused({ action: 'refuse', reason: 'timing_unknown' })).toBe('no_time_zone');
    for (const [suppression, reason] of [
      ['unsubscribe', 'unsubscribed'],
      ['complaint', 'complained'],
      ['hard_bounce', 'bounced'],
      ['invalid', 'bounced'],
      ['manual', 'suppressed'],
    ] as const)
      expect(
        refused({ action: 'refuse', reason: 'suppressed', suppressionReason: suppression }),
      ).toBe(reason);
  });

  it('reads what became of a released email from its message', () => {
    const of = (
      status: string,
      errorCode: string | null = null,
      errorDetail: string | null = null,
    ) => recipientOutcome({ status, errorCode, errorDetail });
    expect(of('queued')).toBeNull();
    expect(of('sending')).toBeNull();
    for (const status of ['sent', 'delivered', 'read', 'bounced'])
      expect(of(status)).toEqual({ status: 'sent', reason: null });
    expect(of('unknown', 'delivery_unknown')).toEqual({ status: 'failed', reason: null });
    expect(of('failed', 'delivery_rejected')).toEqual({ status: 'failed', reason: null });
    expect(of('failed')).toEqual({ status: 'failed', reason: null });
    expect(of('failed', 'consent_withdrawn')).toEqual({
      status: 'skipped',
      reason: 'unsubscribed',
    });
    expect(of('failed', 'suppressed', 'hard_bounce')).toEqual({
      status: 'skipped',
      reason: 'bounced',
    });
    expect(of('failed', 'suppressed', null)).toEqual({ status: 'skipped', reason: 'suppressed' });
    expect(of('failed', 'campaign_cancelled')).toEqual({ status: 'skipped', reason: 'cancelled' });
    expect(of('failed', 'recipient_changed')).toEqual({ status: 'skipped', reason: 'no_email' });
    expect(of('failed', 'mailbox_use_disabled')).toEqual({
      status: 'skipped',
      reason: 'mailbox_unavailable',
    });
    expect(of('failed', 'unsubscribe_unavailable')).toEqual({
      status: 'skipped',
      reason: 'unsubscribe_unavailable',
    });
    expect(of('failed', 'something_new')).toEqual({ status: 'skipped', reason: 'refused' });
  });
});

describe('the bounce pause', () => {
  it('needs enough sent emails, and five in a hundred of them back', () => {
    expect(CAMPAIGN_BOUNCE_PAUSE).toEqual({ percent: 5, afterSent: 100 });
    expect(bounceRateExceeded(99, 99)).toBe(false);
    expect(bounceRateExceeded(100, 4)).toBe(false);
    expect(bounceRateExceeded(100, 5)).toBe(true);
    expect(bounceRateExceeded(1000, 49)).toBe(false);
    expect(bounceRateExceeded(1000, 50)).toBe(true);
  });
});

describe('the daily ceiling', () => {
  it('keeps a fifth of a shared mailbox back for conversations, and stays inside warm-up', () => {
    expect(campaignDailyAllowance(mailbox)).toBe(1000);
    expect(campaignDailyAllowance({ ...mailbox, useForConversations: true })).toBe(800);
    expect(campaignDailyAllowance({ ...mailbox, warmupEnabled: true, elapsedDays: 0 })).toBe(50);
    expect(campaignDailyAllowance({ ...mailbox, dailyLimit: 1, useForConversations: true })).toBe(
      0,
    );
    expect(campaignDailyCeiling(mailbox, null, null)).toBe(1000);
    expect(campaignDailyCeiling(mailbox, 300, null)).toBe(300);
    expect(campaignDailyCeiling(mailbox, 300, 120)).toBe(120);
    expect(campaignDailyCeiling({ ...mailbox, useForConversations: true }, 5000, null)).toBe(800);
  });
});

describe('how many may be released now', () => {
  it('releases a minute of the mailbox pace at a time, and no more than are pending', () => {
    expect(planRelease(facts())).toEqual({
      batchNumber: 1,
      batchReleased: 0,
      release: 30,
      wait: null,
    });
    expect(planRelease(facts({ pending: 4 })).release).toBe(4);
    expect(planRelease(facts({ mailbox: { ...mailbox, inFlight: 12 } })).release).toBe(18);
    expect(planRelease(facts({ mailbox: { ...mailbox, inFlight: 30 } }))).toMatchObject({
      release: 0,
      wait: { reason: 'mailbox_pacing', until: null },
    });
  });

  it('waits for the mailbox day, the warm-up and the ceilings, in that order', () => {
    const earliest = start.getTime() - 3_600_000;
    expect(
      planRelease(
        facts({ mailbox: { ...mailbox, recentAll: 1000, earliestReservationMs: earliest } }),
      ),
    ).toMatchObject({
      release: 0,
      wait: { reason: 'mailbox_daily_limit', until: new Date(earliest + 86_400_000) },
    });
    // A mailbox that also carries conversations stops 200 short of its limit.
    expect(
      planRelease(facts({ mailbox: { ...mailbox, useForConversations: true, recentAll: 800 } }))
        .wait,
    ).toEqual({ reason: 'mailbox_daily_limit', until: null });
    expect(
      planRelease(facts({ mailbox: { ...mailbox, useForConversations: true, recentAll: 790 } }))
        .release,
    ).toBe(10);
    expect(
      planRelease(
        facts({
          mailbox: { ...mailbox, warmupEnabled: true, elapsedDays: 0, recentAutomated: 50 },
        }),
      ).wait,
    ).toEqual({ reason: 'mailbox_warmup_limit', until: null });
    expect(
      planRelease(
        facts({
          mailbox: { ...mailbox, warmupEnabled: true, elapsedDays: 0, recentAutomated: 45 },
        }),
      ).release,
    ).toBe(5);
    expect(planRelease(facts({ businessLimit: 100, businessReleased: 100 })).wait).toEqual({
      reason: 'business_daily_limit',
      until: null,
    });
    expect(planRelease(facts({ businessLimit: 100, businessReleased: 93 })).release).toBe(7);
    // Without a ceiling of its own a business has the mailbox's daily limit.
    expect(planRelease(facts({ businessReleased: 1000 })).wait?.reason).toBe(
      'business_daily_limit',
    );
    expect(planRelease(facts({ agencyLimit: 50, agencyReleased: 50 })).wait).toEqual({
      reason: 'agency_daily_limit',
      until: null,
    });
    expect(planRelease(facts({ agencyLimit: 50, agencyReleased: 48 })).release).toBe(2);
  });

  it('releases a batch, then waits for the next one to be due', () => {
    const batches = { size: 20, every: 2, unit: 'hours' as const, window: null };
    expect(planRelease(facts({ batches }))).toEqual({
      batchNumber: 1,
      batchReleased: 0,
      release: 20,
      wait: null,
    });
    expect(planRelease(facts({ batches, batchNumber: 1, batchReleased: 15 })).release).toBe(5);
    expect(planRelease(facts({ batches, batchNumber: 1, batchReleased: 20 }))).toEqual({
      batchNumber: 1,
      batchReleased: 20,
      release: 0,
      wait: { reason: 'batch_interval', until: new Date('2026-03-02T11:00:00Z') },
    });
    // Two hours on, the second batch begins; the third is due four hours after the start.
    expect(
      planRelease(
        facts({
          batches,
          batchNumber: 1,
          batchReleased: 20,
          now: new Date('2026-03-02T11:00:00Z'),
        }),
      ),
    ).toEqual({ batchNumber: 2, batchReleased: 0, release: 20, wait: null });
    expect(
      planRelease(
        facts({
          batches,
          batchNumber: 2,
          batchReleased: 20,
          now: new Date('2026-03-02T12:59:00Z'),
        }),
      ).wait,
    ).toEqual({ reason: 'batch_interval', until: new Date('2026-03-02T13:00:00Z') });
  });

  it('keeps daily batches at the same local time across a clock change, inside the window', () => {
    // New York: clocks go forward on 8 March 2026. The start is 09:00 local on the 6th.
    const startedAt = new Date('2026-03-06T14:00:00Z');
    const batches = {
      size: 10,
      every: 1,
      unit: 'days' as const,
      window: { from: '09:00', to: '17:00' },
    };
    const at = (now: string, batchNumber: number) =>
      planRelease(
        facts({ batches, startedAt, now: new Date(now), batchNumber, batchReleased: 10 }),
      );
    expect(at('2026-03-06T15:00:00Z', 1).wait).toEqual({
      reason: 'batch_interval',
      until: new Date('2026-03-07T14:00:00Z'),
    });
    // The third batch is at 09:00 local on the 8th, which is 13:00 UTC after the change.
    expect(at('2026-03-07T15:00:00Z', 2).wait).toEqual({
      reason: 'batch_interval',
      until: new Date('2026-03-08T13:00:00Z'),
    });
    expect(at('2026-03-08T13:00:00Z', 2)).toMatchObject({ batchNumber: 3, release: 10 });
    // Outside the window nothing leaves, and it says when the window opens.
    expect(
      planRelease(
        facts({
          batches,
          startedAt,
          now: new Date('2026-03-06T23:30:00Z'),
          batchNumber: 1,
          batchReleased: 4,
        }),
      ),
    ).toEqual({
      batchNumber: 1,
      batchReleased: 4,
      release: 0,
      wait: { reason: 'window', until: new Date('2026-03-07T14:00:00Z') },
    });
  });
});

describe('the content as it is sent', () => {
  it('escapes merge values for HTML and leaves empty ones empty', () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;',
    );
    expect(
      htmlMergeValues({
        a: '<b>',
        n: 4,
        yes: true,
        tags: ['x', '<y>'],
        none: null,
        gone: undefined,
      }),
    ).toEqual({
      a: '&lt;b&gt;',
      n: '4',
      yes: 'true',
      tags: 'x, &lt;y&gt;',
      none: null,
      gone: undefined,
    });
  });

  it('shows an unsubscribe link in every body: the author’s own, or a line at the end', () => {
    expect(hasUnsubscribeField('Leave: {{ email.unsubscribe_link }}')).toBe(true);
    expect(hasUnsubscribeField('Leave: {{email.unsubscribe}}')).toBe(false);
    expect(textWithUnsubscribe('Hello\n\n')).toBe(
      'Hello\n\n--\nUnsubscribe: {{email.unsubscribe_link}}\n',
    );
    expect(textWithUnsubscribe('Bye {{email.unsubscribe_link}}')).toBe(
      'Bye {{email.unsubscribe_link}}',
    );
    const line =
      '<p style="font-size:12px;color:#666666"><a href="{{email.unsubscribe_link}}">Unsubscribe</a></p>';
    expect(htmlWithUnsubscribe('<p>Hi</p>', null)).toBe(`<p>Hi</p>${line}`);
    expect(htmlWithUnsubscribe('<html><BODY class="x"><p>Hi</p></BODY></html>', null)).toBe(
      `<html><BODY class="x"><p>Hi</p>${line}</BODY></html>`,
    );
    const own = '<a href="{{email.unsubscribe_link}}">Leave</a>';
    expect(htmlWithUnsubscribe(own, null)).toBe(own);
    const hidden =
      '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">A &amp; B</div>';
    expect(htmlWithUnsubscribe(own, 'A & B')).toBe(`${hidden}${own}`);
    expect(htmlWithUnsubscribe(`<body>${own}</body>`, 'A & B')).toBe(
      `<body>${hidden}${own}</body>`,
    );
  });

  it('puts the recipient’s address wherever the body was waiting for it', () => {
    expect(
      withUnsubscribeAddress(
        `Leave: ${UNSUBSCRIBE_PLACEHOLDER} or ${UNSUBSCRIBE_PLACEHOLDER}`,
        'https://crm.example/unsubscribe/abc',
      ),
    ).toBe('Leave: https://crm.example/unsubscribe/abc or https://crm.example/unsubscribe/abc');
    expect(withUnsubscribeAddress('Nothing to place', 'https://crm.example/u')).toBe(
      'Nothing to place',
    );
  });
});

describe('the postal address in a campaign footer', () => {
  const line = 'Bluebird Dental, 12 High St, Austin, TX 78701, US';
  it('ends the text with the address, and the unsubscribe line unless the body has one', () => {
    expect(textWithUnsubscribe('Hello\n', line)).toBe(
      `Hello\n\n--\n${line}\nUnsubscribe: {{email.unsubscribe_link}}\n`,
    );
    expect(textWithUnsubscribe('Bye {{email.unsubscribe_link}}', line)).toBe(
      `Bye {{email.unsubscribe_link}}\n\n--\n${line}\n`,
    );
  });

  it('ends the HTML with the address, escaped, and a visible link unless one is shown', () => {
    expect(htmlWithUnsubscribe('<p>Hi</p>', null, 'A & B, 1 St')).toBe(
      '<p>Hi</p><p style="font-size:12px;color:#666666">A &amp; B, 1 St<br><a href="{{email.unsubscribe_link}}">Unsubscribe</a></p>',
    );
    const own = '<p><a href="{{email.unsubscribe_link}}">Leave</a></p>';
    expect(htmlWithUnsubscribe(own, null, line)).toBe(
      `${own}<p style="font-size:12px;color:#666666">${line}</p>`,
    );
    // An own link that is hidden is not one: the visible line is added.
    const hidden = '<p style="display:none"><a href="{{email.unsubscribe_link}}">Leave</a></p>';
    expect(htmlWithUnsubscribe(hidden, null)).toContain(
      '<a href="{{email.unsubscribe_link}}">Unsubscribe</a></p>',
    );
  });
});
