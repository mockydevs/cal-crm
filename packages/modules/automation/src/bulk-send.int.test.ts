// Contacts → bulk actions → Send SMS and Send Email: each contact's message is queued
// through messaging's own outbound path, filled in with its values, once for its key, and
// only as messaging's policy allows. Real Postgres and the real outbound path; no provider,
// so queued is as far as this goes.
import { randomInt, randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { addPhoneNumber } from '../test/phone-number.js';
import { createBulkMessages } from './bulk-send.js';

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

const sending = createBulkMessages({ smsAvailable: true });

/** A business with one contact, Ada, who has a phone number. Quiet hours are off. */
async function scene() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, businessId: business.id, correlationId: randomUUID() };
  const invocation: Invocation = { context, permissions: 'all' };
  const phone = `+1202${String(randomInt(2, 10))}${String(randomInt(20, 100))}${String(randomInt(0, 10_000)).padStart(4, '0')}`;
  await runCommand(
    services,
    createContactCommand,
    { firstName: 'Ada', phones: [phone] },
    invocation,
  );
  const contactId = await withTenant(db, context, async (trx) => {
    const row = await trx.selectFrom('crm.contacts').select('id').executeTakeFirstOrThrow();
    return row.id;
  });
  const superuser = <T>(work: (sql: Sql) => Promise<T>) => database.as('postgres', work);
  await superuser((sql) =>
    sql.query(
      `insert into messaging.settings (business_id, quiet_hours_enabled) values ($1, false)
       on conflict (business_id) do update set quiet_hours_enabled = false`,
      [business.id],
    ),
  );
  return {
    context: context as TenantContext & { readonly businessId: string },
    invocation,
    contactId,
    phone,
    number: (name: string) => superuser((sql) => addPhoneNumber(sql, context, name)),
    consent: () =>
      superuser((sql) =>
        sql.query(
          `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
           values ($1, $2, 'sms', 'marketing', 'granted', 'user', 'user')`,
          [business.id, contactId],
        ),
      ),
    messages: () =>
      database.withTenant(context, (sql) =>
        sql.query<{ status: string; error_code: string | null; body_text: string }>(
          'select status, error_code, body_text from messaging.messages order by created_at, id',
        ),
      ),
  };
}

it('queues the text filled in for the contact, once for its key, as marketing on the workflow lane', async () => {
  const s = await scene();
  await s.number('Front desk');
  await s.consent();
  const message = {
    channel: 'sms' as const,
    message: 'Hi {{contact.firstName}}, we open Saturday.',
  };
  expect(await withTenant(db, s.context, (trx) => sending.check(trx, s.invocation, message))).toBe(
    undefined,
  );
  const send = () =>
    withTenant(db, s.context, async (trx) => {
      await sending.hold(trx, s.invocation);
      return sending.send(trx, s.invocation, message, {
        id: s.contactId,
        idempotencyKey: `contact-bulk:${s.contactId}`,
      });
    });
  expect(await send()).toEqual({ queued: true });
  expect(await send()).toEqual({ queued: true });
  expect(await s.messages()).toEqual([
    { status: 'queued', error_code: null, body_text: 'Hi Ada, we open Saturday.' },
  ]);
  const lanes = await database.withTenant(s.context, (sql) =>
    sql.query<{ purpose: string; lane: string }>(
      'select purpose, lane from messaging.outbound_dispatch',
    ),
  );
  expect(lanes).toEqual([{ purpose: 'marketing', lane: 'automation' }]);
});

it('says why a contact is not sent it: no consent, no number to send to', async () => {
  const s = await scene();
  await s.number('Front desk');
  const send = (key: string) =>
    withTenant(db, s.context, (trx) =>
      sending.send(
        trx,
        s.invocation,
        { channel: 'sms', message: 'Hi' },
        { id: s.contactId, idempotencyKey: key },
      ),
    );
  // No consent to marketing texts is recorded: messaging refuses it and keeps why.
  expect(await send('first')).toEqual({ queued: false, reason: 'no_consent' });
  expect(await s.messages()).toEqual([
    expect.objectContaining({ status: 'failed', error_code: 'consent_required' }),
  ]);
  await database.as('postgres', (sql) =>
    sql.query(`delete from crm.contact_identities where contact_id = $1 and kind = 'phone'`, [
      s.contactId,
    ]),
  );
  expect(await send('second')).toEqual({ queued: false, reason: 'no_address' });
});

it('refuses a sender that cannot send before any contact is reached', async () => {
  const s = await scene();
  const check = (message: Parameters<typeof sending.check>[2], with_ = sending) =>
    withTenant(db, s.context, (trx) => with_.check(trx, s.invocation, message));
  // No number, then two, of which none is named.
  expect(await check({ channel: 'sms', message: 'Hi' })).toMatchObject({
    path: '/number',
    code: 'number_required',
  });
  await s.number('Front desk');
  await s.number('Back office');
  expect(await check({ channel: 'sms', message: 'Hi' })).toMatchObject({
    code: 'number_required',
  });
  // An install that can't hand a text to its provider can't send one at all.
  expect(
    await check({ channel: 'sms', message: 'Hi' }, createBulkMessages({ smsAvailable: false })),
  ).toMatchObject({ path: '/action', code: 'sms_unavailable' });
  // No mailbox works for conversations.
  expect(await check({ channel: 'email', subject: 'Hi', body: 'Hi' })).toMatchObject({
    path: '/mailbox',
    code: 'mailbox_required',
  });
});

it('counts bulk emails against the agency’s daily ceiling on campaign emails', async () => {
  const s = await scene();
  // The business's only mailbox, working and for conversations.
  const account = await database.as('postgres', async (sql) => {
    const [secret] = await sql.query<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'mailbox.password', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
       returning id`,
      [s.context.agencyId, s.context.businessId],
    );
    const [made] = await sql.query<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name, status)
       values ($1, 'email', 'Front desk', 'active') returning id`,
      [s.context.businessId],
    );
    await sql.query(
      `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
         smtp_port, smtp_security, smtp_username, imap_host, imap_port, imap_security,
         imap_username, secret_id, use_for_conversations)
       values ($1, $2, 'desk@example.test', 'password', 'mail.example.test', 587, 'starttls',
         'desk@example.test', 'mail.example.test', 993, 'tls', 'desk@example.test', $3, true)`,
      [s.context.businessId, made?.id, secret?.id],
    );
    return made?.id;
  });
  const ceiling = createBulkMessages({ smsAvailable: true, agencyDailyLimit: 2 });
  const room = () => withTenant(db, s.context, (trx) => ceiling.emailAllowance(trx, s.invocation));
  expect(await room()).toBe(2);
  // Without a ceiling there is no room to count.
  expect(
    await withTenant(db, s.context, (trx) => sending.emailAllowance(trx, s.invocation)),
  ).toBeNull();
  // One bulk email queued, and one refused, which does not count.
  await database.as('postgres', async (sql) => {
    const [conversation] = await sql.query<{ id: string }>(
      `insert into messaging.conversations (business_id, contact_id) values ($1, $2) returning id`,
      [s.context.businessId, s.contactId],
    );
    for (const [key, status] of [
      ['contact-bulk:a', 'queued'],
      ['contact-bulk:b', 'failed'],
    ] as const)
      await sql.query(
        `insert into messaging.messages (business_id, conversation_id, channel, channel_account_id,
           direction, status, author_kind, idempotency_key, body_text, to_addresses)
         values ($1, $2, 'email', $3, 'outbound', $4, 'user', $5, 'Hi', array['ada@example.test'])`,
        [s.context.businessId, conversation?.id, account, status, key],
      );
  });
  expect(await room()).toBe(1);
  const email = { channel: 'email' as const, subject: 'Hi', body: 'Hi' };
  expect(
    await withTenant(db, s.context, (trx) => ceiling.check(trx, s.invocation, email)),
  ).toBeUndefined();
  // With no room left, a bulk email cannot be started.
  const full = createBulkMessages({ smsAvailable: true, agencyDailyLimit: 1 });
  expect(await withTenant(db, s.context, (trx) => full.emailAllowance(trx, s.invocation))).toBe(0);
  expect(
    await withTenant(db, s.context, (trx) => full.check(trx, s.invocation, email)),
  ).toMatchObject({ path: '/action', code: 'daily_limit_reached' });
});
