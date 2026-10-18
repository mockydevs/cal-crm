// Migration 0059 at the database's own level: a contact's followers, a label on a phone
// number, do not disturb by channel, and how a contact came to be; then what the migration
// does to the contacts an install already had. What the CRM and messaging modules do with
// these is theirs to prove.
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TenantContext } from '@repo/kernel';
import { startPostgres, testDatabase, type Postgres, type TestDatabase } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { bootstrapFile, migrate } from './index.js';

const MIGRATION = '0059_contact_page_data.sql';
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

async function business(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, correlationId: randomUUID() };
}
const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};

describe("a contact's followers", () => {
  it('are people, each once, and go with the contact', async () => {
    const context = await business();
    const contact = await database.fixtures.contact(context);
    const user = await database.fixtures.user();
    const follow = (kind = 'user') =>
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.contact_followers (business_id, contact_id, user_id, added_by_kind)
           values (app.business_id(), $1, $2, $3)`,
          [contact.id, user.id, kind],
        ),
      );
    await follow();
    await refused(follow(), 'contact_followers_pkey');
    const count = () =>
      database.as('crm_owner', async (sql) => {
        const rows = await sql.query('select 1 from crm.contact_followers where contact_id = $1', [
          contact.id,
        ]);
        return rows.length;
      });
    expect(await count()).toBe(1);
    // Purging the contact goes through the registry, and takes its followers with it.
    await database.withTenant(context, (sql) =>
      sql.query('delete from crm.records where id = $1', [contact.id]),
    );
    expect(await count()).toBe(0);
  });

  it('are added by a kind of actor the product knows, and never edited', async () => {
    const context = await business();
    const contact = await database.fixtures.contact(context);
    const user = await database.fixtures.user();
    const values = [contact.id, user.id];
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.contact_followers (business_id, contact_id, user_id, added_by_kind)
           values (app.business_id(), $1, $2, 'robot')`,
          values,
        ),
      ),
      'contact_followers_added_by_kind_valid',
    );
    await database.withTenant(context, (sql) =>
      sql.query(
        `insert into crm.contact_followers (business_id, contact_id, user_id, added_by_kind)
         values (app.business_id(), $1, $2, 'automation')`,
        values,
      ),
    );
    await expect(
      database.withTenant(context, (sql) =>
        sql.query(`update crm.contact_followers set added_by_kind = 'user' where contact_id = $1`, [
          contact.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it("can't name another business's contact", async () => {
    const context = await business();
    const other = await database.fixtures.contact(await business());
    const user = await database.fixtures.user();
    await refused(
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.contact_followers (business_id, contact_id, user_id, added_by_kind)
           values (app.business_id(), $1, $2, 'user')`,
          [other.id, user.id],
        ),
      ),
      'contact_followers_business_id_contact_id_fkey',
    );
  });
});

describe('a label on an address', () => {
  const identity = (
    context: TenantContext,
    contactId: string,
    kind: string,
    value: string,
    label: string | null,
  ) =>
    database.withTenant(context, (sql) =>
      sql.one<{ label: string | null }>(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, label)
         values (app.business_id(), $1, $2, $3, $3, $4) returning label`,
        [contactId, kind, value, label],
      ),
    );

  it('is for a phone number only, in the form of a key, and once for a contact', async () => {
    const context = await business();
    const contact = await database.fixtures.contact(context);
    const second = await database.fixtures.contact(context);
    expect((await identity(context, contact.id, 'phone', '+254712000001', null)).label).toBeNull();
    expect((await identity(context, contact.id, 'phone', '+254712000002', 'mobile')).label).toBe(
      'mobile',
    );
    // Another contact uses the same label; this one can't use it twice.
    await identity(context, second.id, 'phone', '+254712000003', 'mobile');
    await refused(
      identity(context, contact.id, 'phone', '+254712000004', 'mobile'),
      'contact_identities_one_label_idx',
    );
    await refused(
      identity(context, contact.id, 'email', 'maya@example.test', 'work'),
      'contact_identities_label_phone_only',
    );
    for (const label of ['', 'Mobile', 'my phone', '1st', 'x'.repeat(31)])
      await refused(
        identity(context, contact.id, 'phone', '+254712000005', label),
        'contact_identities_label_format',
      );
  });
});

describe('do not disturb by channel', () => {
  it('starts empty and names only the channels the pipeline has names for', async () => {
    const context = await business();
    const contact = await database.fixtures.contact(context);
    const set = (channels: string) =>
      database.withTenant(context, (sql) =>
        sql.one<{ dnd_channels: string[] }>(
          `update crm.contacts set dnd_channels = $2::text[] where id = $1 returning dnd_channels`,
          [contact.id, channels],
        ),
      );
    const stored = await database.as('crm_owner', (sql) =>
      sql.one<{ dnd_channels: string[]; do_not_contact: boolean }>(
        'select dnd_channels, do_not_contact from crm.contacts where id = $1',
        [contact.id],
      ),
    );
    expect(stored).toEqual({ dnd_channels: [], do_not_contact: false });
    expect((await set('{call,email,sms,webchat,whatsapp}')).dnd_channels).toHaveLength(5);
    expect((await set('{}')).dnd_channels).toEqual([]);
    await refused(set('{fax}'), 'contacts_dnd_channels_valid');
    await refused(set('{email,email,email,email,email,email}'), 'contacts_dnd_channels_valid');
  });
});

describe('how a contact came to be', () => {
  it('is unknown unless its maker says, and one of the ways the product knows', async () => {
    const context = await business();
    const contact = await database.fixtures.contact(context);
    const set = (source: string) =>
      database.withTenant(context, (sql) =>
        sql.one<{ created_source: string }>(
          'update crm.contacts set created_source = $2 where id = $1 returning created_source',
          [contact.id, source],
        ),
      );
    expect((await set('unknown')).created_source).toBe('unknown');
    for (const source of [
      'user',
      'api',
      'form',
      'booking',
      'import',
      'email',
      'sms',
      'webchat',
      'automation',
      'assistant',
    ])
      expect((await set(source)).created_source).toBe(source);
    await refused(set('telepathy'), 'contacts_created_source_valid');
  });
});

describe('an install that already has contacts', () => {
  let postgres: Postgres;
  let earlier: string;
  beforeAll(async () => {
    postgres = await startPostgres({ bootstrapFile });
    earlier = await mkdtemp(join(tmpdir(), 'crm-before-contact-page-'));
    for (const name of await readdir(migrationsDirectory))
      if (name < MIGRATION) await cp(join(migrationsDirectory, name), join(earlier, name));
  });
  afterAll(async () => {
    await postgres.stop();
    await rm(earlier, { recursive: true, force: true });
  });

  it('gives each the source its maker or its command proves, leaves the rest unknown, and edits none', async () => {
    const name = await postgres.createDatabase();
    const connectionString = postgres.url(name);
    const before = await migrate({ connectionString, directory: earlier });
    expect(before.applied).not.toContain(MIGRATION);

    // crm_owner, as an import or a repair would write: it is not held to a tenant.
    const owner = new pg.Client({ connectionString });
    await owner.connect();
    try {
      const one = async (text: string, values: readonly unknown[] = []): Promise<string> => {
        const { rows } = await owner.query<{ id: string }>(text, [...values]);
        const [row] = rows;
        if (row === undefined) throw new Error(`No row: ${text}`);
        return row.id;
      };
      const agency = await one(
        "insert into tenancy.agencies (name, slug) values ('Agency', 'agency') returning id",
      );
      const tenant = await one(
        "insert into tenancy.businesses (agency_id, name, slug) values ($1, 'Business', 'business') returning id",
        [agency],
      );
      const objectType = await one(
        `insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
         values ($1, 'contact', 'contact', 'Contact', 'Contacts') returning id`,
        [tenant],
      );
      /**
       * A contact as the command of that name made it: the contact, its contact.created
       * event, and the command's audit row naming the event, all in one transaction, so the
       * event and the audit row carry one recorded_at. `audited` false is a contact whose
       * month of the audit log is gone.
       */
      const contact = async (
        label: string,
        kind: string,
        command: string | null,
      ): Promise<string> => {
        await owner.query('begin');
        const id = await one(
          `with record as (
             insert into crm.records (business_id, kind, object_type_id)
             values ($1, 'contact', $2) returning id)
           insert into crm.contacts (business_id, id, first_name, created_by_kind)
           select $1, id, $3, $4 from record returning id`,
          [tenant, objectType, label, kind],
        );
        const event = await one(
          `insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
                                      subject_kind, subject_id)
           values ($1, $2, 'contact.created', $3, gen_random_uuid(), 'contact', $4) returning id`,
          [agency, tenant, kind, id],
        );
        if (command !== null)
          await owner.query(
            `insert into audit.commands (agency_id, business_id, command, actor_kind, outcome,
                                         event_ids, correlation_id)
             values ($1, $2, $3, $4, 'ok', array[$5::uuid], gen_random_uuid())`,
            [agency, tenant, command, kind, event],
          );
        await owner.query('commit');
        return id;
      };
      const cases: readonly (readonly [string, string, string | null, string])[] = [
        ['person', 'user', 'contact.create', 'user'],
        ['key', 'api_key', 'contact.create', 'api'],
        ['form', 'form', 'forms.submit', 'form'],
        ['import', 'import', null, 'import'],
        ['automation', 'automation', null, 'automation'],
        ['assistant', 'ai_agent', null, 'assistant'],
        ['mail', 'system', 'mailbox.ingest_inbound', 'email'],
        ['text', 'system', 'sms.receive', 'sms'],
        ['chat', 'contact', 'webchat.send_message', 'webchat'],
        ['booking', 'contact', 'calendar.public.book', 'booking'],
        // A command this migration has no source for, and a contact with no audit row left.
        ['other', 'system', 'something.else', 'unknown'],
        ['forgotten', 'contact', null, 'unknown'],
      ];
      const ids = new Map<string, string>();
      for (const [label, kind, command] of cases)
        ids.set(label, await contact(label, kind, command));
      // A second audit row at the very same moment that names another event: not this
      // contact's maker, whatever its command.
      await owner.query(
        `insert into audit.commands (agency_id, business_id, command, actor_kind, outcome,
                                     event_ids, correlation_id, recorded_at)
         select agency_id, business_id, 'sms.receive', 'system', 'ok', array[uuidv7()],
                gen_random_uuid(), recorded_at
         from events.events where subject_id = $1`,
        [ids.get('forgotten')],
      );
      // One of them is marked do not contact.
      await owner.query('alter table crm.contacts disable trigger touch_updated_at');
      await owner.query('update crm.contacts set do_not_contact = true where id = $1', [
        ids.get('person'),
      ]);
      await owner.query('alter table crm.contacts enable trigger touch_updated_at');
      const stamps = async () =>
        (
          await owner.query<{ first_name: string; updated_at: string }>(
            'select first_name, updated_at::text from crm.contacts order by first_name',
          )
        ).rows;
      const untouched = await stamps();

      const upgraded = await migrate({ connectionString, directory: migrationsDirectory });
      expect(upgraded.applied).toContain(MIGRATION);

      const { rows } = await owner.query<{ first_name: string; created_source: string }>(
        'select first_name, created_source from crm.contacts',
      );
      expect(Object.fromEntries(rows.map((row) => [row.first_name, row.created_source]))).toEqual(
        Object.fromEntries(cases.map(([label, , , source]) => [label, source])),
      );
      // Being given a source is not an edit of the contact.
      expect(await stamps()).toEqual(untouched);
      // Do not contact is kept exactly: still on for the one contact, and nobody is put on do
      // not disturb for a channel by the upgrade.
      const { rows: settings } = await owner.query<{ first_name: string; dnd: string[] }>(
        `select first_name, dnd_channels as dnd from crm.contacts
         where do_not_contact or dnd_channels <> '{}'`,
      );
      expect(settings).toEqual([{ first_name: 'person', dnd: [] }]);
    } finally {
      await owner.end();
    }
  });
});
