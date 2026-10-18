import { randomUUID } from 'node:crypto';
import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { NotFoundError, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { sql } from 'kysely';
import * as z from 'zod';
import { addressConsentStatus } from './consent-state.js';
import {
  recordFormConsent,
  type FormConsentInput,
  type FormConsentOutcome,
} from './form-consent.js';

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

const record = defineCommand({
  name: 'test.form.consent',
  permission: 'contacts.manage',
  // The forms module's own command checks its input; this one passes it through.
  input: z.custom<FormConsentInput>(() => true),
  audit: () => ({ source: 'form' }),
  handle: (trx, input, command): Promise<FormConsentOutcome> =>
    recordFormConsent(trx, command, input),
});

const PHONE = '+12125550147';

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context, {
    email: 'maya@example.test',
  });
  await database.withTenant(business.context, (sql) =>
    sql.query(
      `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, is_primary)
       values (app.business_id(), $1, 'phone', '+1 212 555 0147', $2, true)`,
      [contact.id, PHONE],
    ),
  );
  const formId = randomUUID();
  const invocation: Invocation = {
    context: {
      ...business.context,
      actorKind: 'form',
      actorId: formId,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  const input = {
    contactId: contact.id,
    channel: 'email' as const,
    // As the visitor typed it.
    address: ' Maya@Example.TEST ',
    wording: 'Email me news and offers.',
    formId,
    submissionId: randomUUID(),
    ipAddress: '203.0.113.10',
    pageUrl: 'https://www.example.com/contact',
    userAgent: 'Browser/1.0',
  };
  const ledger = () =>
    database.withTenant(business.context, (sql) =>
      sql.query<{
        channel: string;
        purpose: string;
        status: string;
        source: string;
        proof: Record<string, string>;
        recorded_by_kind: string;
        recorded_by_id: string;
      }>(
        'select channel,purpose,status,source,proof,recorded_by_kind,recorded_by_id from messaging.consents order by recorded_at,id',
      ),
    );
  const texts = { ...input, channel: 'sms' as const, address: PHONE };
  return { business, contact, invocation, input, texts, ledger };
}

it('records a ticked box as marketing consent with the form, the submission, the wording and the address', async () => {
  const f = await fixture();
  expect(await runCommand(services, record, f.input, f.invocation)).toBe('granted');
  expect(await f.ledger()).toEqual([
    {
      channel: 'email',
      purpose: 'marketing',
      status: 'granted',
      source: 'form',
      proof: {
        wording: 'Email me news and offers.',
        formId: f.input.formId,
        submissionId: f.input.submissionId,
        ipAddress: '203.0.113.10',
        pageUrl: 'https://www.example.com/contact',
        userAgent: 'Browser/1.0',
      },
      // The contact agreed for themselves; the form is not who consented.
      recorded_by_kind: 'contact',
      recorded_by_id: f.contact.id,
    },
  ]);
  // The timeline says consent was given and from where, and holds none of the proof.
  const events = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ type: string; payload: unknown; actor_kind: string }>(
      "select type,payload,actor_kind from events.events where type like 'consent.%'",
    ),
  );
  expect(events).toEqual([
    {
      type: 'consent.granted',
      payload: { channel: 'email', purpose: 'marketing', source: 'form' },
      actor_kind: 'form',
    },
  ]);
  // A second channel is its own entry, and leaves the first alone.
  expect(
    await runCommand(services, record, { ...f.texts, submissionId: randomUUID() }, f.invocation),
  ).toBe('granted');
  expect((await f.ledger()).map((row) => [row.channel, row.status])).toEqual([
    ['email', 'granted'],
    ['sms', 'granted'],
  ]);
});

it('never undoes a withdrawal: the contact stays unsubscribed and nothing is written', async () => {
  const f = await fixture();
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into messaging.consents(business_id,contact_id,channel,purpose,status,source,proof,recorded_by_kind,recorded_by_id)
       values(app.business_id(),$1,'email','marketing','withdrawn','unsubscribe_link','{}','contact',$1)`,
      [f.contact.id],
    ),
  );
  expect(await runCommand(services, record, f.input, f.invocation)).toBe('withdrawn_kept');
  expect((await f.ledger()).map((row) => [row.channel, row.status, row.source])).toEqual([
    ['email', 'withdrawn', 'unsubscribe_link'],
  ]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select 1 from events.events where type like 'consent.%'"),
    ),
  ).toEqual([]);
  // The withdrawal is of email marketing only: the same box for texts is recorded.
  expect(await runCommand(services, record, f.texts, f.invocation)).toBe('granted');
  // And transactional email consent, withdrawn or not, is none of a marketing box's business.
  expect((await f.ledger()).map((row) => [row.channel, row.purpose, row.status])).toEqual([
    ['email', 'marketing', 'withdrawn'],
    ['sms', 'marketing', 'granted'],
  ]);
});

it('renews consent that was already given, as a new entry with its own proof', async () => {
  const f = await fixture();
  await runCommand(services, record, f.input, f.invocation);
  const again = { ...f.input, submissionId: randomUUID(), ipAddress: '2001:db8::7' };
  expect(await runCommand(services, record, again, f.invocation)).toBe('granted');
  expect((await f.ledger()).map((row) => [row.status, row.proof['ipAddress']])).toEqual([
    ['granted', '203.0.113.10'],
    ['granted', '2001:db8::7'],
  ]);
});

it('refuses proof it cannot stand behind, and a contact that is not there', async () => {
  const f = await fixture();
  for (const change of [
    { ipAddress: 'not-an-address' },
    { ipAddress: '' },
    { wording: '   ' },
    { wording: 'x'.repeat(2001) },
    { channel: 'whatsapp' },
    { formId: 'form_01h455vb4pex5vsknk084sn02q' },
    { submissionId: 'latest' },
    { pageUrl: 'javascript:alert(1)' },
    { userAgent: 'x'.repeat(501) },
    { purpose: 'transactional' },
    { status: 'granted' },
    { note: 'Said so on the phone.' },
  ])
    await expect(
      runCommand(services, record, { ...f.input, ...change }, f.invocation),
    ).rejects.toBeInstanceOf(ValidationError);
  const elsewhere = await database.fixtures.business((await database.fixtures.agency()).id);
  const foreign = await database.fixtures.contact(elsewhere.context);
  await expect(
    runCommand(services, record, { ...f.input, contactId: foreign.id }, f.invocation),
  ).rejects.toBeInstanceOf(NotFoundError);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.contacts set deleted_at=now() where id=$1', [f.contact.id]),
  );
  await expect(runCommand(services, record, f.input, f.invocation)).rejects.toBeInstanceOf(
    NotFoundError,
  );
  expect(await f.ledger()).toEqual([]);
});

it('keeps the ledger as it was when the submission it belongs to fails', async () => {
  const f = await fixture();
  const failing = defineCommand({
    name: 'test.form.consent_then_fail',
    permission: 'contacts.manage',
    input: z.custom<FormConsentInput>(() => true),
    audit: () => ({ source: 'form' }),
    async handle(trx, input, command): Promise<never> {
      await recordFormConsent(trx, command, input);
      throw new Error('The submission could not be stored.');
    },
  });
  await expect(runCommand(services, failing, f.input, f.invocation)).rejects.toThrow(
    'The submission could not be stored.',
  );
  expect(await f.ledger()).toEqual([]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select 1 from events.events where type like 'consent.%'"),
    ),
  ).toEqual([]);
});

it('records consent for the address the visitor gave, and only one the contact holds', async () => {
  const f = await fixture();
  expect(await runCommand(services, record, f.input, f.invocation)).toBe('granted');
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select channel, address_normalized from messaging.consents'),
    ),
  ).toEqual([{ channel: 'email', address_normalized: 'maya@example.test' }]);
  // A stranger ticks the texts box beside a number of their own, which the contact does not
  // hold: nothing is recorded, and the contact's own number is not consented.
  for (const address of ['+12125550199', 'not a number', 'ada@example.test'])
    expect(
      await runCommand(
        services,
        record,
        { ...f.texts, address, submissionId: randomUUID() },
        f.invocation,
      ),
    ).toBe('no_address');
  expect(
    await runCommand(
      services,
      record,
      { ...f.input, address: 'someone-else@example.test', submissionId: randomUUID() },
      f.invocation,
    ),
  ).toBe('no_address');
  expect((await f.ledger()).map((row) => row.channel)).toEqual(['email']);
});

it("never counts a grant for one address as consent for another of the contact's", async () => {
  const f = await fixture();
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
       values (app.business_id(), $1, 'phone', '+1 212 555 0188', '+12125550188')`,
      [f.contact.id],
    ),
  );
  expect(await runCommand(services, record, f.texts, f.invocation)).toBe('granted');
  const status = (address: string) =>
    withTenant(db, f.invocation.context, async (trx) => {
      const { rows } = await sql<{ status: string }>`select ${addressConsentStatus(
        sql`app.business_id()`,
        sql`${f.contact.id}::uuid`,
        sql`${address}::text`,
        'sms',
        'marketing',
      )} as status`.execute(trx);
      return rows[0]?.status;
    });
  expect(await status(PHONE)).toBe('granted');
  expect(await status('+12125550188')).toBe('unknown');
});
