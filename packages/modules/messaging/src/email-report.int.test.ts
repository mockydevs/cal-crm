// The numbers of the Dashboard's email widgets, counted from real messages and consents
// with fixed dates and held against a recount by hand, as crm_app under row-level security.
// The rules that turn the counts into the answer are email-report-rules.test.ts.
import { randomUUID } from 'node:crypto';

import { emailReport, OPPORTUNITY_REPORT_MAX_DAYS, type EmailReport } from '@repo/contracts';
import { ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { inboxBusiness, startInbox, type InboxBusiness, type InboxWorld } from '../test/inbox.js';

let world: InboxWorld;
beforeAll(async () => {
  world = await startInbox(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

/** A business in Nairobi (three hours ahead of UTC, all year), with a mailbox and a contact. */
async function nairobi() {
  const b = await inboxBusiness(world);
  await world.database.as('crm_owner', (sql) =>
    sql.query(`update tenancy.businesses set timezone = 'Africa/Nairobi' where id = $1`, [
      b.business.id,
    ]),
  );
  const box = await b.mailbox();
  const maya = await b.contact({ firstName: 'Maya' });
  const [conversation] = await b.query<{ id: string }>(
    `insert into messaging.conversations (business_id, contact_id)
     values (app.business_id(), $1) returning id`,
    [maya.id],
  );
  if (conversation === undefined) throw new Error('No conversation.');
  return { b, box, maya, conversationId: conversation.id };
}
type Place = Awaited<ReturnType<typeof nairobi>>;

/**
 * An outbound message as it stands after the dispatcher, a refusal or a delivery report:
 * written with its dates, as an import of history would write it.
 */
async function outbound(
  { b, box, maya, conversationId }: Place,
  values: {
    status?: 'queued' | 'sent' | 'failed' | 'bounced' | 'unknown';
    lane?: 'reply' | 'transactional' | 'automation' | 'campaign';
    author?: 'user' | 'ai_agent' | 'system' | 'api_key';
    sentAt?: string;
    failedAt?: string;
    errorCode?: string;
    /** Another channel's account: a text message is no email. */
    sms?: string;
  },
): Promise<string> {
  const author = values.author ?? 'user';
  const [message] = await b.query<{ id: string }>(
    `insert into messaging.messages
       (business_id, conversation_id, channel, channel_account_id, direction, status, body_text,
        to_addresses, idempotency_key, author_kind, author_id, error_code, sent_at, failed_at)
     values (app.business_id(), $1, $2, $3, 'outbound', $4, 'Hello', array[$5::text], $6, $7, $8,
             $9, $10::timestamptz, $11::timestamptz)
     returning id`,
    [
      conversationId,
      values.sms === undefined ? 'email' : 'sms',
      values.sms ?? box.id,
      values.status ?? 'sent',
      maya.email,
      randomUUID(),
      author,
      author === 'user' ? b.user.id : null,
      values.errorCode ?? null,
      values.sentAt ?? null,
      values.failedAt ?? null,
    ],
  );
  if (message === undefined) throw new Error('No message.');
  await b.query(
    `insert into messaging.outbound_dispatch
       (business_id, id, purpose, lane, request_hash, reserved_at)
     values (app.business_id(), $1, 'transactional', $2, repeat('0', 64), now())`,
    [message.id, values.lane ?? 'reply'],
  );
  return message.id;
}

/** An email from the contact, stored at the moment given; answering a stored message or not. */
async function inbound(
  { b, box, maya }: Place,
  at: string,
  values: { parent?: string; automated?: boolean } = {},
): Promise<string> {
  const { messageId } = await b.receive(maya, box.id, 'Hello back', {
    at: new Date(at),
    ...(values.automated === undefined ? {} : { automated: values.automated }),
  });
  if (values.parent !== undefined)
    await b.query('update messaging.messages set parent_message_id = $2 where id = $1', [
      messageId,
      values.parent,
    ]);
  return messageId;
}

/** One row of the consent ledger, at the moment given. */
async function consent(
  b: InboxBusiness,
  contactId: string,
  at: string,
  values: {
    status?: 'granted' | 'withdrawn';
    source?: 'unsubscribe_link' | 'user' | 'import';
    channel?: 'email' | 'sms';
    purpose?: 'marketing' | 'transactional';
  } = {},
): Promise<void> {
  await b.query(
    `insert into messaging.consents
       (business_id, contact_id, channel, purpose, status, source, recorded_at, recorded_by_kind)
     values (app.business_id(), $1, $2, $3, $4, $5, $6::timestamptz, 'system')`,
    [
      contactId,
      values.channel ?? 'email',
      values.purpose ?? 'marketing',
      values.status ?? 'withdrawn',
      values.source ?? 'user',
      at,
    ],
  );
}

const report = async (b: InboxBusiness, query: Record<string, string>): Promise<EmailReport> =>
  emailReport.parse(await world.call('getEmailReport', b.as(), { query }));

/** March 2026 as Nairobi has it: from its first midnight to the one that ends it. */
const MARCH = { from: '2026-02-28T21:00:00Z', to: '2026-03-31T21:00:00Z' };
const ZERO = { sent: 0, notSent: 0, bounced: 0, received: 0, replies: 0, unsubscribed: 0 };
const dayOf = (answer: EmailReport, date: string) => answer.days.find((day) => day.date === date);

describe('the email numbers of a business over a range', () => {
  it('equal a recount by hand, each thing on the day it happened in the business time zone', async () => {
    const place = await nairobi();
    const { b } = place;
    // Sent: by a workflow, a person, the assistant and the system.
    await outbound(place, { sentAt: '2026-03-05T08:00:00Z', lane: 'automation', author: 'system' });
    const answered = await outbound(place, { sentAt: '2026-03-05T09:00:00Z' });
    // Half past midnight on the 6th in Nairobi.
    await outbound(place, { sentAt: '2026-03-05T21:30:00Z', author: 'ai_agent' });
    await outbound(place, {
      sentAt: '2026-03-10T10:00:00Z',
      lane: 'transactional',
      author: 'system',
    });
    // The first instant of the range is in it.
    await outbound(place, { sentAt: MARCH.from });
    // Sent in the range and bounced in it: once sent, once bounced, each on its day.
    await outbound(place, {
      status: 'bounced',
      lane: 'automation',
      author: 'system',
      sentAt: '2026-03-10T11:00:00Z',
      failedAt: '2026-03-12T06:00:00Z',
      errorCode: 'hard_bounce',
    });
    // Sent before the range, and its report came in the range: a bounce of the range only.
    await outbound(place, {
      status: 'bounced',
      sentAt: '2026-02-20T10:00:00Z',
      failedAt: '2026-03-12T07:00:00Z',
      errorCode: 'soft_bounce',
    });
    // Not sent, with and without a reason.
    for (const [failedAt, errorCode] of [
      ['2026-03-07T10:00:00Z', 'consent_required'],
      ['2026-03-07T11:00:00Z', 'consent_required'],
      ['2026-03-08T10:00:00Z', 'suppressed'],
      ['2026-03-08T10:00:00Z', 'delivery_rejected'],
      ['2026-03-09T10:00:00Z', undefined],
    ] as const)
      await outbound(place, {
        status: 'failed',
        failedAt,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    // Received: an answer to our email; one out of the blue; an automatic answer; and an
    // answer to the contact's own earlier email.
    await inbound(place, '2026-03-06T08:00:00Z', { parent: answered });
    const own = await inbound(place, '2026-03-06T09:00:00Z');
    await inbound(place, '2026-03-06T10:00:00Z', { parent: answered, automated: true });
    await inbound(place, '2026-03-07T08:00:00Z', { parent: own });

    // Not of the range: the instant before it and the instant that ends it; never sent;
    // an outcome nobody knows; a text message; a refusal in April.
    await outbound(place, { sentAt: '2026-02-28T20:59:59.999Z' });
    await outbound(place, { sentAt: MARCH.to });
    await outbound(place, { status: 'queued' });
    await outbound(place, { status: 'unknown', errorCode: 'delivery_unknown' });
    const line = await b.smsAccount();
    await outbound(place, { sentAt: '2026-03-05T08:00:00Z', sms: line.id });
    await outbound(place, { status: 'failed', failedAt: '2026-04-02T10:00:00Z', errorCode: 'x' });
    await inbound(place, '2026-04-02T08:00:00Z');

    const answer = await report(b, MARCH);
    expect(answer).toMatchObject({ ...MARCH, timeZone: 'Africa/Nairobi' });
    expect(answer.totals).toEqual({
      sent: 6,
      notSent: 5,
      bounced: 2,
      hardBounced: 1,
      received: 4,
      replies: 1,
      unsubscribed: 0,
    });
    expect(answer.senders).toEqual([
      { sender: 'workflow', count: 2 },
      { sender: 'person', count: 2 },
      { sender: 'assistant', count: 1 },
      { sender: 'other', count: 1 },
    ]);
    expect(answer.notSentReasons).toEqual([
      { reason: 'consent_required', count: 2 },
      { reason: 'delivery_rejected', count: 1 },
      { reason: 'suppressed', count: 1 },
      { reason: 'unknown', count: 1 },
    ]);
    // Every day of March, in order, and nothing else.
    expect(answer.days).toHaveLength(31);
    expect(answer.days[0]?.date).toBe('2026-03-01');
    expect(answer.days.at(-1)?.date).toBe('2026-03-31');
    const busy: Record<string, typeof ZERO> = {
      '2026-03-01': { ...ZERO, sent: 1 },
      '2026-03-05': { ...ZERO, sent: 2 },
      '2026-03-06': { ...ZERO, sent: 1, received: 3, replies: 1 },
      '2026-03-07': { ...ZERO, notSent: 2, received: 1 },
      '2026-03-08': { ...ZERO, notSent: 2 },
      '2026-03-09': { ...ZERO, notSent: 1 },
      '2026-03-10': { ...ZERO, sent: 2 },
      '2026-03-12': { ...ZERO, bounced: 2 },
    };
    for (const day of answer.days)
      expect(day, day.date).toEqual({
        date: day.date,
        ...(busy[day.date] ?? ZERO),
      });
  });

  it('counts a contact as unsubscribed when marketing email consent is withdrawn, once', async () => {
    const place = await nairobi();
    const { b } = place;
    const contact = async () => (await b.contact({ consent: false })).id;
    // By the link; withdrawn again by the team the day after: one unsubscribe.
    const linked = await contact();
    await consent(b, linked, '2026-03-15T10:00:00Z', { source: 'unsubscribe_link' });
    await consent(b, linked, '2026-03-16T10:00:00Z');
    // Granted, withdrawn, granted again and withdrawn again: two.
    const twice = await contact();
    await consent(b, twice, '2026-03-01T10:00:00Z', { status: 'granted' });
    await consent(b, twice, '2026-03-20T10:00:00Z');
    await consent(b, twice, '2026-03-21T10:00:00Z', { status: 'granted' });
    await consent(b, twice, '2026-03-22T10:00:00Z');
    // Not unsubscribes of the range: history an import brought; a withdrawal that was
    // already in force before the range; transactional email; marketing text messages.
    await consent(b, await contact(), '2026-03-15T10:00:00Z', { source: 'import' });
    const before = await contact();
    await consent(b, before, '2026-02-10T10:00:00Z');
    await consent(b, before, '2026-03-15T10:00:00Z');
    const other = await contact();
    await consent(b, other, '2026-03-15T10:00:00Z', { purpose: 'transactional' });
    await consent(b, other, '2026-03-15T10:00:00Z', { channel: 'sms' });

    const answer = await report(b, MARCH);
    expect(answer.totals).toEqual({ ...ZERO, hardBounced: 0, unsubscribed: 3 });
    expect(
      answer.days.filter((day) => day.unsubscribed > 0).map((day) => [day.date, day.unsubscribed]),
    ).toEqual([
      ['2026-03-15', 1],
      ['2026-03-20', 1],
      ['2026-03-22', 1],
    ]);
  });

  it('answers zeros for every day of a business with no email, and part days at the ends of a range that is not cut at its midnights', async () => {
    const { b } = await nairobi();
    const answer = await report(b, { from: '2026-03-01T00:00:00Z', to: '2026-03-03T00:00:00Z' });
    // 03:00 on the 1st to 03:00 on the 3rd in Nairobi.
    expect(answer.days).toEqual(
      ['2026-03-01', '2026-03-02', '2026-03-03'].map((date) => ({ date, ...ZERO })),
    );
    expect(answer.totals).toEqual({ ...ZERO, hardBounced: 0 });
    expect(answer.notSentReasons).toEqual([]);
    expect(answer.senders.map((each) => each.count)).toEqual([0, 0, 0, 0]);
    // A range that ends on a midnight there does not reach into the day that starts then.
    expect((await report(b, MARCH)).days.at(-1)?.date).toBe('2026-03-31');
  });

  it('counts only the business of the request', async () => {
    const mine = await nairobi();
    const theirs = await nairobi();
    await outbound(theirs, { sentAt: '2026-03-05T08:00:00Z' });
    await outbound(theirs, { status: 'failed', failedAt: '2026-03-05T08:00:00Z', errorCode: 'x' });
    await inbound(theirs, '2026-03-05T08:00:00Z');
    await consent(theirs.b, theirs.maya.id, '2026-03-05T08:00:00Z');
    await outbound(mine, { sentAt: '2026-03-06T08:00:00Z' });

    const answer = await report(mine.b, MARCH);
    expect(answer.totals).toEqual({ ...ZERO, hardBounced: 0, sent: 1 });
    expect(dayOf(answer, '2026-03-05')).toEqual({ date: '2026-03-05', ...ZERO });
    expect((await report(theirs.b, MARCH)).totals).toEqual({
      sent: 1,
      notSent: 1,
      bounced: 0,
      hardBounced: 0,
      received: 1,
      replies: 0,
      unsubscribed: 1,
    });
  });

  it('refuses a range that is missing, backwards or longer than the opportunity numbers allow', async () => {
    const { b } = await nairobi();
    for (const query of [
      {},
      { from: MARCH.from },
      { from: MARCH.to, to: MARCH.from },
      { from: '2024-01-01T00:00:00Z', to: '2027-01-01T00:00:00.001Z' },
      { ...MARCH, timeZone: 'UTC' },
    ])
      await expect(
        world.call('getEmailReport', b.as(), { query }),
        JSON.stringify(query),
      ).rejects.toBeInstanceOf(ValidationError);
    // The longest range allowed is answered, with a row for each of its days.
    const longest = await report(b, { from: '2024-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' });
    expect(longest.days).toHaveLength(OPPORTUNITY_REPORT_MAX_DAYS + 1);
  });

  it('is read by anyone in the business, with no permission', async () => {
    const { b } = await nairobi();
    const answer = emailReport.parse(
      await world.call('getEmailReport', b.as(new Set()), { query: MARCH }),
    );
    expect(answer.days).toHaveLength(31);
  });
});

describe('the indexes the email numbers are read from (migration 0077)', () => {
  it('lead with the business and the date, and hold only the rows each count reads', async () => {
    const rows = await world.database.as('crm_owner', (sql) =>
      sql.query<{ indexname: string; indexdef: string }>(
        `select indexname, indexdef from pg_indexes
         where schemaname = 'messaging' and indexname = any($1::text[]) order by indexname`,
        [
          [
            'messages_email_sent_idx',
            'messages_email_failed_idx',
            'messages_email_received_idx',
            'consents_email_withdrawn_idx',
          ],
        ],
      ),
    );
    expect(rows.map((row) => row.indexname)).toEqual([
      'consents_email_withdrawn_idx',
      'messages_email_failed_idx',
      'messages_email_received_idx',
      'messages_email_sent_idx',
    ]);
    const definition = (name: string) => rows.find((row) => row.indexname === name)?.indexdef;
    expect(definition('messages_email_sent_idx')).toContain('(business_id, sent_at)');
    expect(definition('messages_email_failed_idx')).toContain('(business_id, failed_at)');
    expect(definition('messages_email_received_idx')).toContain('(business_id, created_at)');
    expect(definition('consents_email_withdrawn_idx')).toContain('(business_id, recorded_at)');
    for (const row of rows) expect(row.indexdef, row.indexname).toContain(' WHERE ');
  });
});
