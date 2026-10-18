// Hard bounces are suppressed, and the bounce rate per mailbox
// is correct. Reports here are already parsed; the mail adapter's unit tests cover parsing.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ForbiddenError, type TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import {
  readMailboxBounceRate,
  recordBounceCommand,
  recordComplaintCommand,
  SOFT_BOUNCE_LIMIT,
  type BounceKind,
  type BounceReport,
} from './bounces.js';
import { createDispatchOutboundTask, queueOutboundMessage, type OutboundSender } from './index.js';

let database: TestDatabase;
let db: Database;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const RECIPIENT = 'recipient@example.test';
type Delivery = Awaited<ReturnType<OutboundSender['deliver']>>['outcome'] | 'throws';

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...business.context, correlationId: randomUUID() };
  const contact = await database.fixtures.contact(context, { email: RECIPIENT });
  const rows = await database.withTenant(context, async (sql) => {
    await sql.query(
      'insert into messaging.settings (business_id,quiet_hours_enabled,contact_daily_limit) values (app.business_id(),false,1000)',
    );
    for (const purpose of ['marketing', 'transactional'])
      await sql.query(
        "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values (app.business_id(),$1,'email',$2,'granted','user','system')",
        [contact.id, purpose],
      );
    const identity = await sql.one<{ id: string }>(
      'select id from crm.contact_identities where contact_id=$1',
      [contact.id],
    );
    const account = () =>
      sql.one<{ id: string }>(
        "insert into messaging.channel_accounts (business_id,channel,name) values (app.business_id(),'email','Fixture sender') returning id",
      );
    return {
      identityId: identity.id,
      mailboxId: (await account()).id,
      otherId: (await account()).id,
    };
  });
  const job = { invocation: { context, permissions: 'all' as const }, services };
  const queue = (
    mailboxId = rows.mailboxId,
    purpose: 'marketing' | 'transactional' = 'transactional',
  ) =>
    withTenant(db, context, (trx) =>
      queueOutboundMessage(trx, context, {
        identityId: rows.identityId,
        accountId: mailboxId,
        channel: 'email',
        purpose,
        lane: purpose === 'marketing' ? 'campaign' : 'transactional',
        idempotencyKey: randomUUID(),
        subject: 'Fixture',
        text: 'Body',
      }),
    );
  /** Queues a message and takes it through dispatch with the given provider answer. */
  const send = async (delivery: Delivery = 'accepted', mailboxId = rows.mailboxId) => {
    const messageId = await queue(mailboxId);
    const task = createDispatchOutboundTask({
      deliver: () =>
        delivery === 'throws'
          ? Promise.reject(new Error('Provider failure'))
          : Promise.resolve(
              delivery === 'accepted'
                ? { outcome: delivery, providerId: randomUUID() }
                : { outcome: delivery },
            ),
    });
    await task.run({ messageId }, job);
    return messageId;
  };
  const record = (report: BounceReport, mailboxId = rows.mailboxId, as: TenantContext = context) =>
    runCommand(
      services,
      recordBounceCommand,
      { mailboxId, report },
      {
        context: { ...as, correlationId: randomUUID() },
        permissions: 'all',
      },
    );
  const query = <T extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(context, (sql) => sql.query<T>(text, values));
  const messages = () =>
    query<{
      id: string;
      status: string;
      error_code: string | null;
      error_detail: string | null;
      failed: boolean;
    }>(
      'select id,status,error_code,error_detail,failed_at is not null as failed from messaging.messages order by created_at,id',
    );
  const suppressions = () =>
    query<{
      address_normalized: string;
      reason: string;
      source_message_id: string | null;
      detail: string | null;
      lasting: boolean;
    }>(
      'select address_normalized,reason,source_message_id,detail,expires_at is null as lasting from messaging.suppressions order by created_at,id',
    );
  return { ...rows, context, contact, queue, send, record, query, messages, suppressions };
}

const idOf = (messageId: string) => `<crm-outbound.${messageId}@crm.invalid>`;

const reportFor = (
  messageId: string,
  bounce: BounceKind | null = 'hard',
  status = '5.1.1',
  recipient = RECIPIENT,
): BounceReport => ({
  originalMessageId: idOf(messageId),
  recipients: [{ finalRecipient: recipient, originalRecipient: null, status, bounce }],
});

it.each(['accepted', 'rejected', 'unknown', 'throws'] as const)(
  'preserves a hard bounce received before the provider returns %s',
  async (delivery) => {
    const f = await fixture();
    const messageId = await f.queue();
    let deliveries = 0;
    const task = createDispatchOutboundTask({
      async deliver() {
        deliveries += 1;
        expect((await f.messages()).find((message) => message.id === messageId)?.status).toBe(
          'sending',
        );
        expect(await f.record(reportFor(messageId))).toEqual({
          outcome: 'recorded',
          messageId,
          bounce: 'hard',
        });
        if (delivery === 'throws') throw new Error('Provider answer unavailable');
        return delivery === 'accepted'
          ? { outcome: delivery, providerId: randomUUID() }
          : { outcome: delivery };
      },
    });
    const job = { invocation: { context: f.context, permissions: 'all' as const }, services };
    await task.run({ messageId }, job);
    expect(await f.messages()).toEqual([
      {
        id: messageId,
        status: 'bounced',
        error_code: 'hard_bounce',
        error_detail: '5.1.1',
        failed: true,
      },
    ]);
    expect(await f.suppressions()).toEqual([
      expect.objectContaining({
        source_message_id: messageId,
        reason: 'hard_bounce',
        lasting: true,
      }),
    ]);
    expect(
      await f.query<{ finished: boolean }>(
        'select finished_at is not null as finished from messaging.outbound_dispatch where id=$1',
        [messageId],
      ),
    ).toEqual([{ finished: true }]);
    // Finishing the attempt is still durable when a report wins the race. A retry must
    // not hand the message to the provider again or emit a second bounce.
    await task.run({ messageId }, job);
    expect(deliveries).toBe(1);
    expect(
      await f.query<{ count: number }>(
        "select count(*)::integer as count from events.events where type='message.bounced' and subject_id=$1",
        [messageId],
      ),
    ).toEqual([{ count: 1 }]);
  },
);

it('preserves a recorded bounce when an unfinished reserved attempt is retried', async () => {
  const f = await fixture();
  const messageId = await f.queue();
  await f.query('update messaging.outbound_dispatch set reserved_at=now() where id=$1', [
    messageId,
  ]);
  await f.query("update messaging.messages set status='sending' where id=$1", [messageId]);
  expect(await f.record(reportFor(messageId))).toMatchObject({ outcome: 'recorded' });
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries += 1;
      return Promise.resolve({ outcome: 'accepted', providerId: randomUUID() });
    },
  });
  const job = { invocation: { context: f.context, permissions: 'all' as const }, services };
  await task.run({ messageId }, job);
  await task.run({ messageId }, job);
  expect(deliveries).toBe(0);
  expect(await f.messages()).toMatchObject([
    { status: 'bounced', error_code: 'hard_bounce', error_detail: '5.1.1', failed: true },
  ]);
});

it('marks a hard-bounced message, suppresses its address, and refuses later mail to it', async () => {
  const f = await fixture();
  const messageId = await f.send();
  expect(await f.record(reportFor(messageId))).toEqual({
    outcome: 'recorded',
    messageId,
    bounce: 'hard',
  });
  expect(await f.messages()).toEqual([
    {
      id: messageId,
      status: 'bounced',
      error_code: 'hard_bounce',
      error_detail: '5.1.1',
      failed: true,
    },
  ]);
  expect(await f.suppressions()).toEqual([
    {
      address_normalized: RECIPIENT,
      reason: 'hard_bounce',
      source_message_id: messageId,
      detail: '5.1.1',
      lasting: true,
    },
  ]);
  // The existing outbound policy refuses a suppressed address for every purpose.
  for (const purpose of ['marketing', 'transactional'] as const)
    await f.queue(f.mailboxId, purpose);
  expect((await f.messages()).slice(1)).toMatchObject([
    { status: 'failed', error_code: 'suppressed', error_detail: 'hard_bounce' },
    { status: 'failed', error_code: 'suppressed', error_detail: 'hard_bounce' },
  ]);

  const events = await f.query<{ payload: unknown; subject_id: string }>(
    "select payload, subject_id from events.events where type = 'message.bounced'",
  );
  expect(events).toEqual([
    { subject_id: messageId, payload: { mailboxId: f.mailboxId, bounce: 'hard', status: '5.1.1' } },
  ]);
  // The audit keeps identifiers only: no addresses.
  const audits = await f.query<{ input: unknown }>(
    "select input from audit.commands where command = 'mailbox.record_bounce'",
  );
  expect(audits).toEqual([{ input: { mailboxId: f.mailboxId, messageId } }]);
  expect(JSON.stringify(audits)).not.toContain('example.test');
});

it('leaves one suppression and one event however often a bounce is reported', async () => {
  const f = await fixture();
  const first = await f.send();
  const second = await f.send();
  // The same report read twice, at once.
  const outcomes = await Promise.all([f.record(reportFor(first)), f.record(reportFor(first))]);
  expect(outcomes.map((each) => each.outcome).sort()).toEqual(['recorded', 'unchanged']);
  expect(await f.record(reportFor(first))).toEqual({ outcome: 'unchanged', messageId: first });
  // Another message to the same address bounces too: still one suppression, from the first.
  expect(await f.record(reportFor(second, 'hard', '5.1.2'))).toMatchObject({ outcome: 'recorded' });
  expect(await f.suppressions()).toMatchObject([
    {
      address_normalized: RECIPIENT,
      reason: 'hard_bounce',
      source_message_id: first,
      detail: '5.1.1',
    },
  ]);
  expect(await f.messages()).toMatchObject([
    { id: first, status: 'bounced', error_detail: '5.1.1' },
    { id: second, status: 'bounced', error_detail: '5.1.2' },
  ]);
  expect(await f.query("select id from events.events where type = 'message.bounced'")).toHaveLength(
    2,
  );
});

it('records a soft bounce without suppressing, upgrades it to hard, and never downgrades', async () => {
  const f = await fixture();
  const messageId = await f.send();
  expect(await f.record(reportFor(messageId, 'soft', '4.4.7'))).toEqual({
    outcome: 'recorded',
    messageId,
    bounce: 'soft',
  });
  expect(await f.messages()).toEqual([
    {
      id: messageId,
      status: 'bounced',
      error_code: 'soft_bounce',
      error_detail: '4.4.7',
      failed: true,
    },
  ]);
  expect(await f.suppressions()).toEqual([]);
  expect(await f.record(reportFor(messageId, 'soft', '5.2.2'))).toMatchObject({
    outcome: 'unchanged',
  });
  expect(await f.messages()).toMatchObject([{ error_code: 'soft_bounce', error_detail: '4.4.7' }]);

  expect(await f.record(reportFor(messageId, 'hard', '5.1.1'))).toMatchObject({
    outcome: 'recorded',
    bounce: 'hard',
  });
  expect(await f.record(reportFor(messageId, 'soft', '4.4.7'))).toMatchObject({
    outcome: 'unchanged',
  });
  expect(await f.messages()).toMatchObject([{ error_code: 'hard_bounce', error_detail: '5.1.1' }]);
  expect(await f.suppressions()).toMatchObject([{ reason: 'hard_bounce', detail: '5.1.1' }]);
});

it('changes nothing for a report it cannot tie to a message this mailbox sent to that address', async () => {
  const f = await fixture();
  const foreign = await fixture();
  const sent = await f.send();
  const fromOther = await f.send('accepted', f.otherId);
  const rejected = await f.send('rejected');
  const queued = await f.queue();
  const foreignSent = await foreign.send();
  const before = await f.messages();

  const forged: BounceReport[] = [
    // No returned message, an id of another form, and an id that was never a message.
    { ...reportFor(sent), originalMessageId: null },
    { ...reportFor(sent), originalMessageId: `<${sent}@example.test>` },
    reportFor(randomUUID()),
    // Real messages this mailbox didn't send, or never handed to its mail server.
    reportFor(fromOther),
    reportFor(foreignSent),
    reportFor(rejected),
    reportFor(queued),
    // A real message, but the report names another address, or none it could read.
    reportFor(sent, 'hard', '5.1.1', 'victim@example.test'),
    {
      originalMessageId: idOf(sent),
      recipients: [
        { finalRecipient: null, originalRecipient: null, status: '5.1.1', bounce: 'hard' },
      ],
    },
    { originalMessageId: idOf(sent), recipients: [] },
    // Not a bounce: a delay, and a report that contradicts itself about the address.
    reportFor(sent, null, '4.0.0'),
    {
      originalMessageId: idOf(sent),
      recipients: [
        { finalRecipient: RECIPIENT, originalRecipient: null, status: '5.1.1', bounce: 'hard' },
        { finalRecipient: RECIPIENT, originalRecipient: null, status: '2.0.0', bounce: null },
      ],
    },
  ];
  for (const report of forged) expect(await f.record(report)).toEqual({ outcome: 'ignored' });
  expect(await f.messages()).toEqual(before);
  expect(await f.suppressions()).toEqual([]);
  expect(await foreign.suppressions()).toEqual([]);
  expect(await foreign.messages()).toMatchObject([{ id: foreignSent, status: 'sent' }]);
  expect(await f.query("select id from events.events where type = 'message.bounced'")).toEqual([]);

  // The same message, through the mailbox that sent it, does count.
  expect(await f.record(reportFor(fromOther), f.otherId)).toMatchObject({ outcome: 'recorded' });
});

it('suppresses the stored recipient when the report names it only as the original recipient', async () => {
  const f = await fixture();
  const messageId = await f.send();
  const report: BounceReport = {
    originalMessageId: idOf(messageId),
    recipients: [
      {
        finalRecipient: 'forwarded@example.org',
        originalRecipient: RECIPIENT,
        status: '5.1.1',
        bounce: 'hard',
      },
    ],
  };
  expect(await f.record(report)).toMatchObject({ outcome: 'recorded', bounce: 'hard' });
  // Never the address the report supplies.
  expect(await f.suppressions()).toMatchObject([{ address_normalized: RECIPIENT }]);
});

it('records a bounce for a message whose delivery outcome was unknown', async () => {
  const f = await fixture();
  const messageId = await f.send('throws');
  expect(await f.messages()).toMatchObject([{ status: 'unknown' }]);
  expect(await f.record(reportFor(messageId))).toMatchObject({ outcome: 'recorded' });
  expect(await f.messages()).toMatchObject([{ status: 'bounced', error_code: 'hard_bounce' }]);
});

it('keeps a lasting suppression as it is, and replaces a temporary or expired one', async () => {
  for (const [expires, kept] of [
    ['null', true],
    ["now() + interval '1 day'", false],
    ["now() - interval '1 day'", false],
  ] as const) {
    const f = await fixture();
    const messageId = await f.send();
    await f.query(
      `insert into messaging.suppressions (business_id,channel,address_normalized,reason,expires_at) values (app.business_id(),'email',$1,'manual',${expires})`,
      [RECIPIENT],
    );
    expect(await f.record(reportFor(messageId))).toMatchObject({ outcome: 'recorded' });
    expect(await f.suppressions()).toEqual([
      kept
        ? {
            address_normalized: RECIPIENT,
            reason: 'manual',
            source_message_id: null,
            detail: null,
            lasting: true,
          }
        : {
            address_normalized: RECIPIENT,
            reason: 'hard_bounce',
            source_message_id: messageId,
            detail: '5.1.1',
            lasting: true,
          },
    ]);
  }
});

it('lets only the mailbox sync record a bounce, and rolls back with its transaction', async () => {
  const f = await fixture();
  const messageId = await f.send();
  const user = {
    ...f.context,
    actorKind: 'user' as const,
    actorId: (await database.fixtures.user()).id,
  };
  await expect(f.record(reportFor(messageId), f.mailboxId, user)).rejects.toBeInstanceOf(
    ForbiddenError,
  );
  // Inside the inbound batch's transaction: a failed batch leaves no bounce behind.
  await expect(
    withTenant(db, f.context, async (trx) => {
      await recordBounceCommand.handle(
        trx,
        { mailboxId: f.mailboxId, report: reportFor(messageId) },
        {
          context: f.context,
          permissions: 'all',
          emit: () => Promise.resolve(randomUUID()),
          enqueue: () => undefined,
        },
      );
      throw new Error('Rollback fixture');
    }),
  ).rejects.toThrow('Rollback fixture');
  expect(await f.messages()).toMatchObject([{ status: 'sent', error_code: null }]);
  expect(await f.suppressions()).toEqual([]);
});

it("reads each mailbox's bounce rate over the messages it was given to deliver in the window", async () => {
  const f = await fixture();
  const read = (mailboxId = f.mailboxId, days?: number) =>
    withTenant(db, f.context, (trx) => readMailboxBounceRate(trx, mailboxId, days));
  // Nothing attempted: the rate is unknown, not zero.
  expect(await read()).toEqual({ attempted: 0, bounced: 0, hardBounced: 0, rate: null });

  const hard = await f.send();
  const soft = await f.send();
  await f.send();
  await f.send();
  const old = await f.send();
  await f.queue();
  const other = await f.send('accepted', f.otherId);
  await f.record(reportFor(soft, 'soft', '4.4.7'));
  // A hard bounce suppresses the address, so it's recorded after the others are sent.
  await f.record(reportFor(old));
  await f.record(reportFor(hard));
  await f.record(reportFor(hard));
  await database.as('crm_owner', (client) =>
    client.query(
      "update messaging.outbound_dispatch set reserved_at = now() - interval '8 days' where id = $1",
      [old],
    ),
  );

  // Four in the window (the queued one was never attempted, the old one is outside it).
  expect(await read()).toEqual({ attempted: 4, bounced: 2, hardBounced: 1, rate: 0.5 });
  expect(await read(f.mailboxId, 30)).toEqual({
    attempted: 5,
    bounced: 3,
    hardBounced: 2,
    rate: 0.6,
  });
  expect(await read(f.otherId)).toEqual({ attempted: 1, bounced: 0, hardBounced: 0, rate: 0 });
  await f.record(reportFor(other), f.otherId);
  expect(await read(f.otherId)).toEqual({ attempted: 1, bounced: 1, hardBounced: 1, rate: 1 });
  // Another business sees none of it.
  const foreign = await fixture();
  expect(
    await withTenant(db, foreign.context, (trx) => readMailboxBounceRate(trx, f.mailboxId)),
  ).toEqual({ attempted: 0, bounced: 0, hardBounced: 0, rate: null });
  for (const days of [0, 91, 1.5]) await expect(read(f.mailboxId, days)).rejects.toThrow();
});

it(`suppresses an address as invalid after ${String(SOFT_BOUNCE_LIMIT)} soft bounces in a row, and not before`, async () => {
  const f = await fixture();
  // A message that was delivered and never bounced breaks a streak.
  await f.send();
  for (let index = 0; index < SOFT_BOUNCE_LIMIT - 1; index += 1) {
    const messageId = await f.send();
    expect(await f.record(reportFor(messageId, 'soft', '4.2.2'))).toMatchObject({
      outcome: 'recorded',
      bounce: 'soft',
    });
  }
  expect(await f.suppressions()).toEqual([]);
  const last = await f.send();
  await f.record(reportFor(last, 'soft', '5.2.2'));
  expect(await f.suppressions()).toEqual([
    {
      address_normalized: RECIPIENT,
      reason: 'invalid',
      source_message_id: last,
      detail: 'soft_bounce_limit',
      lasting: true,
    },
  ]);
});

it('records a spam complaint from a feedback loop as a lasting suppression of the stored recipient', async () => {
  const f = await fixture();
  const messageId = await f.send();
  const complain = (
    report: { feedbackType: string; originalMessageId: string | null },
    as = f.context,
  ) =>
    runCommand(
      services,
      recordComplaintCommand,
      { mailboxId: f.mailboxId, report },
      { context: { ...as, correlationId: randomUUID() }, permissions: 'all' },
    );
  // Not abuse, not ours, or not a message this mailbox sent: nothing changes.
  for (const report of [
    { feedbackType: 'fraud', originalMessageId: idOf(messageId) },
    { feedbackType: 'abuse', originalMessageId: '<someone@else.example>' },
    { feedbackType: 'abuse', originalMessageId: null },
    { feedbackType: 'abuse', originalMessageId: idOf(randomUUID()) },
  ])
    expect(await complain(report)).toEqual({ outcome: 'ignored' });
  expect(await f.suppressions()).toEqual([]);
  expect(await complain({ feedbackType: 'abuse', originalMessageId: idOf(messageId) })).toEqual({
    outcome: 'recorded',
    messageId,
  });
  expect(await f.suppressions()).toEqual([
    {
      address_normalized: RECIPIENT,
      reason: 'complaint',
      source_message_id: messageId,
      detail: 'abuse',
      lasting: true,
    },
  ]);
  // Nothing more is sent to the address, transactional mail included.
  const after = await f.send();
  expect((await f.messages()).find((message) => message.id === after)).toMatchObject({
    status: 'failed',
    error_code: 'suppressed',
    error_detail: 'complaint',
  });
  await expect(
    complain(
      { feedbackType: 'abuse', originalMessageId: idOf(messageId) },
      { ...f.context, actorKind: 'user', actorId: randomUUID() },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
});
