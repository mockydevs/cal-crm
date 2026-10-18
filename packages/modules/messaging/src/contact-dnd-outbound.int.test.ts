// Do not disturb by channel, end to end: the CRM's own command sets it, and the real send
// check (queueOutboundMessage and the dispatch task) reads it. One rule for every channel
// the pipeline sends on: do not contact stops all of them, do not disturb stops the
// channels it names, and both are recorded under the reason `do_not_contact`, told apart by
// the stored detail.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import {
  readContact,
  readContactDetails,
  setContactDndCommand,
  updateContactCommand,
  type ContactDetailOptions,
} from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { createDispatchOutboundTask, queueOutboundMessage } from './index.js';

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

// The command reads the team only to show an owner and followers; this contact has neither.
const options: ContactDetailOptions = {
  actorNames: {},
  assignees: {
    resolve: () => Promise.resolve(null),
    memberships: () => Promise.resolve(new Map<string, string>()),
  },
};
const setDnd = setContactDndCommand(options);
const reason = 'Asked by phone on 9 October to get no more of these.';
type Channel = 'email' | 'sms';

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context, {
    email: 'recipient@example.test',
  });
  const invocation = (): Invocation => ({
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  });
  const rows = await database.withTenant(business.context, async (sql) => {
    await sql.query(
      `insert into crm.contact_identities (business_id,contact_id,kind,value,value_normalized,is_primary)
       values (app.business_id(),$1,'phone','+254700000001','+254700000001',true)`,
      [contact.id],
    );
    await sql.query(
      'insert into messaging.settings (business_id,quiet_hours_enabled) values (app.business_id(),false)',
    );
    const sender: Partial<Record<Channel, { identity: string; account: string }>> = {};
    for (const [channel, kind] of [
      ['email', 'email'],
      ['sms', 'phone'],
    ] as const) {
      await sql.query(
        "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values (app.business_id(),$1,$2,'marketing','granted','user','system')",
        [contact.id, channel],
      );
      const identity = await sql.one<{ id: string }>(
        'select id from crm.contact_identities where contact_id=$1 and kind=$2',
        [contact.id, kind],
      );
      const account = await sql.one<{ id: string }>(
        "insert into messaging.channel_accounts (business_id,channel,name) values (app.business_id(),$1,'Fixture sender') returning id",
        [channel],
      );
      sender[channel] = { identity: identity.id, account: account.id };
    }
    return sender;
  });
  const id = toPublicId('contact', contact.id);
  /** Sets do not disturb through the contact page's command, from what the page shows now. */
  const dnd = async (all: boolean, channels: readonly string[]) => {
    const current = invocation();
    const shown = await withTenant(db, current.context, (trx) =>
      readContactDetails(trx, current, id, options),
    );
    return runCommand(
      services,
      setDnd,
      { id, all, channels, reason, revision: shown.dnd.revision },
      invocation(),
    );
  };
  const queue = (channel: Channel) => {
    const { context } = invocation();
    const sender = rows[channel];
    if (sender === undefined) throw new Error(`No ${channel} sender.`);
    return withTenant(db, context, (trx) =>
      queueOutboundMessage(trx, context, {
        identityId: sender.identity,
        accountId: sender.account,
        channel,
        purpose: 'marketing',
        lane: 'campaign',
        idempotencyKey: randomUUID(),
        ...(channel === 'email' ? { subject: 'Fixture' } : {}),
        text: 'Body',
      }),
    );
  };
  const message = (messageId: string) =>
    database.withTenant(business.context, (sql) =>
      sql.one<{ status: string; error_code: string | null; error_detail: string | null }>(
        'select status,error_code,error_detail from messaging.messages where id=$1',
        [messageId],
      ),
    );
  /** What queueing one message on each channel comes to. */
  const outcomes = async () => ({
    email: await message(await queue('email')),
    sms: await message(await queue('sms')),
  });
  return { id, invocation, dnd, queue, message, outcomes, context: business.context };
}

const sent = { status: 'queued', error_code: null, error_detail: null };
const stoppedForChannel = {
  status: 'failed',
  error_code: 'do_not_contact',
  error_detail: 'channel',
};
const stoppedForAll = { status: 'failed', error_code: 'do_not_contact', error_detail: null };

it('stops the channels it names and leaves the others, and lets them through again when turned off', async () => {
  const f = await fixture();
  expect(await f.outcomes()).toEqual({ email: sent, sms: sent });

  await f.dnd(false, ['email']);
  expect(await f.outcomes()).toEqual({ email: stoppedForChannel, sms: sent });
  await f.dnd(false, ['sms']);
  expect(await f.outcomes()).toEqual({ email: sent, sms: stoppedForChannel });
  await f.dnd(false, ['sms', 'email']);
  expect(await f.outcomes()).toEqual({ email: stoppedForChannel, sms: stoppedForChannel });
  await f.dnd(false, []);
  expect(await f.outcomes()).toEqual({ email: sent, sms: sent });
});

it('is not stopped on one channel by a switch for another, built or not', async () => {
  const f = await fixture();
  // Calls and WhatsApp are not built, and a web chat reply does not pass through this
  // pipeline: their switches are kept, and stop nothing here.
  await f.dnd(false, ['call', 'whatsapp', 'webchat']);
  expect(await f.outcomes()).toEqual({ email: sent, sms: sent });
});

it('stops every channel for do not contact, however it was turned on, and says so as before', async () => {
  const f = await fixture();
  // The contact page's command, with a channel named as well: every channel is said first.
  await f.dnd(true, ['email']);
  expect(await f.outcomes()).toEqual({ email: stoppedForAll, sms: stoppedForAll });
  await f.dnd(false, []);
  expect(await f.outcomes()).toEqual({ email: sent, sms: sent });

  // The contact command, as before this existed.
  const current = f.invocation();
  const shown = await withTenant(db, current.context, (trx) => readContact(trx, current, f.id));
  await runCommand(
    services,
    updateContactCommand,
    {
      id: f.id,
      doNotContact: true,
      doNotContactReason: reason,
      preferencesRevision: shown.preferencesRevision,
    },
    f.invocation(),
  );
  expect(await f.outcomes()).toEqual({ email: stoppedForAll, sms: stoppedForAll });
});

it('stops a message already queued when do not disturb is turned on for its channel before it is sent', async () => {
  const f = await fixture();
  const email = await f.queue('email');
  const sms = await f.queue('sms');
  expect(await f.message(email)).toEqual(sent);
  await f.dnd(false, ['email']);
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries += 1;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: randomUUID() });
    },
  });
  await task.run({ messageId: email }, { invocation: f.invocation(), services });
  expect(deliveries).toBe(0);
  expect(await f.message(email)).toEqual(stoppedForChannel);
  // The text message, on a channel that is not switched off, goes out.
  await task.run({ messageId: sms }, { invocation: f.invocation(), services });
  expect(deliveries).toBe(1);
  expect((await f.message(sms)).status).toBe('sent');
});

it('comes before a blocked address and withdrawn consent, which still stop the channel once it is off', async () => {
  const f = await fixture();
  await database.withTenant(f.context, async (sql) => {
    await sql.query(
      "insert into messaging.suppressions (business_id,channel,address_normalized,reason) values (app.business_id(),'email','recipient@example.test','hard_bounce')",
    );
    await sql.query(
      `insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind,recorded_at)
       select business_id,id,'sms','marketing','withdrawn','user','system',clock_timestamp() from crm.contacts`,
    );
  });
  await f.dnd(false, ['email', 'sms']);
  expect(await f.outcomes()).toEqual({ email: stoppedForChannel, sms: stoppedForChannel });
  await f.dnd(false, []);
  expect(await f.outcomes()).toEqual({
    email: { status: 'failed', error_code: 'suppressed', error_detail: 'hard_bounce' },
    sms: { status: 'failed', error_code: 'consent_withdrawn', error_detail: null },
  });
});
