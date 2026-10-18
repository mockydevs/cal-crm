// @vitest-environment jsdom
import { i18n, type MessageDescriptor } from '@lingui/core';
import {
  campaignBatches,
  emailCampaignCheckCodes,
  emailCampaignRecipientStatuses,
  emailCampaignSkipReasons,
  emailCampaignStatuses,
  emailCampaignStatusReasons,
  emailCampaignWaitReasons,
  updateEmailCampaignInput,
  type EmailCampaignCheck,
} from '@repo/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import { campaignId, campaignOf, mailboxId, tagId, viewId } from '../../e2e/campaigns-fixtures';
import {
  allowed,
  audienceSentence,
  batchesOf,
  batchesSentence,
  cancelConsequence,
  checkPlace,
  checkSentence,
  checkWords,
  estimateSentence,
  folderDestinations,
  folderLabels,
  inputOfInstant,
  instantOfInput,
  looksLikeEmail,
  momentIn,
  progressOf,
  recipientStatusWords,
  rowActions,
  rowMoment,
  scheduleProblem,
  sendEstimate,
  skipReasonWords,
  sortedChecks,
  startingBatches,
  statusFilters,
  statusFilterWords,
  statusLine,
  statusReasonWords,
  statusTones,
  statusWords,
  testRecipients,
  waitingLine,
} from './rules';
import {
  bodyOf,
  draftOf,
  draftProblems,
  sameDraft,
  textPartOfDraft,
  type CampaignDraft,
} from './draft';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});

const zone = 'America/Chicago';
const said = (descriptor: MessageDescriptor): string => i18n._(descriptor);

describe('every word of the contract has words here', () => {
  it('names every status, its tone and its filter', () => {
    for (const status of emailCampaignStatuses) {
      expect(said(statusWords[status])).not.toBe('');
      expect(statusTones[status]).toBeDefined();
      expect(statusFilters).toContain(status);
      expect(said(statusFilterWords[status])).not.toBe('');
    }
    expect(statusFilters[0]).toBe('all');
    expect(said(statusFilterWords.all)).toBe('All');
  });

  it('says what happened and what to do for every reason a campaign pauses or fails', () => {
    expect(Object.keys(statusReasonWords).sort()).toEqual([...emailCampaignStatusReasons].sort());
    for (const reason of emailCampaignStatusReasons) {
      expect(said(statusReasonWords[reason].what)).toMatch(/\.$/);
      expect(said(statusReasonWords[reason].todo)).toMatch(/\.$/);
    }
  });

  it('words every reason a contact gets nothing, with what to do about it', () => {
    // A reason the contract gains and this file does not word fails here.
    expect(Object.keys(skipReasonWords).sort()).toEqual([...emailCampaignSkipReasons].sort());
    const labels = new Set<string>();
    for (const reason of emailCampaignSkipReasons) {
      const label = said(skipReasonWords[reason].label);
      expect(label).not.toBe('');
      expect(label).not.toContain('_');
      expect(said(skipReasonWords[reason].todo)).toMatch(/\.$/);
      labels.add(label);
    }
    expect(labels.size).toBe(emailCampaignSkipReasons.length);
  });

  it('words every check code', () => {
    // A check the contract gains and this file does not word fails here.
    expect(Object.keys(checkWords).sort()).toEqual([...emailCampaignCheckCodes].sort());
    for (const code of emailCampaignCheckCodes) {
      const sentence = checkSentence({ code, severity: 'blocking', message: 'server words' });
      expect(sentence).not.toBe('server words');
      expect(sentence).toMatch(/\.$/);
    }
  });

  it('names every recipient state', () => {
    for (const status of emailCampaignRecipientStatuses)
      expect(said(recipientStatusWords[status])).not.toBe('');
  });

  it('says why a send waits, for every reason, with and without a time', () => {
    for (const reason of emailCampaignWaitReasons) {
      const base = { status: 'sending' as const, timeZone: zone };
      const open = waitingLine({ ...base, waiting: { reason, until: null } });
      const timed = waitingLine({
        ...base,
        waiting: { reason, until: '2026-10-15T14:00:00.000Z' },
      });
      expect(open).toMatch(/\.$/);
      expect(timed).toContain('Oct 15, 2026, 9:00 AM');
      expect(timed).not.toBe(open);
    }
  });
});

describe('status and waiting', () => {
  it('says why a campaign is paused or failed', () => {
    expect(statusLine({ status: 'paused', statusReason: 'bounce_rate' })).toBe(
      'It paused itself: too many of its emails bounced.',
    );
    expect(statusLine({ status: 'paused', statusReason: null })).toBe('Paused by a person.');
    expect(statusLine({ status: 'failed', statusReason: null })).toBe('It could not be sent.');
    expect(statusLine({ status: 'failed', statusReason: 'audience_empty' })).toBe(
      'Nobody in its audience could be sent the email.',
    );
    expect(statusLine({ status: 'sending', statusReason: null })).toBeUndefined();
  });

  it('says the mailbox limit and the time it goes on, in the business time zone', () => {
    expect(
      waitingLine({
        status: 'sending',
        timeZone: zone,
        waiting: { reason: 'mailbox_daily_limit', until: '2026-10-15T05:00:00.000Z' },
      }),
    ).toBe("Waiting until Oct 15, 2026, 12:00 AM because the mailbox's daily limit is reached.");
  });

  it('says nothing when nothing waits, or when it is not sending', () => {
    expect(waitingLine({ status: 'sending', timeZone: zone, waiting: null })).toBeUndefined();
    expect(
      waitingLine({
        status: 'paused',
        timeZone: zone,
        waiting: { reason: 'window', until: null },
      }),
    ).toBeUndefined();
  });

  it('writes a moment on the business clock, and on the browser clock for an unknown zone', () => {
    expect(momentIn('2026-10-14T14:30:00.000Z', zone)).toBe('Oct 14, 2026, 9:30 AM');
    expect(momentIn(new Date('2026-10-14T14:30:00.000Z'), 'Africa/Nairobi')).toBe(
      'Oct 14, 2026, 5:30 PM',
    );
    expect(momentIn('2026-10-14T14:30:00.000Z', 'Not/AZone')).toContain('2026');
  });
});

describe('an audience as a sentence', () => {
  const names = {
    views: new Map([[viewId(1), 'Newsletter readers']]),
    tags: new Map([
      [tagId(1), 'Promo'],
      [tagId(2), 'VIP'],
    ]),
  };
  const unread = { views: undefined, tags: undefined };

  it('says each kind', () => {
    expect(audienceSentence(null, names)).toBe('No audience chosen');
    expect(audienceSentence({ kind: 'all' }, names)).toBe('Every contact');
    expect(audienceSentence({ kind: 'smart_list', viewId: viewId(1) }, names)).toBe(
      'Smart list: Newsletter readers',
    );
    expect(audienceSentence({ kind: 'tags', tagIds: [tagId(1)], match: 'any' }, names)).toBe(
      'Contacts tagged Promo',
    );
    expect(
      audienceSentence({ kind: 'tags', tagIds: [tagId(1), tagId(2)], match: 'any' }, names),
    ).toBe('Contacts with any of these tags: Promo, VIP');
    expect(
      audienceSentence({ kind: 'tags', tagIds: [tagId(1), tagId(2)], match: 'all' }, names),
    ).toBe('Contacts with all of these tags: Promo, VIP');
  });

  it('says so when a list or a tag is gone, and stays honest before names are read', () => {
    expect(audienceSentence({ kind: 'smart_list', viewId: viewId(9) }, names)).toBe(
      'A smart list that is gone',
    );
    expect(audienceSentence({ kind: 'tags', tagIds: [tagId(9)], match: 'any' }, names)).toBe(
      'Contacts tagged a tag that is gone',
    );
    expect(audienceSentence({ kind: 'smart_list', viewId: viewId(1) }, unread)).toBe(
      'A smart list',
    );
    expect(audienceSentence({ kind: 'tags', tagIds: [tagId(1)], match: 'any' }, unread)).toBe(
      'Contacts with 1 tag',
    );
    expect(
      audienceSentence({ kind: 'tags', tagIds: [tagId(1), tagId(2)], match: 'all' }, unread),
    ).toBe('Contacts with 2 tags');
  });

  it('counts the conditions of a filter', () => {
    const condition = { field: 'email', operator: 'is_not_empty' as const };
    expect(
      audienceSentence(
        {
          kind: 'filter',
          filter: { match: 'all', groups: [{ match: 'all', conditions: [condition] }] },
        },
        names,
      ),
    ).toBe('Contacts matching a filter with 1 condition');
    expect(
      audienceSentence(
        {
          kind: 'filter',
          filter: {
            match: 'any',
            groups: [
              { match: 'all', conditions: [condition, condition] },
              { match: 'all', conditions: [condition] },
            ],
          },
        },
        names,
      ),
    ).toBe('Contacts matching a filter with 3 conditions');
  });
});

describe('checks', () => {
  const check = (patch: Partial<EmailCampaignCheck> & Pick<EmailCampaignCheck, 'code'>) =>
    ({ severity: 'warning', message: 'server words', ...patch }) satisfies EmailCampaignCheck;

  it('puts blocking items first, then warnings, then notes, in the server order', () => {
    const sorted = sortedChecks([
      check({ code: 'unsubscribe_line_added', severity: 'info' }),
      check({ code: 'subject_long' }),
      check({ code: 'mailbox_missing', severity: 'blocking' }),
      check({ code: 'postal_address_missing' }),
      check({ code: 'audience_missing', severity: 'blocking' }),
    ]);
    expect(sorted.map((item) => item.code)).toEqual([
      'mailbox_missing',
      'audience_missing',
      'subject_long',
      'postal_address_missing',
      'unsubscribe_line_added',
    ]);
  });

  it('fills the numbers, fields and check names the server gives', () => {
    expect(checkSentence(check({ code: 'spread_over_days', count: 500, days: 3 }))).toBe(
      'At most 500 campaign emails can leave this mailbox in a day now, so this send will take about 3 days.',
    );
    expect(checkSentence(check({ code: 'spread_over_days' }))).toContain('about 2 days');
    expect(checkSentence(check({ code: 'subject_long', count: 72 }))).toContain('72 characters');
    expect(checkSentence(check({ code: 'some_will_not_receive', count: 310 }))).toBe(
      '310 contacts in the audience will not get it. The audience preview says why.',
    );
    expect(checkSentence(check({ code: 'some_will_not_receive', count: 1 }))).toContain(
      '1 contact in the audience',
    );
    expect(checkSentence(check({ code: 'some_will_not_receive' }))).toContain('0 contacts');
    expect(checkSentence(check({ code: 'audience_too_large', count: 100_000 }))).toContain(
      '100,000 contacts',
    );
    expect(checkSentence(check({ code: 'audience_too_large' }))).toContain('100,000 contacts');
    expect(
      checkSentence(check({ code: 'unfillable_merge_fields', fields: ['contact.nickname'] })),
    ).toContain('{{contact.nickname}}');
    expect(checkSentence(check({ code: 'unfillable_merge_fields' }))).toContain(
      'a merge field no contact has a value for',
    );
    expect(checkSentence(check({ code: 'mailbox_check_failing', check: 'dkim' }))).toBe(
      'The mailbox fails its DKIM check. The fix is in Settings → Email Services.',
    );
    expect(checkSentence(check({ code: 'mailbox_check_failing', check: 'unsubscribe' }))).toContain(
      'its Unsubscribe check',
    );
    expect(checkSentence(check({ code: 'mailbox_check_failing' }))).toContain(
      'one of its setup checks',
    );
    expect(checkSentence(check({ code: 'mailbox_check_unknown', check: 'spf' }))).toContain(
      'The SPF check could not be confirmed',
    );
    expect(checkSentence(check({ code: 'mailbox_check_unknown', check: 'dmarc' }))).toContain(
      'DMARC',
    );
    expect(checkSentence(check({ code: 'mailbox_check_unknown' }))).toContain(
      "One of the mailbox's setup checks",
    );
  });

  it('says where each check is put right', () => {
    expect(checkPlace(check({ code: 'postal_address_missing' }))).toBe('business-profile');
    expect(checkPlace(check({ code: 'mailbox_not_for_campaigns' }))).toBe('email-settings');
    expect(checkPlace(check({ code: 'subject_missing' }))).toBe('details');
    expect(checkPlace(check({ code: 'body_missing' }))).toBe('content');
    expect(checkPlace(check({ code: 'audience_missing' }))).toBe('audience');
    expect(checkPlace(check({ code: 'unsubscribe_unavailable' }))).toBeUndefined();
  });

  it('keeps the server words for a code a newer server sends', () => {
    const unknown = { code: 'future_check', severity: 'info', message: 'Server words.' };
    expect(checkSentence(unknown as unknown as EmailCampaignCheck)).toBe('Server words.');
    expect(checkPlace(unknown as unknown as EmailCampaignCheck)).toBeUndefined();
  });
});

describe('what a person may do', () => {
  const owner = { canManage: true, canSend: true };
  const member = { canManage: true, canSend: false };
  const reader = { canManage: false, canSend: false };

  it('lets a member draft and not send', () => {
    expect(allowed('draft', 'edit', member)).toBe(true);
    expect(allowed('draft', 'delete', member)).toBe(true);
    expect(allowed('draft', 'send', member)).toBe(false);
    expect(allowed('draft', 'schedule', member)).toBe(false);
    expect(allowed('sending', 'pause', member)).toBe(false);
    expect(allowed('draft', 'send', owner)).toBe(true);
    expect(allowed('sending', 'pause', owner)).toBe(true);
    expect(allowed('paused', 'resume', owner)).toBe(true);
    expect(allowed('scheduled', 'cancel', owner)).toBe(true);
  });

  it('offers only what the status takes', () => {
    expect(allowed('sent', 'cancel', owner)).toBe(false);
    expect(allowed('sending', 'edit', owner)).toBe(false);
    expect(allowed('paused', 'pause', owner)).toBe(false);
    expect(allowed('draft', 'edit', reader)).toBe(false);
  });

  it('builds a row menu by status and role: a draft is edited, a send paused or resumed', () => {
    expect(rowActions('draft', owner)).toEqual(['edit', 'duplicate', 'move', 'delete']);
    expect(rowActions('scheduled', owner)).toEqual(['open', 'duplicate', 'move', 'cancel']);
    expect(rowActions('sending', owner)).toEqual(['open', 'duplicate', 'move', 'pause', 'cancel']);
    expect(rowActions('paused', owner)).toEqual(['open', 'duplicate', 'move', 'resume', 'cancel']);
    expect(rowActions('sent', owner)).toEqual(['open', 'duplicate', 'move']);
    expect(rowActions('sending', member)).toEqual(['open', 'duplicate', 'move']);
    expect(rowActions('draft', reader)).toEqual(['open']);
  });

  it('tells the truth about cancelling', () => {
    expect(cancelConsequence('scheduled')).toContain('becomes a draft again');
    expect(cancelConsequence('sending')).toContain('cannot be resumed');
    expect(cancelConsequence('paused')).toContain('cannot be resumed');
  });

  it('chooses the moment a row shows', () => {
    const row = { status: 'draft', schedule: null, startedAt: null, finishedAt: null } as const;
    expect(rowMoment(row)).toBeUndefined();
    expect(
      rowMoment({
        ...row,
        status: 'scheduled',
        schedule: { sendAt: '2026-10-20T15:00:00.000Z', batches: null },
      }),
    ).toEqual({ kind: 'due', at: '2026-10-20T15:00:00.000Z' });
    expect(
      rowMoment({ ...row, status: 'scheduled', schedule: { sendAt: null, batches: null } }),
    ).toBeUndefined();
    expect(rowMoment({ ...row, status: 'sending', startedAt: '2026-10-14T09:00:00.000Z' })).toEqual(
      {
        kind: 'started',
        at: '2026-10-14T09:00:00.000Z',
      },
    );
    expect(
      rowMoment({
        ...row,
        status: 'sent',
        startedAt: '2026-10-14T09:00:00.000Z',
        finishedAt: '2026-10-14T11:00:00.000Z',
      }),
    ).toEqual({ kind: 'finished', at: '2026-10-14T11:00:00.000Z' });
  });

  it('measures how far a send is', () => {
    expect(
      progressOf({ audience: 200, pending: 90, queued: 10, sent: 80, skipped: 15, failed: 5 }),
    ).toEqual({ done: 100, percent: 50 });
    expect(
      progressOf({ audience: 0, pending: 0, queued: 0, sent: 0, skipped: 0, failed: 0 }),
    ).toEqual({ done: 0, percent: 0 });
    expect(
      progressOf({ audience: 10, pending: 0, queued: 0, sent: 12, skipped: 0, failed: 0 }).percent,
    ).toBe(100);
  });
});

describe('the draft', () => {
  const formatted = campaignOf(1, {
    name: 'Spring open day',
    mailboxId: mailboxId(1),
    fromName: 'Calari',
    replyTo: 'hello@calari.example',
    subject: 'Come to our open day',
    preheader: 'Doors open at ten',
    content: {
      format: 'html',
      html: '<p>Hello {{contact.firstName}}</p>',
      text: 'Hello {{contact.firstName}}',
    },
    audience: { kind: 'all' },
  });

  it('opens a stored campaign and saves it back unchanged', () => {
    const draft = draftOf(formatted);
    expect(draft.ownText).toBe(false);
    const body = bodyOf(draft, formatted.revision);
    expect(updateEmailCampaignInput.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      revision: 1,
      name: 'Spring open day',
      fromName: 'Calari',
      replyTo: 'hello@calari.example',
      preheader: 'Doors open at ten',
      content: { format: 'html', text: 'Hello {{contact.firstName}}' },
      audience: { kind: 'all' },
    });
  });

  it('keeps a plain-text part the author wrote themselves', () => {
    const own = draftOf(
      campaignOf(2, {
        content: { format: 'html', html: '<p>Hello</p>', text: 'A different text' },
      }),
    );
    expect(own.ownText).toBe(true);
    expect(textPartOfDraft(own)).toBe('A different text');
    expect(textPartOfDraft({ ...own, text: '  ' })).toBe('Hello');
    expect(textPartOfDraft({ ...own, ownText: false })).toBe('Hello');
  });

  it('sends empty boxes as null and a plain-text email without a preview line', () => {
    const plain = draftOf(
      campaignOf(3, { name: 'Plain', content: { format: 'text', text: 'Hi' } }),
    );
    expect(plain.html).toBeUndefined();
    expect(textPartOfDraft(plain)).toBe('Hi');
    const body = bodyOf({ ...plain, preheader: 'ignored', fromName: '  ', replyTo: '' }, 4);
    expect(body).toMatchObject({
      revision: 4,
      fromName: null,
      replyTo: null,
      preheader: null,
      content: { format: 'text', text: 'Hi' },
      audience: null,
    });
    expect(updateEmailCampaignInput.safeParse(body).success).toBe(true);
    expect(bodyOf({ ...draftOf(formatted), preheader: ' ' }, 1).preheader).toBeNull();
  });

  it('knows when two drafts are the same to save', () => {
    const draft = draftOf(formatted);
    expect(sameDraft(draft, { ...draft, name: 'Spring open day ' })).toBe(true);
    expect(sameDraft(draft, { ...draft, subject: 'Another' })).toBe(false);
  });

  it('says what the API would refuse, by box', () => {
    const draft: CampaignDraft = draftOf(formatted);
    expect(draftProblems(draft)).toEqual({});
    expect(draftProblems({ ...draft, name: ' ' }).name).toBe('Give the campaign a name.');
    expect(draftProblems({ ...draft, name: 'n'.repeat(121) }).name).toBe(
      'Use at most 120 characters.',
    );
    expect(draftProblems({ ...draft, fromName: 'f'.repeat(121) }).fromName).toBeDefined();
    expect(draftProblems({ ...draft, replyTo: 'not an address' }).replyTo).toBe(
      'Give one email address, such as hello@example.com.',
    );
    expect(draftProblems({ ...draft, subject: 's'.repeat(256) }).subject).toBeDefined();
    expect(draftProblems({ ...draft, preheader: 'p'.repeat(151) }).preheader).toBeDefined();
    expect(
      draftProblems({ ...draft, html: undefined, preheader: 'p'.repeat(151) }).preheader,
    ).toBeUndefined();
    expect(
      draftProblems({ ...draft, audience: { kind: 'tags', tagIds: [], match: 'any' } }).audience,
    ).toBe('Choose at least one tag.');
    expect(
      draftProblems({ ...draft, audience: { kind: 'tags', tagIds: [tagId(1)], match: 'any' } })
        .audience,
    ).toBeUndefined();
  });

  it('reads an email address near enough', () => {
    expect(looksLikeEmail(' hello@example.com ')).toBe(true);
    expect(looksLikeEmail('hello@example')).toBe(false);
    expect(looksLikeEmail('a b@example.com')).toBe(false);
  });
});

describe('a test send', () => {
  it('goes to me, and to named addresses for someone who may send', () => {
    expect(testRecipients(true, '', false)).toEqual({ to: ['me'] });
    expect(testRecipients(true, 'ada@example.com, ben@example.com\nada@example.com', true)).toEqual(
      {
        to: ['me', 'ada@example.com', 'ben@example.com'],
      },
    );
  });

  it('says what is wrong', () => {
    expect(testRecipients(true, 'ada@example.com', false).problem).toBe(
      'Your role can send a test to yourself only.',
    );
    expect(testRecipients(false, '', true).problem).toBe('Choose where the test goes.');
    expect(testRecipients(false, 'ada', true).problem).toBe('“ada” is not an email address.');
    expect(testRecipients(true, 'a@x.io b@x.io c@x.io d@x.io e@x.io', true).problem).toBe(
      'A test goes to at most 5 addresses.',
    );
    expect(
      testRecipients(false, 'a@x.io b@x.io c@x.io d@x.io e@x.io', true).problem,
    ).toBeUndefined();
  });
});

describe('scheduling on the business clock', () => {
  it('reads and writes a date-and-time box in the business time zone', () => {
    const instant = new Date('2026-10-14T14:00:00.000Z');
    expect(inputOfInstant(instant, zone)).toBe('2026-10-14T09:00');
    expect(instantOfInput('2026-10-14T09:00', zone)?.toISOString()).toBe(instant.toISOString());
    expect(instantOfInput('2026-10-14T17:00', 'Africa/Nairobi')?.toISOString()).toBe(
      instant.toISOString(),
    );
    expect(instantOfInput('', zone)).toBeUndefined();
    expect(instantOfInput('tomorrow', zone)).toBeUndefined();
  });

  it('refuses no time, a past time and one more than a year ahead', () => {
    const now = new Date('2026-10-14T14:00:00.000Z');
    expect(scheduleProblem(undefined, now)).toBe('Choose a date and a time.');
    expect(scheduleProblem(new Date('2026-10-14T13:59:00.000Z'), now)).toBe(
      'Choose a time that is still ahead.',
    );
    expect(scheduleProblem(new Date('2027-10-20T14:00:00.000Z'), now)).toBe(
      'Choose a time within a year.',
    );
    expect(scheduleProblem(new Date('2026-10-15T14:00:00.000Z'), now)).toBeUndefined();
  });

  it('takes batches the contract takes, and says what is wrong with the rest', () => {
    const good = batchesOf(startingBatches);
    expect(good.batches).toEqual({ size: 500, every: 1, unit: 'days', window: null });
    expect(campaignBatches.safeParse(good.batches).success).toBe(true);
    const windowed = batchesOf({ ...startingBatches, windowed: true });
    expect(windowed.batches?.window).toEqual({ from: '09:00', to: '17:00' });
    expect(campaignBatches.safeParse(windowed.batches).success).toBe(true);

    expect(batchesOf({ ...startingBatches, size: '0' }).problems?.size).toContain('from 1 to');
    expect(batchesOf({ ...startingBatches, size: 'many' }).problems?.size).toBeDefined();
    expect(batchesOf({ ...startingBatches, size: '100001' }).problems?.size).toBeDefined();
    expect(batchesOf({ ...startingBatches, every: '' }).problems?.every).toBe(
      'Give a whole number, 1 or more.',
    );
    expect(batchesOf({ ...startingBatches, every: '0' }).problems?.every).toBeDefined();
    expect(batchesOf({ ...startingBatches, unit: 'minutes', every: '4' }).problems?.every).toBe(
      'Leave at least 5 minutes between batches.',
    );
    expect(
      batchesOf({ ...startingBatches, unit: 'minutes', every: '1441' }).problems?.every,
    ).toContain('1,440 minutes');
    expect(batchesOf({ ...startingBatches, unit: 'minutes', every: '5' }).batches?.every).toBe(5);
    expect(batchesOf({ ...startingBatches, unit: 'hours', every: '721' }).problems?.every).toBe(
      'Leave at most 720 hours between batches.',
    );
    expect(batchesOf({ ...startingBatches, unit: 'hours', every: '2' }).batches?.unit).toBe(
      'hours',
    );
    expect(batchesOf({ ...startingBatches, every: '31' }).problems?.every).toBe(
      'Leave at most 30 days between batches.',
    );
    expect(
      batchesOf({ ...startingBatches, windowed: true, from: '09:00', to: '09:00' }).problems
        ?.window,
    ).toBe('The window must open and close at different times.');
    expect(
      batchesOf({ ...startingBatches, windowed: true, from: '', to: '17:00' }).problems?.window,
    ).toBe('Give both ends of the window as times of day.');
  });

  it('says batches as a phrase', () => {
    expect(batchesSentence({ size: 500, every: 1, unit: 'days', window: null })).toBe(
      '500 emails every day',
    );
    expect(batchesSentence({ size: 1000, every: 2, unit: 'days', window: null })).toBe(
      '1,000 emails every 2 days',
    );
    expect(batchesSentence({ size: 50, every: 1, unit: 'hours', window: null })).toBe(
      '50 emails every hour',
    );
    expect(
      batchesSentence({
        size: 50,
        every: 3,
        unit: 'hours',
        window: { from: '09:00', to: '17:00' },
      }),
    ).toBe('50 emails every 3 hours, between 09:00 and 17:00');
    expect(batchesSentence({ size: 20, every: 30, unit: 'minutes', window: null })).toBe(
      '20 emails every 30 minutes',
    );
    expect(batchesSentence({ size: 20, every: 1, unit: 'minutes', window: null })).toBe(
      '20 emails every minute',
    );
  });

  it('estimates a send at the mailbox ceiling: about 3 days at 500 a day', () => {
    const startAt = new Date('2026-10-14T14:00:00.000Z');
    const estimate = sendEstimate({
      emails: 1240,
      dailyCeiling: 500,
      batches: null,
      startAt,
      timeZone: zone,
    });
    expect(estimate).toMatchObject({ days: 3, perDay: 500, batches: null, lastBatchAt: null });
    expect(estimateSentence(estimate, 'Calari mailbox', zone)).toBe(
      'About 3 days: at most 500 a day from Calari mailbox.',
    );
    expect(estimateSentence(estimate, undefined, zone)).toBe(
      'About 3 days: at most 500 a day from the chosen mailbox.',
    );
  });

  it('estimates batches by their own pace, and names when the last may start', () => {
    const startAt = new Date('2026-10-14T14:00:00.000Z');
    const estimate = sendEstimate({
      emails: 1240,
      dailyCeiling: 2000,
      batches: { size: 500, every: 1, unit: 'days', window: null },
      startAt,
      timeZone: zone,
    });
    expect(estimate.batches).toBe(3);
    expect(estimate.days).toBe(3);
    expect(estimate.lastBatchAt?.toISOString()).toBe('2026-10-16T14:00:00.000Z');
    expect(estimateSentence(estimate, 'Calari mailbox', zone)).toBe(
      '3 batches; the last may start Oct 16, 2026, 9:00 AM. About 3 days: at most 2,000 a day from Calari mailbox.',
    );
  });

  it('moves the last batch to when the window opens', () => {
    const estimate = sendEstimate({
      emails: 100,
      dailyCeiling: 500,
      batches: { size: 50, every: 12, unit: 'hours', window: { from: '09:00', to: '17:00' } },
      // 09:00 in Chicago; the second batch is due at 21:00, outside the window.
      startAt: new Date('2026-10-14T14:00:00.000Z'),
      timeZone: zone,
    });
    expect(estimate.batches).toBe(2);
    expect(estimate.lastBatchAt?.toISOString()).toBe('2026-10-15T14:00:00.000Z');
  });

  it('says a short send, one batch, an unknown ceiling and an empty audience plainly', () => {
    const startAt = new Date('2026-10-14T14:00:00.000Z');
    const short = sendEstimate({
      emails: 80,
      dailyCeiling: 500,
      batches: null,
      startAt,
      timeZone: zone,
    });
    expect(estimateSentence(short, 'Calari mailbox', zone)).toBe(
      'About a day: Calari mailbox can release up to 500 campaign emails a day now.',
    );
    const one = sendEstimate({
      emails: 80,
      dailyCeiling: 500,
      batches: { size: 500, every: 1, unit: 'days', window: null },
      startAt,
      timeZone: zone,
    });
    expect(estimateSentence(one, 'Calari mailbox', zone)).toMatch(/^One batch\. About a day/);
    const unknown = sendEstimate({
      emails: 80,
      dailyCeiling: null,
      batches: null,
      startAt,
      timeZone: zone,
    });
    expect(estimateSentence(unknown, undefined, zone)).toBe('About a day.');
    const slow = sendEstimate({
      emails: 80,
      dailyCeiling: null,
      batches: { size: 20, every: 2, unit: 'days', window: null },
      startAt,
      timeZone: zone,
    });
    expect(estimateSentence(slow, undefined, zone)).toContain('About 7 days.');
    const nobody = sendEstimate({
      emails: 0,
      dailyCeiling: 500,
      batches: null,
      startAt,
      timeZone: zone,
    });
    expect(estimateSentence(nobody, 'Calari mailbox', zone)).toBe(
      'Nobody in the audience can be sent it as things stand.',
    );
    expect(
      sendEstimate({
        emails: 0,
        dailyCeiling: 500,
        batches: { size: 20, every: 2, unit: 'days', window: null },
        startAt,
        timeZone: zone,
      }).batches,
    ).toBeNull();
  });
});

describe('folders', () => {
  const folders = [
    { id: 'a', parentId: null, name: 'Newsletters' },
    { id: 'b', parentId: 'a', name: '2026' },
    { id: 'c', parentId: 'b', name: 'Spring' },
    { id: 'd', parentId: null, name: 'Offers' },
  ];

  it('labels each folder with the path that leads to it', () => {
    const labels = folderLabels(folders);
    expect(labels.get('c')).toBe('Newsletters / 2026 / Spring');
    expect(labels.get('d')).toBe('Offers');
    // A parent that is gone, or a loop, ends the path where it is.
    expect(folderLabels([{ id: 'x', parentId: 'gone', name: 'Lost' }]).get('x')).toBe('Lost');
    const loop = folderLabels([
      { id: 'p', parentId: 'q', name: 'P' },
      { id: 'q', parentId: 'p', name: 'Q' },
    ]);
    expect(loop.get('p')).toBe('Q / P');
  });

  it('offers every folder as a destination but the one moved and those inside it', () => {
    expect(folderDestinations(folders).map((folder) => folder.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(folderDestinations(folders, 'a').map((folder) => folder.id)).toEqual(['d']);
    expect(folderDestinations(folders, 'b').map((folder) => folder.id)).toEqual(['a', 'd']);
  });
});

it('the fixtures name campaigns as the contract does', () => {
  expect(campaignId(1)).toMatch(/^camp_/);
});
