// PARKED: needs packages/modules/crm/proposed/contact-settings/root-seam.patch applied, and
// @repo/contracts and @repo/module-crm rebuilt. Then it moves to
// packages/modules/messaging/src/contact-settings-outbound.int.test.ts: messaging already
// depends on the CRM module, and the CRM module must not depend on messaging.
//
// What the contact's own settings do to sending, end to end: the real contact command
// changes them, and the real send check (queueOutboundMessage and the dispatch task, which
// both run policyFacts and evaluateOutboundPolicy) reads them. outbound.int.test.ts already
// proves the check against a flag written by SQL; this proves the command writes what the
// check reads.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { readContact, updateContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';

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

const revisionOf = z.looseObject({ preferencesRevision: z.string() });

async function fixture(quietHours: boolean) {
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
      'insert into messaging.settings (business_id,quiet_hours_enabled) values (app.business_id(),$1)',
      [quietHours],
    );
    await sql.query(
      "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values (app.business_id(),$1,'email','marketing','granted','user','system')",
      [contact.id],
    );
    const identity = await sql.one<{ id: string }>(
      'select id from crm.contact_identities where contact_id=$1',
      [contact.id],
    );
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id,channel,name) values (app.business_id(),'email','Fixture sender') returning id",
    );
    return { identity, account };
  });
  const id = toPublicId('contact', contact.id);
  /** Changes the contact through its command, based on what it shows now. */
  const change = async (settings: Record<string, unknown>) => {
    const current = invocation();
    const shown = revisionOf.parse(
      await withTenant(db, current.context, (trx) => readContact(trx, current, id)),
    );
    await runCommand(
      services,
      updateContactCommand,
      { id, ...settings, preferencesRevision: shown.preferencesRevision },
      invocation(),
    );
  };
  const queue = () => {
    const { context } = invocation();
    return withTenant(db, context, (trx) =>
      queueOutboundMessage(trx, context, {
        identityId: rows.identity.id,
        accountId: rows.account.id,
        channel: 'email',
        purpose: 'marketing',
        lane: 'campaign',
        idempotencyKey: randomUUID(),
        subject: 'Fixture',
        text: 'Body',
      }),
    );
  };
  const message = (messageId: string) =>
    database.withTenant(business.context, (sql) =>
      sql.one<{ status: string; error_code: string | null }>(
        'select status,error_code from messaging.messages where id=$1',
        [messageId],
      ),
    );
  return { invocation, change, queue, message, business };
}

const reason = 'Asked by phone on 9 October to stop.';

it('refuses every new message once the contact command turns do not contact on, and lets them through again once it turns it off', async () => {
  const f = await fixture(false);
  await f.change({ doNotContact: true, doNotContactReason: reason });
  expect(await f.message(await f.queue())).toEqual({
    status: 'failed',
    error_code: 'do_not_contact',
  });
  expect(await database.runJobs(['messaging.dispatch'])).toEqual([]);

  await f.change({ doNotContact: false, doNotContactReason: 'Asked in person to hear from us.' });
  const allowed = await f.queue();
  expect(await f.message(allowed)).toEqual({ status: 'queued', error_code: null });
  expect(await database.runJobs(['messaging.dispatch'])).toHaveLength(1);
});

it('stops a message that was already queued when do not contact is turned on before it is sent', async () => {
  const f = await fixture(false);
  const messageId = await f.queue();
  expect(await f.message(messageId)).toEqual({ status: 'queued', error_code: null });
  await f.change({ doNotContact: true, doNotContactReason: reason });
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries += 1;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: randomUUID() });
    },
  });
  await task.run({ messageId }, { invocation: f.invocation(), services });
  expect(deliveries).toBe(0);
  expect(await f.message(messageId)).toEqual({ status: 'failed', error_code: 'do_not_contact' });
});

it("keeps quiet hours by the business's time zone for a contact with none of its own", async () => {
  const f = await fixture(true);
  // Sent now or held until quiet hours end, by the business's clock: never refused.
  const untimed = await f.message(await f.queue());
  expect(untimed.status).toBe('queued');
  expect([null, 'quiet_hours']).toContain(untimed.error_code);
  // Any letter case: the command stores the name PostgreSQL lists, which the check joins on.
  await f.change({ timeZone: 'africa/nairobi' });
  const timed = await f.message(await f.queue());
  expect(timed.status).toBe('queued');
  expect([null, 'quiet_hours']).toContain(timed.error_code);
  // An abbreviation stored before it was refused is no place: the business's zone is used.
  await database.as('postgres', (sql) =>
    sql.query("update crm.contacts set timezone = 'EST' where business_id = $1", [f.business.id]),
  );
  const abbreviated = await f.message(await f.queue());
  expect(abbreviated.status).toBe('queued');
  expect([null, 'quiet_hours']).toContain(abbreviated.error_code);
});
