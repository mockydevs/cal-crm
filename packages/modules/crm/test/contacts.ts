// Contacts in bulk for the list's tests: written in one statement as crm_owner, as an
// import would write them.
import type { TestDatabase } from '@repo/testing';

/**
 * Writes `count` contacts into the business: names "First n Last n", an email for each, and
 * a phone number for every other one. Contact n was added n seconds before the newest.
 */
export async function seedContacts(
  database: TestDatabase,
  businessId: string,
  count: number,
): Promise<void> {
  await database.as('crm_owner', (sql) =>
    sql.query(
      `with numbered as (
         select n, uuidv7() as id from generate_series(1, $2::int) as n
       ), records as (
         insert into crm.records (business_id, id, kind, object_type_id)
         select $1, numbered.id, 'contact', types.id
         from numbered, crm.object_types types
         where types.business_id = $1 and types.kind = 'contact'
       ), contacts as (
         insert into crm.contacts
           (business_id, id, first_name, last_name, created_by_kind, created_at)
         select $1, id, 'First' || n, 'Last' || n, 'import', now() - n * interval '1 second'
         from numbered
       ), emails as (
         insert into crm.contact_identities
           (business_id, contact_id, kind, value, value_normalized, is_primary)
         select $1, id, 'email', 'person' || n || '@example.com', 'person' || n || '@example.com', true
         from numbered
       )
       insert into crm.contact_identities
         (business_id, contact_id, kind, value, value_normalized, is_primary)
       select $1, id, 'phone', '+2547' || lpad(n::text, 8, '0'), '+2547' || lpad(n::text, 8, '0'), true
       from numbered where n % 2 = 0`,
      [businessId, count],
    ),
  );
  await database.as('crm_owner', (sql) =>
    sql.query('analyze crm.contacts, crm.contact_identities'),
  );
}

/**
 * Gives every contact of the business what a working business's contacts have, for the
 * list's extras: a timeline of four events (created, two messages received, a tag), one or
 * two of eight tags, and a primary company out of a thousand. Written in one transaction as
 * the superuser with triggers off, as a restore would write it: the queue triggers on
 * events would otherwise add a job for each of 400,000 events.
 */
export async function seedContactExtras(database: TestDatabase, businessId: string): Promise<void> {
  await database.as('postgres', async (sql) => {
    await sql.query(`set local session_replication_role = replica`);
    await sql.query(
      `create temp table seeded on commit drop as
       select c.id, row_number() over (order by c.created_at desc, c.id desc) as n, b.agency_id
       from crm.contacts c join tenancy.businesses b on b.id = c.business_id
       where c.business_id = $1`,
      [businessId],
    );
    await sql.query(
      `create temp table happened on commit drop as
       select seeded.id as record_id, seeded.agency_id, kinds.type, uuidv7() as event_id,
              now() - (seeded.n % 5000) * interval '1 minute' - kinds.age as at, kinds.payload
       from seeded,
         (values ('contact.created', interval '3 hours', '{}'::jsonb),
                 ('message.received', interval '2 hours', '{"channel": "sms"}'::jsonb),
                 ('message.received', interval '1 hour', '{"mailboxId": "seeded"}'::jsonb),
                 ('tag.assigned', interval '0 hours', '{}'::jsonb)) as kinds (type, age, payload)`,
    );
    await sql.query(
      `insert into events.events (id, agency_id, business_id, type, actor_kind, correlation_id,
                                  subject_kind, subject_id, payload, occurred_at)
       select event_id, agency_id, $1, type, 'system', uuidv7(), 'record', record_id, payload, at
       from happened`,
      [businessId],
    );
    await sql.query(
      `insert into crm.timeline_entries
         (business_id, record_id, occurred_at, event_id, event_recorded_at, event_type)
       select $1, h.record_id, e.occurred_at, e.id, e.recorded_at, e.type
       from happened h join events.events e on e.id = h.event_id`,
      [businessId],
    );
    await sql.query(
      `with tags as (
         insert into crm.tags (business_id, name, created_by_kind)
         select $1, 'Seeded tag ' || n, 'import' from generate_series(1, 8) as n
         returning id, name
       ), numbered as (
         select id, row_number() over (order by name) as n from tags
       )
       insert into crm.record_tags (business_id, record_id, tag_id, source_kind)
       select $1, seeded.id, numbered.id, 'import'
       from seeded join numbered on numbered.n = seeded.n % 8 + 1 or numbered.n = seeded.n % 5 + 1`,
      [businessId],
    );
    await sql.query(
      `with companies as (
         select uuidv7() as id, n from generate_series(1, 1000) as n
       ), records as (
         insert into crm.records (business_id, id, kind, object_type_id)
         select $1, companies.id, 'company', types.id
         from companies, crm.object_types types
         where types.business_id = $1 and types.kind = 'company'
       ), made as (
         insert into crm.companies (business_id, id, name, created_by_kind)
         select $1, id, 'Seeded company ' || n, 'import' from companies
       ), link as (
         insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id,
                                     label, reverse_label, allows_primary)
         select $1, 'contact_company', origin.id, target.id, 'Company', 'Person', true
         from crm.object_types origin, crm.object_types target
         where origin.business_id = $1 and origin.kind = 'contact'
           and target.business_id = $1 and target.kind = 'company'
         returning id
       )
       insert into crm.record_links (business_id, link_type_id, from_record_id, to_record_id,
                                     is_primary, source_kind)
       select $1, link.id, seeded.id, companies.id, true, 'import'
       from seeded join companies on companies.n = seeded.n % 1000 + 1, link`,
      [businessId],
    );
  });
  await database.as('crm_owner', (sql) =>
    sql.query(
      `analyze crm.timeline_entries, events.events, crm.record_tags, crm.tags, crm.record_links,
               crm.companies`,
    ),
  );
}

/**
 * Gives the business's contacts what the Filters panel asks about, in proportions that make
 * some conditions rare and others common: an owner for 1 in 50, a type and a date of birth
 * for 1 in 3 and 1 in 4, a tag held by 20 contacts, a text field for 1 in 10 (a hundred
 * contacts for each of its hundred values) and a number field for every contact (0 to 999).
 * Run after seedContactExtras, whose tags it adds to.
 */
export async function seedContactFilterData(
  database: TestDatabase,
  businessId: string,
  fields: { readonly text: string; readonly number: string },
  ownerUserId: string,
): Promise<void> {
  await database.as('postgres', async (sql) => {
    await sql.query(`set local session_replication_role = replica`);
    await sql.query(
      `create temp table numbered on commit drop as
       select c.id, row_number() over (order by c.created_at desc, c.id desc) as n
       from crm.contacts c where c.business_id = $1`,
      [businessId],
    );
    await sql.query(
      `update crm.contacts c
       set owner_user_id = case when numbered.n % 50 = 0 then $2::uuid end,
           contact_type = case when numbered.n % 3 = 0 then 'lead' end,
           date_of_birth = case when numbered.n % 4 = 0
                                then date '1980-01-01' + (numbered.n % 9000)::integer end
       from numbered where c.business_id = $1 and c.id = numbered.id`,
      [businessId, ownerUserId],
    );
    await sql.query(
      `with tag as (
         insert into crm.tags (business_id, name, created_by_kind)
         values ($1, 'Rare tag', 'import') returning id
       )
       insert into crm.record_tags (business_id, record_id, tag_id, source_kind)
       select $1, numbered.id, tag.id, 'import' from numbered, tag where numbered.n % 5000 = 0`,
      [businessId],
    );
    await sql.query(
      `insert into crm.field_values
         (business_id, record_id, field_id, value_type, value_text, source_kind)
       select $1, id, $2, 'text', 'City ' || ((n / 10) % 100), 'import'
       from numbered where n % 10 = 0`,
      [businessId, fields.text],
    );
    await sql.query(
      `insert into crm.field_values
         (business_id, record_id, field_id, value_type, value_number, source_kind)
       select $1, id, $2, 'number', n % 1000, 'import' from numbered`,
      [businessId, fields.number],
    );
  });
  await database.as('crm_owner', (sql) =>
    sql.query('analyze crm.contacts, crm.record_tags, crm.tags, crm.field_values'),
  );
}
