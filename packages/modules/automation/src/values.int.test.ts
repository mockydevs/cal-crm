// What conditions and merge fields read of a contact: each value under its canonical path,
// in the type it is stored as. Real Postgres and real CRM rows.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { attributionPaths, isAttributionPath } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, type TenantContext } from '@repo/kernel';
import { createContactCommand } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { contactValues } from './values.js';

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

async function business(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, correlationId: randomUUID() };
}

/** A contact made by the CRM's own command, by its stored id. */
async function contact(
  context: TenantContext,
  input: {
    firstName: string;
    lastName?: string;
    emails?: string[];
    source?: string;
    type?: 'lead' | 'customer';
  },
): Promise<string> {
  const created = await runCommand(services, createContactCommand, input, {
    context,
    permissions: 'all',
  });
  const id = parsePublicId('contact', created.id);
  if (id === undefined) throw new Error('The contact has no id.');
  return id;
}

type ValueColumn =
  'value_text' | 'value_number' | 'value_date' | 'value_datetime' | 'value_bool' | 'value_options';

/** A custom contact field and the contact's value for it, as the CRM stores them. */
async function customValue(
  context: TenantContext,
  recordId: string,
  field: {
    key: string;
    type: string;
    column: ValueColumn;
    value: unknown;
    options?: readonly { key: string; label: string }[];
    archived?: boolean;
  },
): Promise<void> {
  await database.withTenant(context, async (sql) => {
    const { id } = await sql.one<{ id: string }>(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, value_type, options, archived_at, created_by_kind)
       select app.business_id(), id, $1::text, $1::text, $2::text, $3::jsonb,
              case when $4::boolean then now() end, 'system'
       from crm.object_types where kind = 'contact'
       returning id`,
      [field.key, field.type, JSON.stringify(field.options ?? []), field.archived ?? false],
    );
    await sql.query(
      `insert into crm.field_values
         (business_id, record_id, field_id, value_type, ${field.column}, source_kind)
       values (app.business_id(), $1, $2, $3, $4, 'system')`,
      [recordId, id, field.type, field.value],
    );
  });
}

const read = (context: TenantContext, recordId: string) =>
  withTenant(db, context, (trx) => contactValues(trx, recordId));

it("gives a contact's own details, primary addresses, tags and custom fields by path", async () => {
  const context = await business();
  const email = `${randomUUID()}@example.test`;
  const id = await contact(context, {
    firstName: 'Ada',
    lastName: 'Lovelace',
    emails: [email],
    source: 'Trade fair 2026',
    type: 'lead',
  });
  await database.withTenant(context, async (sql) => {
    await sql.query(
      `insert into crm.contact_identities
         (business_id, contact_id, kind, value, value_normalized, is_primary)
       values (app.business_id(), $1, 'phone', '(415) 555-0123', '+14155550123', true),
              (app.business_id(), $1, 'phone', '(415) 555-0199', '+14155550199', false)`,
      [id],
    );
    const tag = await sql.one<{ id: string }>(
      `insert into crm.tags (business_id, name, created_by_kind)
       values (app.business_id(), 'VIP', 'system') returning id`,
    );
    await sql.query(
      `insert into crm.record_tags (business_id, record_id, tag_id, source_kind)
       values (app.business_id(), $1, $2, 'system')`,
      [id, tag.id],
    );
  });
  await customValue(context, id, {
    key: 'venue',
    type: 'text',
    column: 'value_text',
    value: 'The Old Mill',
  });
  await customValue(context, id, {
    key: 'guests',
    type: 'number',
    column: 'value_number',
    value: 120,
  });
  await customValue(context, id, {
    key: 'event_date',
    type: 'date',
    column: 'value_date',
    value: '2027-06-12',
  });
  await customValue(context, id, {
    key: 'tasting_at',
    type: 'datetime',
    column: 'value_datetime',
    value: '2027-05-01T10:00:00.000Z',
  });
  // A stored "no" is a value, not a gap.
  await customValue(context, id, {
    key: 'newsletter',
    type: 'boolean',
    column: 'value_bool',
    value: false,
  });
  await customValue(context, id, {
    key: 'services',
    type: 'multi_choice',
    column: 'value_options',
    value: ['opt_planning', 'opt_lighting'],
    options: [
      { key: 'opt_planning', label: 'Planning' },
      { key: 'opt_lighting', label: 'Lighting' },
    ],
  });
  // A field the business archived is no longer something a condition can read.
  await customValue(context, id, {
    key: 'old_notes',
    type: 'text',
    column: 'value_text',
    value: 'Kept, but out of use',
    archived: true,
  });

  const everything = await read(context, id);
  // Where the contact came from is read beside these, leaf by leaf (attribution.int.test.ts).
  expect(Object.keys(everything).filter(isAttributionPath)).toEqual(
    attributionPaths.filter((path) => path.startsWith('contact.')),
  );
  const values = Object.fromEntries(
    Object.entries(everything).filter(([path]) => !isAttributionPath(path)),
  );
  expect(values).toEqual({
    'contact.firstName': 'Ada',
    'contact.lastName': 'Lovelace',
    'contact.name': 'Ada Lovelace',
    'contact.email': email,
    'contact.phone': '+14155550123',
    'contact.tags': ['VIP'],
    // Where the contact came from, in the words of the business, and lead or customer.
    'contact.source': 'Trade fair 2026',
    'contact.type': 'lead',
    'contact.createdAt': expect.any(String) as string,
    'contact.updatedAt': expect.any(String) as string,
    // What email verification found of the primary address: no check yet.
    'contact.emailVerification': 'unchecked',
    'contact.emailVerified': false,
    'contact.custom.venue': 'The Old Mill',
    'contact.custom.guests': 120,
    'contact.custom.event_date': '2027-06-12',
    'contact.custom.tasting_at': '2027-05-01T10:00:00.000Z',
    'contact.custom.newsletter': false,
    'contact.custom.services': ['opt_planning', 'opt_lighting'],
    // The same values under each field's merge key, which a message may also use.
    'contact.venue': 'The Old Mill',
    'contact.guests': 120,
    'contact.event_date': '2027-06-12',
    'contact.tasting_at': '2027-05-01T10:00:00.000Z',
    'contact.newsletter': false,
    'contact.services': ['opt_planning', 'opt_lighting'],
  });
  const createdAt = values['contact.createdAt'];
  expect(typeof createdAt === 'string' && new Date(createdAt).toISOString()).toBe(createdAt);
});

it('gives no address or tag a contact lacks, and nothing for a record that is not a contact', async () => {
  const context = await business();
  const other = await business();
  const id = await contact(context, { firstName: 'Grace' });
  expect(await read(context, id)).toMatchObject({
    'contact.firstName': 'Grace',
    'contact.lastName': null,
    'contact.name': 'Grace',
    'contact.email': null,
    'contact.phone': null,
    'contact.tags': [],
    'contact.source': null,
    'contact.type': null,
    'contact.emailVerification': null,
    'contact.emailVerified': null,
  });
  expect(await read(context, randomUUID())).toEqual({});
  // Another business reads nothing of this contact.
  expect(await read(other, id)).toEqual({});
});
