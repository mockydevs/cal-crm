import { describe, expect, it } from 'vitest';

import {
  campaignBatchDueAt,
  campaignBatches,
  campaignSpreadDays,
  campaignWindowOpen,
  campaignWindowOpensAt,
  instantOfLocal,
  localTimeOf,
} from './email-campaign-schedule.js';
import {
  createEmailCampaignInput,
  emailCampaignActions,
  emailCampaignAudience,
  emailCampaignContent,
  emailCampaignEndpoints,
  emailCampaignFolderList,
  emailCampaignList,
  emailCampaignMergeFields,
  emailCampaignSummary,
  scheduleEmailCampaignInput,
  sendEmailCampaignInput,
  sendEmailCampaignTestInput,
  updateEmailCampaignInput,
} from './email-campaigns.js';
import { emailCampaignMailbox } from './email-campaign-mailboxes.js';
import { mailbox } from './mailboxes.js';
import { parseInput } from './validation.js';

const NEW_YORK = 'America/New_York';
const NAIROBI = 'Africa/Nairobi';
const utc = (text: string) => new Date(text);

describe('local time in a time zone', () => {
  it('reads the wall clock, with midnight as hour 0', () => {
    expect(localTimeOf(utc('2026-10-13T21:00:00Z'), NAIROBI)).toEqual({
      year: 2026,
      month: 10,
      day: 14,
      hour: 0,
      minute: 0,
      second: 0,
    });
    expect(localTimeOf(utc('2026-07-01T16:30:15Z'), NEW_YORK)).toMatchObject({
      hour: 12,
      minute: 30,
      second: 15,
    });
  });

  it('finds the instant of a wall-clock time, through both clock changes', () => {
    const at = (day: number, hour: number, minute: number, month = 3) =>
      instantOfLocal({ year: 2026, month, day, hour, minute, second: 0 }, NEW_YORK);
    expect(at(7, 9, 0)).toEqual(utc('2026-03-07T14:00:00Z'));
    expect(at(8, 9, 0)).toEqual(utc('2026-03-08T13:00:00Z'));
    // 02:30 on 8 March does not exist: it is taken as that much after the change.
    expect(at(8, 2, 30)).toEqual(utc('2026-03-08T07:30:00Z'));
    // 01:30 on 1 November happens twice: the first is meant.
    expect(at(1, 1, 30, 11)).toEqual(utc('2026-11-01T05:30:00Z'));
    expect(
      instantOfLocal({ year: 2026, month: 10, day: 14, hour: 0, minute: 0, second: 0 }, NAIROBI),
    ).toEqual(utc('2026-10-13T21:00:00Z'));
  });
});

describe('when a batch is due', () => {
  const start = utc('2026-03-06T14:00:00Z');
  it('counts minutes and hours as elapsed time', () => {
    expect(campaignBatchDueAt(start, { every: 30, unit: 'minutes' }, 0, NEW_YORK)).toEqual(start);
    expect(campaignBatchDueAt(start, { every: 30, unit: 'minutes' }, 3, NEW_YORK)).toEqual(
      utc('2026-03-06T15:30:00Z'),
    );
    // 48 hours on is an hour later by the wall clock once the clocks have gone forward.
    expect(campaignBatchDueAt(start, { every: 24, unit: 'hours' }, 2, NEW_YORK)).toEqual(
      utc('2026-03-08T14:00:00Z'),
    );
  });

  it('keeps the local time of day for days, across clock changes and month ends', () => {
    expect(campaignBatchDueAt(start, { every: 1, unit: 'days' }, 2, NEW_YORK)).toEqual(
      utc('2026-03-08T13:00:00Z'),
    );
    expect(
      campaignBatchDueAt(utc('2026-10-30T13:00:00Z'), { every: 1, unit: 'days' }, 3, NEW_YORK),
    ).toEqual(utc('2026-11-02T14:00:00Z'));
    expect(
      campaignBatchDueAt(utc('2026-01-30T06:00:00Z'), { every: 2, unit: 'days' }, 1, NAIROBI),
    ).toEqual(utc('2026-02-01T06:00:00Z'));
  });
});

describe('the sending window', () => {
  const day = { from: '09:00', to: '17:00' };
  const night = { from: '22:00', to: '06:00' };
  it('is open from its start up to, not including, its end', () => {
    expect(campaignWindowOpen(utc('2026-06-01T12:59:00Z'), day, NEW_YORK)).toBe(false);
    expect(campaignWindowOpen(utc('2026-06-01T13:00:00Z'), day, NEW_YORK)).toBe(true);
    expect(campaignWindowOpen(utc('2026-06-01T20:59:00Z'), day, NEW_YORK)).toBe(true);
    expect(campaignWindowOpen(utc('2026-06-01T21:00:00Z'), day, NEW_YORK)).toBe(false);
    expect(campaignWindowOpen(utc('2026-06-01T21:00:00Z'), null, NEW_YORK)).toBe(true);
  });

  it('may run past midnight', () => {
    expect(campaignWindowOpen(utc('2026-06-02T03:00:00Z'), night, NEW_YORK)).toBe(true);
    expect(campaignWindowOpen(utc('2026-06-02T09:59:00Z'), night, NEW_YORK)).toBe(true);
    expect(campaignWindowOpen(utc('2026-06-02T10:00:00Z'), night, NEW_YORK)).toBe(false);
  });

  it('says when it next opens: later today, or tomorrow', () => {
    const open = utc('2026-06-01T15:00:00Z');
    expect(campaignWindowOpensAt(open, day, NEW_YORK)).toEqual(open);
    expect(campaignWindowOpensAt(open, null, NEW_YORK)).toEqual(open);
    expect(campaignWindowOpensAt(utc('2026-06-01T10:00:00Z'), day, NEW_YORK)).toEqual(
      utc('2026-06-01T13:00:00Z'),
    );
    expect(campaignWindowOpensAt(utc('2026-06-01T22:00:00Z'), day, NEW_YORK)).toEqual(
      utc('2026-06-02T13:00:00Z'),
    );
    // Closing on the evening before the clocks change, it opens at 09:00 by the new time.
    expect(campaignWindowOpensAt(utc('2026-03-07T23:00:00Z'), day, NEW_YORK)).toEqual(
      utc('2026-03-08T13:00:00Z'),
    );
  });
});

describe('how long a send takes', () => {
  it('is a day when it fits the ceiling, and as many days as the ceiling needs', () => {
    expect(campaignSpreadDays(0, 100, null)).toBe(0);
    expect(campaignSpreadDays(100, 100, null)).toBe(1);
    expect(campaignSpreadDays(101, 100, null)).toBe(2);
    expect(campaignSpreadDays(1240, 300, null)).toBe(5);
    expect(campaignSpreadDays(10, 0, null)).toBe(10);
  });

  it('follows the batches when they are slower than the ceiling', () => {
    expect(campaignSpreadDays(1000, 5000, { size: 500, every: 1, unit: 'hours' })).toBe(1);
    expect(campaignSpreadDays(1000, 5000, { size: 250, every: 1, unit: 'days' })).toBe(4);
    expect(campaignSpreadDays(1000, 100, { size: 250, every: 1, unit: 'days' })).toBe(10);
    expect(campaignSpreadDays(300, 5000, { size: 100, every: 720, unit: 'minutes' })).toBe(2);
  });
});

describe('the batch plan a person gives', () => {
  it('has a size, an interval and an optional window', () => {
    expect(parseInput(campaignBatches, { size: 500, every: 1, unit: 'hours' })).toEqual({
      size: 500,
      every: 1,
      unit: 'hours',
      window: null,
    });
    const refused = (value: unknown) => campaignBatches.safeParse(value).success;
    expect(refused({ size: 0, every: 1, unit: 'hours' })).toBe(false);
    expect(refused({ size: 10, every: 4, unit: 'minutes' })).toBe(false);
    expect(refused({ size: 10, every: 5, unit: 'minutes' })).toBe(true);
    expect(refused({ size: 10, every: 31, unit: 'days' })).toBe(false);
    expect(refused({ size: 10, every: 721, unit: 'hours' })).toBe(false);
    expect(refused({ size: 10, every: 1, unit: 'weeks' })).toBe(false);
    expect(
      refused({ size: 10, every: 1, unit: 'days', window: { from: '09:00', to: '09:00' } }),
    ).toBe(false);
    expect(
      refused({ size: 10, every: 1, unit: 'days', window: { from: '9:00', to: '17:00' } }),
    ).toBe(false);
    expect(
      refused({ size: 10, every: 1, unit: 'days', window: { from: '22:00', to: '06:00' } }),
    ).toBe(true);
  });
});

describe('a campaign as the API takes it', () => {
  const draft = {
    revision: 1,
    name: ' Spring ',
    folderId: null,
    mailboxId: null,
    fromName: null,
    replyTo: null,
    subject: 'Hello {{contact.firstName}}',
    preheader: null,
    content: { format: 'text', text: 'Come {{contact.firstName}}, see {{trigger_link.offer}}' },
    audience: null,
  };

  it('keeps a subject, a sender name and a preheader on one line', () => {
    expect(parseInput(updateEmailCampaignInput, draft).name).toBe('Spring');
    const ok = (changes: object) =>
      updateEmailCampaignInput.safeParse({ ...draft, ...changes }).success;
    expect(ok({ subject: 'Two\nlines' })).toBe(false);
    expect(ok({ fromName: 'Dana\r\nBcc: x@example.test' })).toBe(false);
    expect(ok({ preheader: 'a\nb' })).toBe(false);
    expect(ok({ replyTo: 'not an address' })).toBe(false);
    expect(ok({ replyTo: 'dana@example.test', fromName: 'Dana', preheader: 'Soon' })).toBe(true);
    expect(ok({ revision: 0 })).toBe(false);
  });

  it('is plain text, or HTML with a text part', () => {
    expect(emailCampaignContent.safeParse({ format: 'text', text: 'Hi' }).success).toBe(true);
    expect(emailCampaignContent.safeParse({ format: 'html', html: '<p>Hi</p>' }).success).toBe(
      false,
    );
    expect(
      emailCampaignContent.safeParse({ format: 'html', html: '<p>Hi</p>', text: 'Hi' }).success,
    ).toBe(true);
    expect(emailCampaignContent.safeParse({ format: 'design', text: 'Hi' }).success).toBe(false);
  });

  it('is for everyone, a smart list, tags or a filter', () => {
    const tag = 'tag_01h455vb4pex5vsknk084sn02q';
    expect(parseInput(emailCampaignAudience, { kind: 'tags', tagIds: [tag] })).toEqual({
      kind: 'tags',
      tagIds: [tag],
      match: 'any',
    });
    expect(emailCampaignAudience.safeParse({ kind: 'all' }).success).toBe(true);
    expect(emailCampaignAudience.safeParse({ kind: 'tags', tagIds: [] }).success).toBe(false);
    expect(emailCampaignAudience.safeParse({ kind: 'smart_list', viewId: tag }).success).toBe(
      false,
    );
    expect(emailCampaignAudience.safeParse({ kind: 'contacts', ids: [] }).success).toBe(false);
  });

  it('lists the merge fields of the subject and every part, each once', () => {
    expect(
      emailCampaignMergeFields({
        subject: 'Hi {{contact.firstName}}',
        content: {
          format: 'html',
          html: '<p>{{contact.firstName}} {{custom_values.site}}</p>',
          text: '{{email.unsubscribe_link}}',
        },
      }),
    ).toEqual(['contact.firstName', 'custom_values.site', 'email.unsubscribe_link']);
    expect(
      emailCampaignMergeFields({ subject: '', content: { format: 'text', text: 'No fields' } }),
    ).toEqual([]);
  });

  it('starts blank unless told what to start from', () => {
    expect(parseInput(createEmailCampaignInput, { name: 'New' })).toEqual({
      name: 'New',
      folderId: null,
      source: { kind: 'blank' },
    });
    expect(parseInput(sendEmailCampaignInput, { revision: 3 })).toEqual({
      revision: 3,
      batches: null,
    });
    expect(scheduleEmailCampaignInput.safeParse({ revision: 3, sendAt: 'tomorrow' }).success).toBe(
      false,
    );
  });

  it('sends a test to at most five addresses', () => {
    expect(sendEmailCampaignTestInput.safeParse({ to: ['me'] }).success).toBe(true);
    expect(sendEmailCampaignTestInput.safeParse({ to: [] }).success).toBe(false);
    expect(sendEmailCampaignTestInput.safeParse({ to: ['nobody'] }).success).toBe(false);
    expect(
      sendEmailCampaignTestInput.safeParse({
        to: ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test', 'e@x.test', 'f@x.test'],
      }).success,
    ).toBe(false);
  });

  it('names what each status allows, and gives every operation its own id', () => {
    expect(emailCampaignActions.draft).toEqual(['edit', 'delete', 'send', 'schedule']);
    expect(emailCampaignActions.sent).toEqual([]);
    const ids = emailCampaignEndpoints.map((endpoint) => endpoint.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(23);
  });

  it('lists a mailbox for the campaign screens without its servers or sign-ins', () => {
    const shape = Object.keys(emailCampaignMailbox.shape).sort();
    expect(shape).toEqual(['displayName', 'email', 'id', 'name', 'status', 'useForCampaigns']);
    // Its status is written out apart from the mailbox contracts, and says the same.
    expect(emailCampaignMailbox.shape.status.options).toEqual(mailbox.shape.status.options);
    // The list of campaigns carries each one's audience, so no row reads its campaign.
    expect(Object.keys(emailCampaignSummary.shape)).toContain('audience');
  });
});

describe('the list page', () => {
  it('may say how many campaigns match on every page, and what the folder panel counts', () => {
    const list = { items: [], next: null, canManage: true, canSend: false };
    expect(emailCampaignList.parse({ ...list, total: 12 })).toEqual({ ...list, total: 12 });
    expect(emailCampaignList.parse(list)).toEqual(list);
    expect(emailCampaignList.safeParse({ ...list, total: -1 }).success).toBe(false);
    const folders = { canManage: true, items: [] };
    const counts = { all: 7, unfiled: 3 };
    expect(emailCampaignFolderList.parse({ ...folders, counts })).toEqual({ ...folders, counts });
    expect(emailCampaignFolderList.parse(folders)).toEqual(folders);
    for (const wrong of [{ all: 1 }, { all: 1, unfiled: 0.5 }, { all: -1, unfiled: 0 }])
      expect(
        emailCampaignFolderList.safeParse({ ...folders, counts: wrong }).success,
        JSON.stringify(wrong),
      ).toBe(false);
  });
});
