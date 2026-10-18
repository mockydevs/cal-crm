// Merging contacts against a migrated Postgres, as crm_app: what the contact kept takes from
// the others field by field, what moves to it and how, what the others become, and every
// refusal. The merge's participants here are stand-ins for the modules' own.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  runCommand,
  type CommandContext,
  type Invocation,
  type Services,
} from '@repo/commands';
import {
  MAX_CONTACT_MERGE_ROWS,
  contactMerge,
  contactMergePreview,
  type ContactMergePreview,
} from '@repo/contracts';
import { connectDatabase, withTenant } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql as query } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions } from '../../test/contact-details.js';
import { createContactCommand, readContact, restoreContactCommand } from './contacts.js';
import { readContactDetails } from './details.js';
import type { ContactMergeParticipant } from './merge.js';
import { contactMergeRoutes } from './merge-routes.js';

let database: TestDatabase;
let services: Services;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  services = {
    db: connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    }),
    authorize: allowEveryone,
  };
});
afterAll(async () => {
  await services.db.destroy();
  await database.close();
});

interface Space {
  readonly businessId: string;
  readonly context: TenantContext;
  readonly owner: Invocation;
}

async function space(): Promise<Space> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, actorKind: 'user' as const, correlationId: randomUUID() };
  return {
    businessId: business.id,
    context: business.context,
    owner: { context, permissions: 'all' },
  };
}

/** A contact made as the API makes one: with its first touch and its identities. */
async function person(
  where: Space,
  values: {
    firstName?: string;
    lastName?: string;
    emails?: string[];
    phones?: string[];
    dnd?: { all?: boolean; channels?: ('email' | 'sms' | 'call' | 'whatsapp' | 'webchat')[] };
  },
): Promise<{ id: string; uuid: string }> {
  const made = await runCommand(services, createContactCommand, values, where.owner);
  return { id: made.id, uuid: parsePublicId('contact', made.id) ?? '' };
}

const sql = <Row extends object>(where: Space, text: string, values: unknown[] = []) =>
  database.withTenant(where.context, (each) => each.query<Row>(text, values));
const owner = <Row extends object>(text: string, values: unknown[] = []) =>
  database.as('crm_owner', (each) => each.query<Row>(text, values));

function routes(participants: readonly ContactMergeParticipant[] = []) {
  const all = contactMergeRoutes({ participants });
  const find = (operationId: string) => {
    const route = all.find((each) => each.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`Missing ${operationId}.`);
    return route;
  };
  return {
    preview: async (
      invocation: Invocation,
      id: string,
      mergeIds: string[],
    ): Promise<ContactMergePreview> =>
      contactMergePreview.parse(
        await find('previewContactMerge').run(
          { invocation, params: { id }, query: { mergeIds: mergeIds.join(',') }, body: undefined },
          services,
        ),
      ),
    merge: async (invocation: Invocation, id: string, body: Record<string, unknown>) =>
      contactMerge.parse(
        await find('mergeContacts').run({ invocation, params: { id }, query: {}, body }, services),
      ),
  };
}

/** Merges with the revisions the preview gives, as the merge dialog does. */
async function merge(
  where: Space,
  id: string,
  mergeIds: string[],
  body: Record<string, unknown> = {},
  participants: readonly ContactMergeParticipant[] = [],
) {
  const route = routes(participants);
  const preview = await route.preview(where.owner, id, mergeIds);
  const revisions = Object.fromEntries(preview.contacts.map((each) => [each.id, each.revision]));
  return route.merge(where.owner, id, { mergeIds, revisions, ...body });
}

const rejected = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('the contact kept', () => {
  it("keeps its own values, takes the others' where it has none, and the ones picked", async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Maya', emails: ['maya@example.com'] });
    const other = await person(where, {
      firstName: 'Maya',
      lastName: 'Thompson',
      emails: ['maya.t@example.com'],
      phones: ['+254712345678'],
    });
    const third = await person(where, { firstName: 'May', lastName: 'Tee' });
    await sql(
      where,
      `update crm.contacts set source = 'Expo', timezone = 'Africa/Nairobi' where id = $1`,
      [third.uuid],
    );
    await sql(where, `update crm.contacts set source = 'Website' where id = $1`, [kept.uuid]);

    const result = await merge(where, kept.id, [other.id, third.id], {
      fields: { firstName: third.id },
      primaryEmail: 'maya.t@example.com',
    });

    expect(result.contact).toMatchObject({
      id: kept.id,
      firstName: 'May',
      // Empty on the contact kept: the first of the others, in the order named.
      lastName: 'Thompson',
      emails: ['maya.t@example.com', 'maya@example.com'],
      phones: [{ number: '+254712345678' }],
      timeZone: 'Africa/Nairobi',
      trashedAt: null,
    });
    const [row] = await sql<{ source: string }>(
      where,
      'select source from crm.contacts where id = $1',
      [kept.uuid],
    );
    expect(row?.source).toBe('Website');
    expect(result.mergedIds).toEqual([other.id, third.id]);
    expect(result.moved['crm']).toMatchObject({ identities: 2 });
  });

  it('keeps the oldest creation, the latest activity and every opt-out', async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept', dnd: { channels: ['sms'] } });
    const other = await person(where, {
      firstName: 'Other',
      dnd: { all: true, channels: ['email'] },
    });
    await owner(
      `update crm.contacts set created_at = '2020-01-01', created_source = 'import',
         created_by_kind = 'import', last_activity_at = '2026-01-01', dnd_inbound = true
       where id = $1`,
      [other.uuid],
    );

    await merge(where, kept.id, [other.id]);

    const [row] = await sql<{
      created_at: Date;
      created_source: string;
      last_activity_at: Date;
      do_not_contact: boolean;
      dnd_channels: string[];
      dnd_inbound: boolean;
    }>(
      where,
      `select created_at, created_source, last_activity_at, do_not_contact, dnd_channels, dnd_inbound
       from crm.contacts where id = $1`,
      [kept.uuid],
    );
    expect(row).toEqual({
      created_at: new Date('2020-01-01T00:00:00Z'),
      created_source: 'import',
      last_activity_at: new Date('2026-01-01T00:00:00Z'),
      do_not_contact: true,
      dnd_channels: ['email', 'sms'],
      dnd_inbound: true,
    });
    const events = await sql<{ type: string; payload: unknown }>(
      where,
      `select type, payload from events.events where subject_id = $1 and type like 'contact.%'
       and type not in ('contact.created') order by recorded_at, id`,
      [kept.uuid],
    );
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'contact.do_not_contact_set',
        'contact.inbound_dnd_set',
        'contact.dnd_changed',
        'contact.merged',
      ]),
    );
    expect(events.findLast((event) => event.type === 'contact.dnd_changed')?.payload).toEqual({
      channels: ['email', 'sms'],
      enabled: ['email'],
      disabled: [],
      doNotContact: 'set',
    });
  });

  it('takes custom field values: its own, else the first of the others, else the one picked', async () => {
    const where = await space();
    const field = async (key: string, valueType = 'text') => {
      const [row] = await sql<{ id: string }>(
        where,
        `insert into crm.field_definitions (business_id, object_type_id, key, label, value_type, created_by_kind)
         select app.business_id(), id, $1, $1, $2, 'system' from crm.object_types where kind = 'contact'
         returning id`,
        [key, valueType],
      );
      return row?.id ?? '';
    };
    const colour = await field('colour');
    const size = await field('size');
    const pet = await field('pet');
    const kept = await person(where, { firstName: 'Kept' });
    const other = await person(where, { firstName: 'Other' });
    const value = (record: string, fieldId: string, text: string) =>
      sql(
        where,
        `insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
         values (app.business_id(), $1, $2, 'text', $3, 'user')`,
        [record, fieldId, text],
      );
    await value(kept.uuid, colour, 'blue');
    await value(other.uuid, colour, 'red');
    await value(other.uuid, size, 'large');
    await value(kept.uuid, pet, 'cat');

    // Picking a contact without a value empties the field.
    await merge(where, kept.id, [other.id], { customFields: { pet: other.id } });

    const rows = await sql<{ field_id: string; value_text: string }>(
      where,
      'select field_id, value_text from crm.field_values where record_id = $1 order by value_text',
      [kept.uuid],
    );
    expect(rows).toEqual([
      { field_id: colour, value_text: 'blue' },
      { field_id: size, value_text: 'large' },
    ]);

    expect(
      await rejected(
        merge(where, kept.id, [(await person(where, { firstName: 'X' })).id], {
          customFields: { no_such_field: kept.id },
        }),
      ),
    ).toMatchObject({ issues: [{ path: '/customFields/no_such_field', code: 'unknown_field' }] });
  });

  it('takes the merged contact’s value of a unique field, which then belongs to the contact kept alone', async () => {
    const where = await space();
    const [definition] = await sql<{ id: string }>(
      where,
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, value_type, is_unique, created_by_kind)
       select app.business_id(), id, 'member_number', 'Member number', 'text', true, 'system'
       from crm.object_types where kind = 'contact' returning id`,
    );
    const field = definition?.id ?? '';
    const kept = await person(where, { firstName: 'Kept' });
    const other = await person(where, { firstName: 'Other' });
    for (const [record, text] of [
      [kept.uuid, 'M-100'],
      [other.uuid, 'M-200'],
    ] as const)
      await sql(
        where,
        `insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
         values (app.business_id(), $1, $2, 'text', $3, 'user')`,
        [record, field, text],
      );

    await merge(where, kept.id, [other.id], { customFields: { member_number: other.id } });

    expect(
      await sql(
        where,
        'select value_text from crm.field_values where record_id = $1 and field_id = $2',
        [kept.uuid, field],
      ),
    ).toEqual([{ value_text: 'M-200' }]);
    expect(
      await sql(where, 'select record_id from crm.field_unique_values where field_id = $1', [
        field,
      ]),
    ).toEqual([{ record_id: kept.uuid }]);
  });

  it('takes the files of a file field only from the contact whose value it keeps', async () => {
    const where = await space();
    const [definition] = await sql<{ id: string }>(
      where,
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, value_type, file_formats, file_limit, created_by_kind)
       select app.business_id(), id, 'contract', 'Contract', 'file', '{pdf}', 2, 'system'
       from crm.object_types where kind = 'contact' returning id`,
    );
    const field = definition?.id ?? '';
    const kept = await person(where, { firstName: 'Kept' });
    const other = await person(where, { firstName: 'Other' });
    const file = async (record: string, name: string) => {
      const [made] = await owner<{ id: string }>(
        `insert into files.files (agency_id, business_id, storage, storage_key, filename,
           content_type, size_bytes, sha256, uploaded_by_kind)
         select agency_id, id, 'local', $2::text, $2::text, 'application/pdf', 1, sha256(convert_to($2::text, 'UTF8')), 'user'
         from tenancy.businesses where id = $1 returning id`,
        [where.businessId, `${name}-${randomUUID()}.pdf`],
      );
      const id = made?.id ?? '';
      await sql(
        where,
        `insert into crm.record_files (business_id, file_id, record_id, field_id, created_by_kind)
         values (app.business_id(), $1, $2, $3, 'user')`,
        [id, record, field],
      );
      await sql(
        where,
        `insert into crm.field_values (business_id, record_id, field_id, value_type, value_options, source_kind)
         values (app.business_id(), $1, $2, 'file', array[$3::text], 'user')`,
        [record, field, id],
      );
      return id;
    };
    const keptFile = await file(kept.uuid, 'kept');
    const otherFile = await file(other.uuid, 'other');

    await merge(where, kept.id, [other.id], { customFields: { contract: other.id } });

    const files = await sql<{ file_id: string; field_id: string | null }>(
      where,
      'select file_id, field_id from crm.record_files where record_id = $1 order by file_id',
      [kept.uuid],
    );
    expect(new Map(files.map((row) => [row.file_id, row.field_id]))).toEqual(
      new Map([
        [keptFile, null],
        [otherFile, field],
      ]),
    );
  });
});

describe('the owner', () => {
  it('is the one picked, and the change is told as an assignment is', async () => {
    const where = await space();
    const user = await database.fixtures.user();
    const kept = await person(where, { firstName: 'Kept' });
    const owned = await person(where, { firstName: 'Owned' });
    await owner('update crm.contacts set owner_user_id = $2 where id = $1', [owned.uuid, user.id]);
    await merge(where, kept.id, [owned.id], { fields: { owner: owned.id } });
    // Picking a contact with no owner leaves the contact kept with none.
    const unowned = await person(where, { firstName: 'Unowned' });
    await merge(where, kept.id, [unowned.id], { fields: { owner: unowned.id } });

    const events = await sql<{ type: string; payload: unknown }>(
      where,
      `select type, payload from events.events where subject_id = $1 and type like 'contact.owner_%'
       order by recorded_at, id`,
      [kept.uuid],
    );
    expect(events).toEqual([
      { type: 'contact.owner_assigned', payload: { assignedUserId: user.id } },
      { type: 'contact.owner_unassigned', payload: {} },
    ]);
  });
});

describe('what moves to the contact kept', () => {
  it('combines tags, links, notes, tasks, followers, the timeline, touches and the score', async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept' });
    const other = await person(where, { firstName: 'Other' });
    const third = await person(where, { firstName: 'Third' });
    const user = await database.fixtures.user();

    // Tags: one both have, one each.
    await sql(
      where,
      `with made as (
         insert into crm.tags (business_id, name, created_by_kind)
         select app.business_id(), name, 'user' from unnest(array['both', 'kept', 'other']) name
         returning id, name)
       insert into crm.record_tags (business_id, record_id, tag_id, source_kind)
       select app.business_id(), c, made.id, 'user'
       from made, unnest($1::uuid[]) c
       where made.name = 'both' or (made.name = 'kept' and c = $2) or (made.name = 'other' and c = $3)`,
      [[kept.uuid, other.uuid], kept.uuid, other.uuid],
    );

    // Links: a company each is linked to as its primary, one they share, a firm whose
    // contacts are both (the other its primary contact), and a link between the two.
    const [types] = await sql<{ company: string; contact: string }>(
      where,
      `select (select id from crm.object_types where kind = 'company') as company,
              (select id from crm.object_types where kind = 'contact') as contact`,
    );
    if (types === undefined) throw new Error('No object types.');
    const linkType = async (key: string, from: string, to: string) => {
      const [row] = await sql<{ id: string }>(
        where,
        `insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id,
           label, reverse_label, allows_primary)
         values (app.business_id(), $1, $2, $3, $1, $1, true) returning id`,
        [key, from, to],
      );
      return row?.id ?? '';
    };
    const contactCompany = await linkType('contact_company', types.contact, types.company);
    const companyContact = await linkType('company_contact', types.company, types.contact);
    const contactContact = await linkType('contact_contact', types.contact, types.contact);
    const referredBy = await linkType('referred_by', types.contact, types.contact);
    const record = async () => {
      const [row] = await owner<{ id: string }>(
        `with made as (
           insert into crm.records (business_id, kind, object_type_id)
           values ($1, 'company', $2) returning id)
         insert into crm.companies (business_id, id, name, created_by_kind)
         select $1, id, 'Company', 'user' from made returning id`,
        [where.businessId, types.company],
      );
      return row?.id ?? '';
    };
    const [acme, globex, shared, deal] = [
      await record(),
      await record(),
      await record(),
      await record(),
    ];
    const link = (type: string, from: string, to: string, primary: boolean) =>
      owner(
        `insert into crm.record_links (business_id, link_type_id, from_record_id, to_record_id,
           is_primary, source_kind)
         values ($1, $2, $3, $4, $5, 'user')`,
        [where.businessId, type, from, to, primary],
      );
    await link(contactCompany, kept.uuid, acme, true);
    await link(contactCompany, other.uuid, globex, true);
    await link(contactCompany, kept.uuid, shared, false);
    await link(contactCompany, other.uuid, shared, false);
    await link(companyContact, deal, kept.uuid, false);
    await link(companyContact, deal, other.uuid, true);
    // Between contacts: one each way joining the two (dropped: the contact kept would link
    // to itself), two the contact kept has the other way round (dropped), and one from a
    // fourth contact (moved).
    const fourth = await person(where, { firstName: 'Fourth' });
    await link(contactContact, kept.uuid, other.uuid, false);
    await link(referredBy, other.uuid, kept.uuid, false);
    await link(contactContact, third.uuid, kept.uuid, false);
    await link(contactContact, other.uuid, third.uuid, false);
    await link(referredBy, kept.uuid, third.uuid, false);
    await link(referredBy, third.uuid, other.uuid, false);
    await link(referredBy, fourth.uuid, other.uuid, false);

    // Notes, a task, a follower each (one the same person), touches, scores.
    await owner(
      `insert into crm.notes (business_id, record_id, body, body_text, author_kind)
       values ($1, $2, '{}'::jsonb, 'A note', 'user')`,
      [where.businessId, other.uuid],
    );
    await owner(
      `insert into crm.tasks (business_id, record_id, title, created_by_kind)
       values ($1, $2, 'Call back', 'user')`,
      [where.businessId, other.uuid],
    );
    await owner(
      `insert into crm.contact_followers (business_id, contact_id, user_id, added_by_kind)
       select $1, c, $3, 'user' from unnest($2::uuid[]) c`,
      [where.businessId, [kept.uuid, other.uuid], user.id],
    );
    // The other's first touch is the older one; its latest the newer one.
    await owner(
      `update crm.contact_attributions set touched_at = '2020-01-01' where contact_id = $1`,
      [other.uuid],
    );
    await owner(
      `update crm.contact_attributions set is_latest = false
       where contact_id = $1 and touched_at = '2020-01-01'`,
      [other.uuid],
    );
    await owner(
      `insert into crm.contact_attributions (business_id, contact_id, touched_at, medium,
         session_source, subject_kind, subject_id, is_latest)
       select $1, $2, '2030-01-01', 'manual', 'crm_ui', 'contact', $2, true`,
      [where.businessId, other.uuid],
    );
    await owner(
      `insert into crm.contact_scores (business_id, contact_id, score)
       select $1, c, s from unnest($2::uuid[], $3::int[]) as v(c, s)`,
      [where.businessId, [kept.uuid, other.uuid], [5, 7]],
    );
    await owner(
      `insert into crm.score_changes (business_id, contact_id, source, change, actor_kind)
       values ($1, $2, 'person', 7, 'user')`,
      [where.businessId, other.uuid],
    );

    const result = await merge(where, kept.id, [other.id]);

    const of = async (text: string) =>
      sql<Record<string, unknown>>(where, text, [kept.uuid]).then((rows) => rows);
    expect(
      (
        await of(
          `select t.name from crm.record_tags r join crm.tags t on t.id = r.tag_id
         where r.record_id = $1 order by t.name`,
        )
      ).map((row) => row['name']),
    ).toEqual(['both', 'kept', 'other']);
    expect(
      await of(
        `select to_record_id as "to", is_primary as "primary" from crm.record_links
         where from_record_id = $1 order by to_record_id`,
      ),
    ).toEqual(
      [
        { to: acme, primary: true },
        { to: globex, primary: false },
        { to: shared, primary: false },
        { to: third.uuid, primary: false },
      ].sort((a, b) => (a.to < b.to ? -1 : 1)),
    );
    expect(
      await of(
        `select from_record_id as "from", is_primary as "primary" from crm.record_links
         where to_record_id = $1 order by from_record_id`,
      ),
    ).toEqual(
      [
        { from: deal, primary: true },
        { from: third.uuid, primary: false },
        { from: fourth.uuid, primary: false },
      ].sort((a, b) => (a.from < b.from ? -1 : 1)),
    );
    const [counts] = await of(
      `select
         (select count(*)::int from crm.notes where record_id = $1) as notes,
         (select count(*)::int from crm.tasks where record_id = $1) as tasks,
         (select count(*)::int from crm.contact_followers where contact_id = $1) as followers,
         (select count(*)::int from crm.record_links
          where from_record_id = $1 and to_record_id = $1) as "selfLinks",
         (select score from crm.contact_scores where contact_id = $1) as score,
         (select count(*)::int from crm.score_changes where contact_id = $1) as "scoreChanges"`,
    );
    expect(counts).toEqual({
      notes: 1,
      tasks: 1,
      followers: 1,
      selfLinks: 0,
      score: 12,
      scoreChanges: 1,
    });
    const touches = await of(
      `select touched_at, is_first, is_latest from crm.contact_attributions
       where contact_id = $1 order by touched_at`,
    );
    expect(touches.map((touch) => [touch['is_first'], touch['is_latest']])).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ]);
    expect(touches[0]?.['touched_at']).toEqual(new Date('2020-01-01T00:00:00Z'));

    // The other's timeline is copied: its contact.created shows on the contact kept.
    const timeline = await sql<{ event_type: string; count: number }>(
      where,
      `select event_type, count(*)::int from crm.timeline_entries where record_id = $1
       group by event_type order by event_type`,
      [kept.uuid],
    );
    expect(timeline).toEqual(
      expect.arrayContaining([
        { event_type: 'contact.created', count: 2 },
        { event_type: 'contact.merged', count: 1 },
      ]),
    );
    // Nothing is left on the contact merged away but what it keeps as history.
    const [left] = await sql<Record<string, number>>(
      where,
      `select
         (select count(*)::int from crm.contact_identities where contact_id = $1) as identities,
         (select count(*)::int from crm.record_tags where record_id = $1) as tags,
         (select count(*)::int from crm.record_links
          where from_record_id = $1 or to_record_id = $1) as links,
         (select count(*)::int from crm.contact_followers where contact_id = $1) as followers,
         (select count(*)::int from crm.contact_attributions where contact_id = $1) as touches`,
      [other.uuid],
    );
    expect(left).toEqual({ identities: 0, tags: 0, links: 0, followers: 0, touches: 0 });
    expect(result.moved['crm']).toMatchObject({ notes: 1, tasks: 1, tags: 1, followers: 0 });
  });

  it("keeps a link to a record primary where only the merged contact's link to it was", async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept' });
    const other = await person(where, { firstName: 'Other' });
    const [types] = await sql<{ company: string; contact: string }>(
      where,
      `select (select id from crm.object_types where kind = 'company') as company,
              (select id from crm.object_types where kind = 'contact') as contact`,
    );
    if (types === undefined) throw new Error('No object types.');
    const [made] = await owner<{ type: string; acme: string }>(
      `with type as (
         insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id,
           label, reverse_label, allows_primary)
         values ($1, 'contact_company', $2, $3, 'Company', 'Contacts', true) returning id),
       record as (
         insert into crm.records (business_id, kind, object_type_id)
         values ($1, 'company', $3) returning id),
       company as (
         insert into crm.companies (business_id, id, name, created_by_kind)
         select $1, id, 'Acme', 'user' from record returning id)
       select (select id from type) as type, (select id from company) as acme`,
      [where.businessId, types.contact, types.company],
    );
    if (made === undefined) throw new Error('No link type.');
    // Both work at Acme; only the other has it as its primary company.
    await owner(
      `insert into crm.record_links (business_id, link_type_id, from_record_id, to_record_id,
         is_primary, source_kind)
       select $1, $2, c, $3, c = $5, 'user' from unnest($4::uuid[]) c`,
      [where.businessId, made.type, made.acme, [kept.uuid, other.uuid], other.uuid],
    );

    await merge(where, kept.id, [other.id]);

    expect(
      await sql(
        where,
        `select to_record_id as "to", is_primary as "primary" from crm.record_links
         where from_record_id = $1`,
        [kept.uuid],
      ),
    ).toEqual([{ to: made.acme, primary: true }]);
  });

  it('makes the picked phone number primary, and drops a label the contact kept uses', async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept', phones: ['+254700000001'] });
    const other = await person(where, { firstName: 'Other', phones: ['+254700000002'] });
    await sql(where, `update crm.contact_identities set label = 'mobile' where kind = 'phone'`);

    const result = await merge(where, kept.id, [other.id], { primaryPhone: '+254700000002' });

    expect(result.contact.phones.map((phone) => phone.number)).toEqual([
      '+254700000002',
      '+254700000001',
    ]);
    const labels = await sql<{ value_normalized: string; label: string | null }>(
      where,
      `select value_normalized, label from crm.contact_identities where contact_id = $1
       order by value_normalized`,
      [kept.uuid],
    );
    expect(labels).toEqual([
      { value_normalized: '+254700000001', label: 'mobile' },
      { value_normalized: '+254700000002', label: null },
    ]);
  });
});

describe('the contacts merged away', () => {
  it('go to the trash marked merged, answer 404 with where they went, and cannot be restored', async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept' });
    const other = await person(where, { firstName: 'Other' });

    await merge(where, kept.id, [other.id]);

    const [row] = await sql<{ merged_into_id: string; deleted_at: Date | null }>(
      where,
      'select merged_into_id, deleted_at from crm.contacts where id = $1',
      [other.uuid],
    );
    expect(row?.merged_into_id).toBe(kept.uuid);
    expect(row?.deleted_at).not.toBeNull();

    const read = await rejected(
      withTenant(services.db, where.context, (trx) => readContact(trx, where.owner, other.id)),
    );
    expect(read).toBeInstanceOf(NotFoundError);
    expect(read).toMatchObject({ mergedInto: kept.id });
    const details = await rejected(
      withTenant(services.db, where.context, (trx) =>
        readContactDetails(trx, where.owner, other.id, detailOptions()),
      ),
    );
    expect(details).toMatchObject({ mergedInto: kept.id });

    const restore = await rejected(
      runCommand(services, restoreContactCommand, { id: other.id }, where.owner),
    );
    expect(restore).toBeInstanceOf(ConflictError);

    const events = await sql<{ type: string; payload: Record<string, unknown> }>(
      where,
      `select type, payload from events.events where subject_id = $1 and type = 'contact.trashed'`,
      [other.uuid],
    );
    // Events name contacts by their public ids, as the timeline gives them out.
    expect(events).toEqual([{ type: 'contact.trashed', payload: { mergedInto: kept.id } }]);
    const [merged] = await sql<{ payload: Record<string, unknown> }>(
      where,
      `select payload from events.events where subject_id = $1 and type = 'contact.merged'`,
      [kept.uuid],
    );
    expect(merged?.payload).toMatchObject({ mergedIds: [other.id] });
  });
});

describe('a merge is refused', () => {
  it('for a contact of another business, as not found', async () => {
    const where = await space();
    const elsewhere = await space();
    const kept = await person(where, { firstName: 'Kept' });
    const foreign = await person(elsewhere, { firstName: 'Foreign' });
    expect(await rejected(merge(where, kept.id, [foreign.id]))).toBeInstanceOf(NotFoundError);
    expect(
      await rejected(
        routes().merge(where.owner, kept.id, {
          mergeIds: [foreign.id],
          revisions: { [kept.id]: 'a'.repeat(64), [foreign.id]: 'a'.repeat(64) },
        }),
      ),
    ).toBeInstanceOf(NotFoundError);
  });

  it('for a contact already merged, or in the trash', async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept' });
    const other = await person(where, { firstName: 'Other' });
    const third = await person(where, { firstName: 'Third' });
    const preview = await routes().preview(where.owner, third.id, [other.id]);
    await merge(where, kept.id, [other.id]);
    const revisions = Object.fromEntries(preview.contacts.map((each) => [each.id, each.revision]));
    expect(
      await rejected(routes().merge(where.owner, third.id, { mergeIds: [other.id], revisions })),
    ).toMatchObject({ mergedInto: kept.id });

    await sql(where, 'update crm.contacts set deleted_at = now() where id = $1', [third.uuid]);
    expect(await rejected(merge(where, kept.id, [third.id]))).toBeInstanceOf(ConflictError);
  });

  it('when a contact changed after the merge was opened', async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept' });
    const other = await person(where, { firstName: 'Other', emails: ['other@example.com'] });
    const preview = await routes().preview(where.owner, kept.id, [other.id]);
    const revisions = Object.fromEntries(preview.contacts.map((each) => [each.id, each.revision]));
    await sql(where, `update crm.contact_identities set is_primary = false where contact_id = $1`, [
      other.uuid,
    ]);
    expect(
      await rejected(routes().merge(where.owner, kept.id, { mergeIds: [other.id], revisions })),
    ).toBeInstanceOf(ConflictError);
  });

  it('when the contacts have more rows than a merge moves, before anything changes', async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept' });
    const other = await person(where, { firstName: 'Other' });
    const huge: ContactMergeParticipant = {
      name: 'huge',
      count: () => Promise.resolve({ messages: MAX_CONTACT_MERGE_ROWS }),
      merge: () => Promise.resolve({}),
    };
    const preview = await routes([huge]).preview(where.owner, kept.id, [other.id]);
    expect(preview.rows).toBeGreaterThan(MAX_CONTACT_MERGE_ROWS);
    expect(preview.maxRows).toBe(MAX_CONTACT_MERGE_ROWS);
    expect(preview.moved['huge']).toEqual({ messages: MAX_CONTACT_MERGE_ROWS });
    const error = await rejected(merge(where, kept.id, [other.id], {}, [huge]));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ issues: [{ path: '/mergeIds', code: 'merge_too_large' }] });
  });

  it('for too many addresses, or a primary none of them has', async () => {
    const where = await space();
    const emails = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, n) => `${prefix}${String(n)}@example.com`);
    const kept = await person(where, { firstName: 'Kept', emails: emails('a', 6) });
    const other = await person(where, { firstName: 'Other', emails: emails('b', 5) });
    expect(await rejected(merge(where, kept.id, [other.id]))).toMatchObject({
      issues: [{ path: '/mergeIds', code: 'too_many_addresses' }],
    });
    const third = await person(where, { firstName: 'Third' });
    expect(
      await rejected(merge(where, kept.id, [third.id], { primaryEmail: 'nobody@example.com' })),
    ).toMatchObject({ issues: [{ path: '/primaryEmail', code: 'not_merged' }] });
  });

  it('when the contact kept is also named to merge away, in the preview too', async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept' });
    expect(await rejected(routes().preview(where.owner, kept.id, [kept.id]))).toMatchObject({
      issues: [{ path: '/mergeIds', code: 'merges_itself' }],
    });
  });

  it('for someone without contacts.merge, the preview too', async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept' });
    const other = await person(where, { firstName: 'Other' });
    const member: Invocation = {
      context: where.owner.context,
      permissions: new Set(['contacts.manage']),
    };
    expect(await rejected(routes().preview(member, kept.id, [other.id]))).toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('and rolls everything back when a module fails', async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept', emails: ['kept@example.com'] });
    const other = await person(where, { firstName: 'Other', emails: ['other@example.com'] });
    await sql(
      where,
      `insert into crm.notes (business_id, record_id, body, body_text, author_kind)
       values (app.business_id(), $1, '{}'::jsonb, 'A note', 'user')`,
      [other.uuid],
    );
    const failing: ContactMergeParticipant = {
      name: 'failing',
      merge: () => Promise.reject(new Error('The module failed.')),
    };
    await expect(merge(where, kept.id, [other.id], {}, [failing])).rejects.toThrow(
      'The module failed.',
    );
    const [state] = await sql<Record<string, unknown>>(
      where,
      `select
         (select merged_into_id from crm.contacts where id = $2) as merged,
         (select deleted_at from crm.contacts where id = $2) as trashed,
         (select count(*)::int from crm.contact_identities where contact_id = $2) as identities,
         (select count(*)::int from crm.notes where record_id = $2) as notes,
         (select count(*)::int from crm.contact_identities where contact_id = $1) as kept`,
      [kept.uuid, other.uuid],
    );
    expect(state).toEqual({ merged: null, trashed: null, identities: 1, notes: 1, kept: 1 });
  });
});

describe('participants', () => {
  it('lock every contact in order before anything, then move each contact merged away', async () => {
    const where = await space();
    const kept = await person(where, { firstName: 'Kept' });
    const other = await person(where, { firstName: 'Other' });
    const third = await person(where, { firstName: 'Third' });
    const calls: string[] = [];
    const recording: ContactMergeParticipant = {
      name: 'recording',
      lock: (_trx, _command: CommandContext, ids) => {
        calls.push(`lock ${ids.join(' ')}`);
        return Promise.resolve();
      },
      count: (_trx, _invocation, ids) => {
        calls.push(`count ${ids.join(' ')}`);
        return Promise.resolve({ rows: ids.length });
      },
      merge: async (trx, command, move) => {
        // Both live when it runs: the contact merged away goes to the trash after.
        const { rows } = await query<{ deleted: boolean }>`
          select deleted_at is not null as deleted from crm.contacts where id = ${move.from}
        `.execute(trx);
        calls.push(`merge ${move.from} ${move.into} ${String(rows[0]?.deleted)}`);
        await command.emit({
          type: 'contact.merge_test',
          subject: { kind: 'contact', id: move.into },
          records: [move.into],
        });
        return { rows: 1 };
      },
    };
    calls.length = 0;
    const result = await merge(where, kept.id, [third.id, other.id], {}, [recording]);
    const sorted = [kept.uuid, other.uuid, third.uuid].sort();
    expect(calls.slice(1)).toEqual([
      `lock ${sorted.join(' ')}`,
      `count ${third.uuid} ${other.uuid}`,
      `merge ${third.uuid} ${kept.uuid} false`,
      `merge ${other.uuid} ${kept.uuid} false`,
    ]);
    expect(result.moved['recording']).toEqual({ rows: 2 });
  });
});
