import { randomUUID } from 'node:crypto';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, NotFoundError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';
import {
  queueOutboundMessage,
  createDispatchOutboundTask,
  readContactAddressBlocks,
  type OutboundInput,
} from './index.js';

let database: TestDatabase;
let db: Database;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function fixture(channel: 'email' | 'sms' = 'email') {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(
    business.context,
    channel === 'email' ? { email: 'recipient@example.test' } : {},
  );
  const context = { ...business.context, correlationId: randomUUID() };
  const rows = await database.withTenant(context, async (sql) => {
    if (channel === 'sms')
      await sql.query(
        "insert into crm.contact_identities (business_id,contact_id,kind,value,value_normalized,is_primary) values (app.business_id(),$1,'phone','+254700000001','+254700000001',true)",
        [contact.id],
      );
    await sql.query(
      'insert into messaging.settings (business_id,quiet_hours_enabled) values (app.business_id(),false)',
    );
    await sql.query(
      "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values (app.business_id(),$1,$2,'marketing','granted','user','system')",
      [contact.id, channel],
    );
    const identity = await sql.one<{ id: string }>(
      'select id from crm.contact_identities where contact_id=$1',
      [contact.id],
    );
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id,channel,name) values (app.business_id(),$1,'Fixture sender') returning id",
      [channel],
    );
    return { identity, account };
  });
  const input = {
    identityId: rows.identity.id,
    accountId: rows.account.id,
    channel,
    purpose: 'marketing' as const,
    lane: 'campaign' as const,
    idempotencyKey: randomUUID(),
    subject: 'Fixture',
    text: 'Body',
  };
  const queue = (patch: Partial<OutboundInput> = {}) =>
    withTenant(db, context, (trx) => queueOutboundMessage(trx, context, { ...input, ...patch }));
  const messages = () =>
    database.withTenant(context, (sql) =>
      sql.query<{
        id: string;
        status: string;
        error_code: string | null;
        error_detail: string | null;
        priority: number;
      }>(
        'select id,status,error_code,error_detail,priority from messaging.messages order by created_at,id',
      ),
    );
  return { context, contact, input, queue, messages };
}

it('atomically deduplicates concurrent requests and refuses changed content under the same key', async () => {
  const f = await fixture();
  const ids = await Promise.all([f.queue(), f.queue(), f.queue()]);
  expect(new Set(ids)).toHaveLength(1);
  expect(await f.messages()).toHaveLength(1);
  await expect(f.queue({ text: 'Different' })).rejects.toBeInstanceOf(ConflictError);
  const jobs = await database.runJobs(['messaging.dispatch']);
  expect(jobs).toHaveLength(1);
  expect(JSON.stringify(jobs)).not.toContain('recipient@example.test');
  expect(JSON.stringify(jobs)).not.toContain('Body');
});

it('persists a suppressed refusal with its reason and never queues delivery', async () => {
  const f = await fixture();
  await database.withTenant(f.context, (sql) =>
    sql.query(
      "insert into messaging.suppressions (business_id,channel,address_normalized,reason) values (app.business_id(),'email','recipient@example.test','complaint')",
    ),
  );
  await f.queue();
  expect(await f.messages()).toMatchObject([
    { status: 'failed', error_code: 'suppressed', error_detail: 'complaint' },
  ]);
  expect(await database.runJobs(['messaging.dispatch'])).toHaveLength(0);
});

/** A second, non-primary email address for the fixture's contact, as the contact page adds one. */
async function secondAddress(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const { id } = await database.withTenant(f.context, (sql) =>
    sql.one<{ id: string }>(
      `insert into crm.contact_identities (business_id,contact_id,kind,value,value_normalized)
       values (app.business_id(),$1,'email','second@example.test','second@example.test') returning id`,
      [f.contact.id],
    ),
  );
  return id;
}

it('blocks one address of a contact and still sends to its other one, and says which for the contact page', async () => {
  const f = await fixture();
  const second = await secondAddress(f);
  await database.withTenant(f.context, (sql) =>
    sql.query(
      "insert into messaging.suppressions (business_id,channel,address_normalized,reason) values (app.business_id(),'email','second@example.test','hard_bounce')",
    ),
  );
  await f.queue({ identityId: second, idempotencyKey: randomUUID() });
  await f.queue();
  // A suppression is the address's: the contact's other address is still sent to.
  expect(await f.messages()).toMatchObject([
    { status: 'failed', error_code: 'suppressed', error_detail: 'hard_bounce' },
    { status: 'queued', error_code: null },
  ]);
  const blocks = await withTenant(db, f.context, (trx) =>
    readContactAddressBlocks(trx, f.context, f.contact.id),
  );
  expect(blocks).toEqual([
    {
      kind: 'email',
      value: 'second@example.test',
      reason: 'hard_bounce',
      since: expect.any(Date) as Date,
    },
  ]);
  // A block on the same text for the other channel is not this address's.
  await database.withTenant(f.context, (sql) =>
    sql.query(
      "insert into messaging.suppressions (business_id,channel,address_normalized,reason,expires_at) values (app.business_id(),'sms','recipient@example.test','invalid',null),(app.business_id(),'email','recipient@example.test','manual',now() - interval '1 minute')",
    ),
  );
  expect(
    await withTenant(db, f.context, (trx) =>
      readContactAddressBlocks(trx, f.context, f.contact.id),
    ),
  ).toHaveLength(1);
  // Only the message to the address that is not blocked was queued for delivery.
  expect(await database.runJobs(['messaging.dispatch'])).toHaveLength(1);
});

it('holds a withdrawal of consent for the contact, whichever of its addresses is written to', async () => {
  const f = await fixture();
  const second = await secondAddress(f);
  await database.withTenant(f.context, (sql) =>
    sql.query(
      "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind,recorded_at) values (app.business_id(),$1,'email','marketing','withdrawn','user','system',clock_timestamp())",
      [f.contact.id],
    ),
  );
  await f.queue({ identityId: second, idempotencyKey: randomUUID() });
  await f.queue();
  // Consent is the contact's, for a channel and a purpose: it covers every address.
  expect(await f.messages()).toMatchObject([
    { status: 'failed', error_code: 'consent_withdrawn' },
    { status: 'failed', error_code: 'consent_withdrawn' },
  ]);
});

it('keeps foreign identities and accounts invisible and rolls a queued message back with its transaction', async () => {
  const f = await fixture();
  const other = await fixture();
  await expect(f.queue({ identityId: other.input.identityId })).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(f.queue({ accountId: other.input.accountId })).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    withTenant(db, f.context, async (trx) => {
      await queueOutboundMessage(trx, f.context, f.input);
      throw new Error('Rollback fixture');
    }),
  ).rejects.toThrow('Rollback fixture');
  expect(await f.messages()).toHaveLength(0);
  expect(await database.runJobs(['messaging.dispatch'])).toHaveLength(0);
});

it('delivers once even when the same task runs concurrently and after completion', async () => {
  const f = await fixture();
  const messageId = await f.queue();
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver(message) {
      deliveries++;
      expect(message.to).toBe('recipient@example.test');
      expect(message.text).toBe('Body');
      return Promise.resolve({ outcome: 'accepted' as const, providerId: 'fixture-accepted' });
    },
  });
  const job = {
    invocation: { context: f.context, permissions: 'all' as const },
    services: { db, authorize: () => true },
  };
  await Promise.all([task.run({ messageId }, job), task.run({ messageId }, job)]);
  await task.run({ messageId }, job);
  expect(deliveries).toBe(1);
  expect(await f.messages()).toMatchObject([{ status: 'sent', error_code: null }]);
});

it('rechecks suppression at dispatch and never calls the provider after an intervening opt-out', async () => {
  const f = await fixture();
  const messageId = await f.queue();
  await database.withTenant(f.context, (sql) =>
    sql.query(
      "insert into messaging.suppressions (business_id,channel,address_normalized,reason) values (app.business_id(),'email','recipient@example.test','unsubscribe')",
    ),
  );
  const task = createDispatchOutboundTask({
    deliver: () => {
      throw new Error('Must not send');
    },
  });
  await task.run(
    { messageId },
    {
      invocation: { context: f.context, permissions: 'all' },
      services: { db, authorize: () => true },
    },
  );
  expect(await f.messages()).toMatchObject([
    { status: 'failed', error_code: 'suppressed', error_detail: 'unsubscribe' },
  ]);
});

it('records ambiguous delivery safely and never auto-resends a provider exception', async () => {
  const f = await fixture();
  const messageId = await f.queue();
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver: () => {
      deliveries++;
      throw new Error('Provider secret or recipient data');
    },
  });
  const job = {
    invocation: { context: f.context, permissions: 'all' as const },
    services: { db, authorize: () => true },
  };
  await task.run({ messageId }, job);
  await task.run({ messageId }, job);
  expect(deliveries).toBe(1);
  expect(await f.messages()).toMatchObject([
    { status: 'unknown', error_code: 'delivery_unknown', error_detail: null },
  ]);
});

it('refuses a queued recipient identity that changes before dispatch', async () => {
  const f = await fixture();
  const messageId = await f.queue();
  await database.withTenant(f.context, (sql) =>
    sql.query(
      "update crm.contact_identities set value='changed@example.test',value_normalized='changed@example.test' where id=$1",
      [f.input.identityId],
    ),
  );
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries++;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: 'must-not-send' });
    },
  });
  await task.run(
    { messageId },
    {
      invocation: { context: f.context, permissions: 'all' },
      services: { db, authorize: () => true },
    },
  );
  expect(deliveries).toBe(0);
  expect(await f.messages()).toMatchObject([{ status: 'failed', error_code: 'recipient_changed' }]);
});

it('does not resend a reservation left by a worker crash', async () => {
  const f = await fixture();
  const messageId = await f.queue();
  await database.withTenant(f.context, async (sql) => {
    await sql.query('update messaging.outbound_dispatch set reserved_at=now() where id=$1', [
      messageId,
    ]);
    await sql.query("update messaging.messages set status='sending' where id=$1", [messageId]);
  });
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries++;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: 'crash' });
    },
  });
  const job = {
    invocation: { context: f.context, permissions: 'all' as const },
    services: { db, authorize: () => true },
  };
  await task.run({ messageId }, job);
  await task.run({ messageId }, job);
  expect(deliveries).toBe(0);
  expect(await f.messages()).toMatchObject([{ status: 'unknown', error_code: 'delivery_unknown' }]);
});

it('never resends when provider acceptance succeeds but persistence fails', async () => {
  const f = await fixture();
  const first = await f.queue();
  const second = await f.queue({ idempotencyKey: randomUUID() });
  await database.withTenant(f.context, (sql) =>
    sql.query(
      "update messaging.messages set status='sent',provider_message_id='duplicate-provider-id' where id=$1",
      [first],
    ),
  );
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries++;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: 'duplicate-provider-id' });
    },
  });
  const job = {
    invocation: { context: f.context, permissions: 'all' as const },
    services: { db, authorize: () => true },
  };
  await expect(task.run({ messageId: second }, job)).rejects.toMatchObject({ code: '23505' });
  await task.run({ messageId: second }, job);
  expect(deliveries).toBe(1);
  expect((await f.messages()).find((row) => row.id === second)).toMatchObject({
    status: 'unknown',
    error_code: 'delivery_unknown',
  });
});

it.each(['rejected', 'unknown'] as const)(
  'records an explicit %s provider outcome once',
  async (outcome) => {
    const f = await fixture();
    const messageId = await f.queue();
    let deliveries = 0;
    const task = createDispatchOutboundTask({
      deliver() {
        deliveries++;
        return Promise.resolve({ outcome });
      },
    });
    const job = {
      invocation: { context: f.context, permissions: 'all' as const },
      services: { db, authorize: () => true },
    };
    await task.run({ messageId }, job);
    await task.run({ messageId }, job);
    expect(deliveries).toBe(1);
    expect(await f.messages()).toMatchObject([
      {
        status: outcome === 'rejected' ? 'failed' : 'unknown',
        error_code: outcome === 'rejected' ? 'delivery_rejected' : 'delivery_unknown',
      },
    ]);
  },
);

it('counts reservations atomically so two distinct queued messages cannot exceed the contact cap', async () => {
  const f = await fixture();
  await database.withTenant(f.context, (sql) =>
    sql.query('update messaging.settings set contact_daily_limit=1'),
  );
  const first = await f.queue();
  const second = await f.queue({ idempotencyKey: randomUUID() });
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries++;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: randomUUID() });
    },
  });
  const job = {
    invocation: { context: f.context, permissions: 'all' as const },
    services: { db, authorize: () => true },
  };
  await Promise.all([task.run({ messageId: first }, job), task.run({ messageId: second }, job)]);
  expect(deliveries).toBe(1);
  expect((await f.messages()).filter((row) => row.status === 'queued')).toMatchObject([
    { error_code: 'frequency_cap' },
  ]);
});

it('defers quiet work, then releases only after checking current settings again', async () => {
  const f = await fixture();
  await database.withTenant(f.context, async (sql) => {
    await sql.query("update crm.contacts set timezone='America/New_York' where id=$1", [
      f.contact.id,
    ]);
    await sql.query(
      "update messaging.settings set quiet_hours_enabled=true,quiet_hours_start='00:00',quiet_hours_end='00:00'",
    );
  });
  const messageId = await f.queue();
  expect(await f.messages()).toMatchObject([{ status: 'queued', error_code: 'quiet_hours' }]);
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries++;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: randomUUID() });
    },
  });
  const job = {
    invocation: { context: f.context, permissions: 'all' as const },
    services: { db, authorize: () => true },
  };
  await task.run({ messageId }, job);
  expect(deliveries).toBe(0);
  await database.withTenant(f.context, async (sql) => {
    await sql.query('update messaging.settings set quiet_hours_enabled=false');
    await sql.query(
      "update messaging.messages set scheduled_for=now()-interval '1 second' where id=$1",
      [messageId],
    );
  });
  await task.run({ messageId }, job);
  expect(deliveries).toBe(1);
  expect(await f.messages()).toMatchObject([{ status: 'sent', error_code: null }]);
});

it.each(['missing', 'invalid', 'an abbreviation'] as const)(
  "keeps quiet hours by the business's time zone for a %s contact time zone",
  async (zone) => {
    const f = await fixture();
    await database.withTenant(f.context, async (sql) => {
      await sql.query('update crm.contacts set timezone=$1 where id=$2', [
        zone === 'missing' ? null : zone === 'invalid' ? 'Invalid/Zone' : 'EST',
        f.contact.id,
      ]);
      // Quiet now in Auckland, the business's zone, and only there.
      await sql.query(`update messaging.settings set quiet_hours_enabled=true,
      quiet_hours_start=((now() at time zone 'Pacific/Auckland') - interval '1 hour')::time,
      quiet_hours_end=((now() at time zone 'Pacific/Auckland') + interval '2 hours')::time`);
    });
    await database.as('postgres', (sql) =>
      sql.query("update tenancy.businesses set timezone='Pacific/Auckland' where id=$1", [
        f.context.businessId,
      ]),
    );
    await f.queue();
    expect(await f.messages()).toMatchObject([{ status: 'queued', error_code: 'quiet_hours' }]);
  },
);

it('refuses only when neither the contact nor the business has a zone it can keep', async () => {
  const f = await fixture();
  await database.withTenant(f.context, (sql) =>
    sql.query('update messaging.settings set quiet_hours_enabled=true'),
  );
  await database.as('postgres', (sql) =>
    sql.query("update tenancy.businesses set timezone='Nowhere/Zone' where id=$1", [
      f.context.businessId,
    ]),
  );
  await f.queue();
  expect(await f.messages()).toMatchObject([{ status: 'failed', error_code: 'timing_unknown' }]);
});

it.each(['inside', 'outside'] as const)(
  'uses the contact local time for an interval %s the current hour',
  async (position) => {
    const f = await fixture();
    await database.withTenant(f.context, async (sql) => {
      await sql.query("update crm.contacts set timezone='Pacific/Auckland' where id=$1", [
        f.contact.id,
      ]);
      await sql.query(`update messaging.settings set quiet_hours_enabled=true,
      quiet_hours_start=((now() at time zone 'Pacific/Auckland') ${position === 'inside' ? '-' : '+'} interval '1 hour')::time,
      quiet_hours_end=((now() at time zone 'Pacific/Auckland')+interval '2 hours')::time`);
    });
    await f.queue();
    expect(await f.messages()).toMatchObject([
      { status: 'queued', error_code: position === 'inside' ? 'quiet_hours' : null },
    ]);
  },
);

it('runs reply and automation jobs before campaign backlog in a named business queue', async () => {
  const f = await fixture();
  const campaign = await f.queue();
  const reply = await f.queue({ lane: 'reply', idempotencyKey: randomUUID() });
  const automation = await f.queue({ lane: 'automation', idempotencyKey: randomUUID() });
  const jobs = await database.runJobs(['messaging.dispatch']);
  const envelope = z.strictObject({
    agencyId: z.uuid(),
    businessId: z.uuid(),
    correlationId: z.uuid(),
    data: z.strictObject({ messageId: z.uuid() }),
  });
  const ordered = jobs
    .map((job) => envelope.parse(job.payload))
    .filter((job) => job.businessId === f.context.businessId)
    .map((job) => job.data.messageId);
  expect(ordered).toEqual([reply, automation, campaign]);
});

it('never dispatches a foreign message and denies queue helpers to auth/queue-only roles', async () => {
  const f = await fixture();
  const other = await fixture();
  const messageId = await f.queue();
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries++;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: 'foreign' });
    },
  });
  await task.run(
    { messageId },
    {
      invocation: { context: other.context, permissions: 'all' },
      services: { db, authorize: () => true },
    },
  );
  expect(deliveries).toBe(0);
  await expect(
    database.withTenant(other.context, (sql) =>
      sql.query('select private.enqueue_outbound($1)', [messageId]),
    ),
  ).rejects.toThrow('outbound message is not available in this context');
  for (const role of ['crm_auth', 'crm_worker'] as const)
    await expect(
      database.as(role, (sql) => sql.query('select private.enqueue_outbound($1)', [messageId])),
    ).rejects.toMatchObject({ code: '42501' });
});

it('uses the SMS identity, channel-specific consent and tenant context without an email subject', async () => {
  const f = await fixture('sms');
  const messageId = await f.queue({ subject: undefined, html: 'Fixture HTML' });
  const delivered: string[] = [];
  const task = createDispatchOutboundTask({
    deliver(message, context) {
      expect(context.businessId).toBe(f.context.businessId);
      expect(message).toMatchObject({
        channel: 'sms',
        to: '+254700000001',
        subject: null,
        html: 'Fixture HTML',
      });
      delivered.push(message.messageId);
      return Promise.resolve({ outcome: 'accepted' as const, providerId: randomUUID() });
    },
  });
  await task.run(
    { messageId },
    {
      invocation: { context: f.context, permissions: 'all' },
      services: { db, authorize: () => true },
    },
  );
  expect(delivered).toEqual([messageId]);
  await f.queue({ idempotencyKey: randomUUID(), lane: 'transactional', purpose: 'transactional' });
  expect((await f.messages()).find((row) => row.id !== messageId)).toMatchObject({
    status: 'failed',
    error_code: 'consent_required',
  });
});

it.each(['dnd', 'withdrawn', 'deleted', 'paused', 'business'] as const)(
  'refuses current %s policy facts before queueing',
  async (reason) => {
    const f = await fixture();
    await database.withTenant(f.context, async (sql) => {
      if (reason === 'dnd')
        await sql.query('update crm.contacts set do_not_contact=true where id=$1', [f.contact.id]);
      if (reason === 'withdrawn')
        await sql.query(
          "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind,recorded_at) values (app.business_id(),$1,'email','marketing','withdrawn','user','system',now()+interval '1 second')",
          [f.contact.id],
        );
      if (reason === 'deleted')
        await sql.query('update crm.contacts set deleted_at=now() where id=$1', [f.contact.id]);
      if (reason === 'paused')
        await sql.query("update messaging.channel_accounts set status='paused' where id=$1", [
          f.input.accountId,
        ]);
      if (reason === 'business')
        await sql.query("update tenancy.businesses set status='suspended' where id=$1", [
          f.context.businessId,
        ]);
    });
    await f.queue();
    const expected = {
      dnd: 'do_not_contact',
      withdrawn: 'consent_withdrawn',
      deleted: 'contact_inactive',
      paused: 'sender_inactive',
      business: 'sender_inactive',
    };
    expect(await f.messages()).toMatchObject([{ status: 'failed', error_code: expected[reason] }]);
  },
);

it('refuses a recipient identity removed before dispatch', async () => {
  const f = await fixture();
  const messageId = await f.queue();
  await database.withTenant(f.context, (sql) =>
    sql.query('delete from crm.contact_identities where id=$1', [f.input.identityId]),
  );
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries++;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: 'removed' });
    },
  });
  await task.run(
    { messageId },
    {
      invocation: { context: f.context, permissions: 'all' },
      services: { db, authorize: () => true },
    },
  );
  expect(deliveries).toBe(0);
  expect(await f.messages()).toMatchObject([{ status: 'failed', error_code: 'recipient_changed' }]);
});

it('refuses a queued identity whose channel changes even if its stored address is unchanged', async () => {
  const f = await fixture();
  const messageId = await f.queue();
  await database.withTenant(f.context, (sql) =>
    sql.query("update crm.contact_identities set kind='webchat' where id=$1", [f.input.identityId]),
  );
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries++;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: 'changed-channel' });
    },
  });
  await task.run(
    { messageId },
    {
      invocation: { context: f.context, permissions: 'all' },
      services: { db, authorize: () => true },
    },
  );
  expect(deliveries).toBe(0);
  expect(await f.messages()).toMatchObject([{ status: 'failed', error_code: 'contact_inactive' }]);
});

it('rejects campaign input that tries to use transactional consent', async () => {
  const f = await fixture();
  await expect(f.queue({ purpose: 'transactional' })).rejects.toThrow(
    'Campaigns require marketing consent.',
  );
  expect(await f.messages()).toHaveLength(0);
});

it('retains work when the scheduled time moves after a job was acquired', async () => {
  const f = await fixture();
  const messageId = await f.queue();
  await database.runJobs(['messaging.dispatch']);
  await database.withTenant(f.context, (sql) =>
    sql.query("update messaging.messages set scheduled_for=now()+interval '1 hour' where id=$1", [
      messageId,
    ]),
  );
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries++;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: 'too-early' });
    },
  });
  await task.run(
    { messageId },
    {
      invocation: { context: f.context, permissions: 'all' },
      services: { db, authorize: () => true },
    },
  );
  expect(deliveries).toBe(0);
  expect(
    await database.as('crm_owner', (sql) =>
      sql.query<{ scheduled: boolean }>(
        'select run_at>now() as scheduled from graphile_worker.jobs where key=$1',
        ['outbound:' + messageId],
      ),
    ),
  ).toEqual([{ scheduled: true }]);
});
