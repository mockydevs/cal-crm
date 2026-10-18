// The trash, restore and purge, against a migrated Postgres as crm_app under row-level
// security. Acceptance: restore brings everything back; purge removes the record and
// everything attached to it.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { trashList, type TrashList } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { contactRoutes } from '../contacts/routes.js';
import { trashRoutes } from './routes.js';
import { purgeExpiredCommand, purgeExpiredTrash, readTrash } from './trash.js';

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

async function inBusiness(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return {
    context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
    permissions: 'all',
  };
}

const routes = [...contactRoutes, ...trashRoutes];
async function call(
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId}`);
  return route.run(
    {
      invocation,
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    },
    services,
  );
}

const trash = async (invocation: Invocation, query: Record<string, string> = {}) =>
  trashList.parse(await call('listTrash', invocation, { query }));

async function newContact(invocation: Invocation, firstName: string): Promise<string> {
  const created = (await call('createContact', invocation, {
    body: { firstName, emails: [`${firstName.toLowerCase()}@example.com`] },
  })) as { id: string };
  return created.id;
}

const businessOf = (invocation: Invocation) => invocation.context.businessId ?? '';

/** A company and a deal, written as the owner, as their own modules would write them. */
async function companyAndDeal(invocation: Invocation): Promise<{ company: string; deal: string }> {
  return database.as('crm_owner', async (sql) => {
    const business = businessOf(invocation);
    const company = await sql.one<{ id: string }>(
      `with record as (
         insert into crm.records (business_id, kind, object_type_id)
         select $1, 'company', id from crm.object_types where business_id = $1 and kind = 'company'
         returning id)
       insert into crm.companies (business_id, id, name, created_by_kind)
       select $1, id, 'Lee Family', 'user' from record returning id`,
      [business],
    );
    const pipeline = await sql.one<{ id: string }>(
      `insert into crm.pipelines (business_id, name) values ($1, 'Sales') returning id`,
      [business],
    );
    const stage = await sql.one<{ id: string }>(
      `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
       values ($1, $2, 'New', 0) returning id`,
      [business, pipeline.id],
    );
    const deal = await sql.one<{ id: string }>(
      `with record as (
         insert into crm.records (business_id, kind, object_type_id)
         select $1, 'deal', id from crm.object_types where business_id = $1 and kind = 'deal'
         returning id)
       insert into crm.deals (business_id, id, name, pipeline_id, stage_id, currency, created_by_kind)
       select $1, id, 'Lee wedding', $2, $3, 'USD', 'user' from record returning id`,
      [business, pipeline.id, stage.id],
    );
    return { company: toPublicId('company', company.id), deal: toPublicId('deal', deal.id) };
  });
}

/** A tag, a field value, a link to the company, a note and a task on the contact. */
async function attachEverything(invocation: Invocation, contact: string, company: string) {
  await database.as('crm_owner', async (sql) => {
    const business = businessOf(invocation);
    const record = parsePublicId('contact', contact);
    const companyRecord = parsePublicId('company', company);
    const tag = await sql.one<{ id: string }>(
      `insert into crm.tags (business_id, name, created_by_kind) values ($1, 'VIP', 'user') returning id`,
      [business],
    );
    await sql.query(
      `insert into crm.record_tags (business_id, record_id, tag_id, source_kind) values ($1, $2, $3, 'user')`,
      [business, record, tag.id],
    );
    const field = await sql.one<{ id: string }>(
      `insert into crm.field_definitions (business_id, object_type_id, key, label, value_type, created_by_kind)
       select $1, id, 'event_month', 'Event month', 'text', 'user'
       from crm.object_types where business_id = $1 and kind = 'contact' returning id`,
      [business],
    );
    await sql.query(
      `insert into crm.field_values (business_id, record_id, field_id, value_type, value_text, source_kind)
       values ($1, $2, $3, 'text', 'June', 'user')`,
      [business, record, field.id],
    );
    const linkType = await sql.one<{ id: string }>(
      `insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id, label, reverse_label)
       select $1, 'contact_company_test', c.id, o.id, 'Works at', 'People'
       from crm.object_types c, crm.object_types o
       where c.business_id = $1 and c.kind = 'contact' and o.business_id = $1 and o.kind = 'company'
       returning id`,
      [business],
    );
    await sql.query(
      `insert into crm.record_links (business_id, link_type_id, from_record_id, to_record_id, source_kind)
       values ($1, $2, $3, $4, 'user')`,
      [business, linkType.id, record, companyRecord],
    );
    await sql.query(
      `insert into crm.notes (business_id, record_id, body, body_text, author_kind)
       values ($1, $2, '{}'::jsonb, 'Prefers text', 'user')`,
      [business, record],
    );
    await sql.query(
      `insert into crm.tasks (business_id, record_id, title, created_by_kind)
       values ($1, $2, 'Call back', 'user')`,
      [business, record],
    );
  });
}

/**
 * How many rows of each table that references crm.records point at the record, read from
 * the catalog, so a table added later is counted too. Contact identities hang off the
 * contact, so they're counted as well.
 */
async function attached(contact: string): Promise<Record<string, number>> {
  const id = parsePublicId('contact', contact) ?? '';
  return database.as('crm_owner', async (sql) => {
    const references = await sql.query<{ tbl: string; col: string }>(
      `select distinct c.conrelid::regclass::text as tbl, a.attname as col
       from pg_constraint c
       cross join lateral unnest(c.conkey, c.confkey) as k (child, parent)
       join pg_attribute p on p.attrelid = c.confrelid and p.attnum = k.parent and p.attname = 'id'
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.child
       join pg_class t on t.oid = c.conrelid and not t.relispartition
       where c.contype = 'f' and c.confrelid = 'crm.records'::regclass`,
    );
    const counts: Record<string, number> = {};
    for (const { tbl, col } of [
      ...references,
      { tbl: 'crm.records', col: 'id' },
      { tbl: 'crm.contact_identities', col: 'contact_id' },
    ]) {
      const { count } = await sql.one<{ count: string }>(
        `select count(*) from ${tbl} where ${col} = $1`,
        [id],
      );
      counts[`${tbl}.${col}`] = Number(count);
    }
    return counts;
  });
}

/** Whether a query in this test's database is waiting for a lock another transaction holds. */
async function somethingWaits(): Promise<boolean> {
  const [row] = await database.as('postgres', (sql) =>
    sql.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`,
    ),
  );
  return (row?.waiting ?? 0) > 0;
}

/**
 * Runs work while another transaction holds what `hold` locks, as a restore or a write does
 * before it commits. Work that `waits` gets until it's waiting for the lock; that
 * transaction then runs `then` and commits. Other work must finish while the lock is held.
 */
async function whileHeld<T>(
  statements: { hold: string; then?: string },
  params: unknown[],
  work: () => Promise<T>,
  waits = true,
): Promise<PromiseSettledResult<T>> {
  let commit: () => void = () => undefined;
  const committing = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let holding: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    holding = resolve;
  });
  const transaction = database.as('crm_owner', async (sql) => {
    await sql.query(statements.hold, params);
    holding();
    await committing;
    if (statements.then !== undefined) await sql.query(statements.then, params);
  });
  await held;
  const working = Promise.allSettled([work()]);
  try {
    if (waits) {
      for (let tries = 0; !(await somethingWaits()); tries += 1) {
        if (tries > 400) throw new Error('Nothing waited for the held row.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } else {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => {
          resolve('late');
        }, 5000);
      });
      const finished = await Promise.race([working, late]);
      clearTimeout(timer);
      if (finished === 'late') throw new Error('The work waited for the held row.');
    }
  } finally {
    commit();
    await transaction;
  }
  const [result] = await working;
  return result;
}

// A restore: it locks the contact's row, then adds its timeline entry, whose foreign key
// takes FOR KEY SHARE on the registry row.
const restoring = {
  hold: 'update crm.contacts set deleted_at = null where id = $1',
  then: 'select 1 from crm.records where id = $1 for key share',
};

const nonzero = (counts: Record<string, number>) =>
  Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));

describe('restoring from the trash', () => {
  it('brings the record back with everything attached to it', async () => {
    const invocation = await inBusiness();
    const contact = await newContact(invocation, 'Maya');
    const { company } = await companyAndDeal(invocation);
    await attachEverything(invocation, contact, company);
    const before = await attached(contact);
    expect(Object.keys(nonzero(before)).sort()).toEqual(
      [
        'crm.contact_identities.contact_id',
        'crm.contacts.id',
        'crm.field_values.record_id',
        'crm.notes.record_id',
        'crm.record_links.from_record_id',
        'crm.record_tags.record_id',
        'crm.records.id',
        'crm.tasks.record_id',
        'crm.timeline_entries.record_id',
      ].sort(),
    );

    await call('trashContact', invocation, { params: { id: contact } });
    expect((await trash(invocation)).items.map((item) => item.id)).toEqual([contact]);
    await call('restoreContact', invocation, { params: { id: contact } });

    expect((await trash(invocation)).items).toEqual([]);
    const after = await attached(contact);
    // Two more timeline entries: trashed and restored. Nothing else changed.
    expect(after).toEqual({
      ...before,
      'crm.timeline_entries.record_id': (before['crm.timeline_entries.record_id'] ?? 0) + 2,
    });
  });
});

describe('purging', () => {
  it('removes the record and everything attached to it', async () => {
    const invocation = await inBusiness();
    const contact = await newContact(invocation, 'Maya');
    const { company } = await companyAndDeal(invocation);
    await attachEverything(invocation, contact, company);
    await call('trashContact', invocation, { params: { id: contact } });

    await call('purgeRecord', invocation, { params: { id: contact } });

    expect(nonzero(await attached(contact))).toEqual({});
    expect((await trash(invocation)).items).toEqual([]);
    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string; payload: unknown }>(
        `select type, payload from events.events where subject_id = $1 and type = 'record.purged'`,
        [parsePublicId('contact', contact)],
      ),
    );
    expect(events).toEqual([{ type: 'record.purged', payload: { kind: 'contact' } }]);
  });

  it("refuses a record not in the trash, another business's, and anyone without trash.purge", async () => {
    const invocation = await inBusiness();
    const other = await inBusiness();
    const contact = await newContact(invocation, 'Maya');

    await expect(
      call('purgeRecord', invocation, { params: { id: contact } }),
    ).rejects.toBeInstanceOf(ConflictError);
    await call('trashContact', invocation, { params: { id: contact } });
    await expect(call('purgeRecord', other, { params: { id: contact } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      call(
        'purgeRecord',
        { ...invocation, permissions: new Set(['contacts.manage']) },
        {
          params: { id: contact },
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await trash(invocation)).items.map((item) => item.id)).toEqual([contact]);
  });

  it('keeps a record restored while it waited', async () => {
    const invocation = await inBusiness();
    const contact = await newContact(invocation, 'Maya');
    await call('trashContact', invocation, { params: { id: contact } });

    const purged = await whileHeld(restoring, [parsePublicId('contact', contact)], () =>
      call('purgeRecord', invocation, { params: { id: contact } }),
    );

    expect(purged.status === 'rejected' && purged.reason).toBeInstanceOf(ConflictError);
    expect(await call('getContact', invocation, { params: { id: contact } })).toMatchObject({
      trashedAt: null,
    });
  });

  it('locks the registry before the record, as writes to the record do', async () => {
    const invocation = await inBusiness();
    const contact = await newContact(invocation, 'Maya');
    await call('trashContact', invocation, { params: { id: contact } });

    // A write's order: the registry row, then the record's own row (requireRecord).
    const purged = await whileHeld(
      {
        hold: 'select 1 from crm.records where id = $1 for update',
        then: 'select 1 from crm.contacts where id = $1 for update',
      },
      [parsePublicId('contact', contact)],
      () => call('purgeRecord', invocation, { params: { id: contact } }),
    );

    expect(purged.status).toBe('fulfilled');
    expect((await trash(invocation)).items).toEqual([]);
  });
});

describe('the trash list', () => {
  it('shows every kind, most recently trashed first, with when each is purged', async () => {
    const invocation = await inBusiness();
    const contact = await newContact(invocation, 'Maya');
    const { company, deal } = await companyAndDeal(invocation);
    await database.as('crm_owner', (sql) =>
      sql.query(`insert into crm.settings (business_id, trash_retention_days) values ($1, 14)`, [
        businessOf(invocation),
      ]),
    );
    await call('trashContact', invocation, { params: { id: contact } });
    await database.as('crm_owner', (sql) =>
      sql.query(`update crm.companies set deleted_at = now() + interval '1 second' where id = $1`, [
        parsePublicId('company', company),
      ]),
    );
    await call('trashDeal', invocation, { params: { id: deal } });

    const list: TrashList = await trash(invocation);

    // The company was trashed last (a second ahead), then the deal, then the contact.
    expect(list.items.map((item) => [item.kind, item.name])).toEqual([
      ['company', 'Lee Family'],
      ['deal', 'Lee wedding'],
      ['contact', 'Maya'],
    ]);
    expect(list.retentionDays).toBe(14);
    for (const item of list.items)
      expect(Date.parse(item.purgeAt) - Date.parse(item.trashedAt)).toBe(14 * 24 * 60 * 60 * 1000);
    expect((await trash(invocation, { kind: 'deal' })).items.map((item) => item.id)).toEqual([
      deal,
    ]);
    expect(list.canPurge).toBe(true);
    expect((await trash({ ...invocation, permissions: new Set() })).canPurge).toBe(false);
    expect(list.items.map((item) => item.mergedInto)).toEqual([null, null, null]);
  });

  it('marks a contact merged into another with the contact it went to', async () => {
    const invocation = await inBusiness();
    const kept = await newContact(invocation, 'Kept');
    const merged = await newContact(invocation, 'Merged');
    await database.as('crm_owner', (sql) =>
      sql.query(`update crm.contacts set merged_into_id = $1, deleted_at = now() where id = $2`, [
        parsePublicId('contact', kept),
        parsePublicId('contact', merged),
      ]),
    );
    expect((await trash(invocation)).items).toMatchObject([{ id: merged, mergedInto: kept }]);
  });

  it('pages across kinds without gaps or repeats, and refuses a foreign place to start', async () => {
    const invocation = await inBusiness();
    const other = await inBusiness();
    const ids: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const id = await newContact(invocation, `Guest${String(index)}`);
      await call('trashContact', invocation, { params: { id } });
      ids.push(id);
    }
    const { deal } = await companyAndDeal(invocation);
    await call('trashDeal', invocation, { params: { id: deal } });

    const first = await trash(invocation);
    expect(first.items).toHaveLength(50);
    if (first.next === null) throw new Error('Expected a second page');
    const second = await trash(invocation, { after: first.next });
    const all = [...first.items, ...second.items].map((item) => item.id);
    expect(second.next).toBeNull();
    expect(new Set(all)).toEqual(new Set([...ids, deal]));
    expect(all).toHaveLength(61);
    const foreign = await newContact(other, 'Theirs');
    await call('trashContact', other, { params: { id: foreign } });
    await expect(trash(invocation, { after: foreign })).rejects.toBeInstanceOf(ValidationError);
    // A caller that skipped the schema gets the same answer for an id that names nothing.
    await expect(
      withTenant(db, invocation.context, (trx) => readTrash(trx, invocation, { after: 'con_x' })),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('deals in the trash', () => {
  it('leave the board and come back once', async () => {
    const invocation = await inBusiness();
    const { deal } = await companyAndDeal(invocation);

    await call('trashDeal', invocation, { params: { id: deal } });
    await call('trashDeal', invocation, { params: { id: deal } });
    await call('restoreDeal', invocation, { params: { id: deal } });

    const types = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string }>(
        `select type from events.events where subject_id = $1 order by recorded_at`,
        [parsePublicId('deal', deal)],
      ),
    );
    expect(types.map((row) => row.type)).toEqual(['deal.trashed', 'deal.restored']);
    expect((await trash(invocation)).items).toEqual([]);
  });

  it("can't be trashed or restored from another business", async () => {
    const invocation = await inBusiness();
    const other = await inBusiness();
    const { deal } = await companyAndDeal(invocation);

    await expect(call('trashDeal', other, { params: { id: deal } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(call('restoreDeal', other, { params: { id: deal } })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('the daily purge', () => {
  it("purges only what has been in the trash past its business's retention days", async () => {
    const short = await inBusiness();
    const long = await inBusiness();
    await database.as('crm_owner', (sql) =>
      sql.query(`insert into crm.settings (business_id, trash_retention_days) values ($1, 1)`, [
        businessOf(short),
      ]),
    );
    const old = await newContact(short, 'Old');
    const recent = await newContact(short, 'Recent');
    const kept = await newContact(long, 'Kept');
    for (const [invocation, id] of [
      [short, old],
      [short, recent],
      [long, kept],
    ] as const)
      await call('trashContact', invocation, { params: { id } });
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update crm.contacts set deleted_at = now() - interval '2 days' where id = any($1::uuid[])`,
        [[parsePublicId('contact', old), parsePublicId('contact', kept)]],
      ),
    );

    expect(await purgeExpiredTrash(services)).toBeGreaterThanOrEqual(1);

    expect((await trash(short)).items.map((item) => item.id)).toEqual([recent]);
    expect((await trash(long)).items.map((item) => item.id)).toEqual([kept]);
    expect(await purgeExpiredTrash(services)).toBe(0);
  });

  it('skips records others are working on, without waiting, and purges the rest', async () => {
    const invocation = await inBusiness();
    const [restored, written, expired] = [
      await newContact(invocation, 'Restored'),
      await newContact(invocation, 'Written'),
      await newContact(invocation, 'Expired'),
    ];
    const uuid = (id: string) => parsePublicId('contact', id);
    for (const id of [restored, written, expired])
      await call('trashContact', invocation, { params: { id } });
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update crm.contacts set deleted_at = now() - interval '40 days' where id = any($1::uuid[])`,
        [[uuid(restored), uuid(written), uuid(expired)]],
      ),
    );

    // A restore holds one contact's row; a write holds the other's registry row, as
    // requireRecord does.
    const purged = await whileHeld(
      {
        hold: `with restored as (
                 update crm.contacts set deleted_at = null where id = $1 returning id
               ), written as (
                 select id from crm.records where id = $2 for no key update
               ) select (select count(*) from restored), (select count(*) from written)`,
      },
      [uuid(restored), uuid(written)],
      () => runCommand(services, purgeExpiredCommand, {}, invocation),
      false,
    );

    expect(purged).toEqual({ status: 'fulfilled', value: { purged: 1 } });
    expect(await call('getContact', invocation, { params: { id: restored } })).toMatchObject({
      trashedAt: null,
    });
    await expect(
      call('getContact', invocation, { params: { id: expired } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    // The next run takes the one skipped.
    expect(await runCommand(services, purgeExpiredCommand, {}, invocation)).toEqual({
      purged: 1,
    });
    expect((await trash(invocation)).items).toEqual([]);
  });

  it('purges nothing, and records nothing, in a business with nothing expired', async () => {
    const invocation = await inBusiness();
    const recent = await newContact(invocation, 'Recent');
    await call('trashContact', invocation, { params: { id: recent } });

    expect(await runCommand(services, purgeExpiredCommand, {}, invocation)).toEqual({ purged: 0 });

    expect((await trash(invocation)).items.map((item) => item.id)).toEqual([recent]);
    const purged = await database.as('crm_owner', (sql) =>
      sql.query(`select 1 from events.events where business_id = $1 and type = 'trash.purged'`, [
        businessOf(invocation),
      ]),
    );
    expect(purged).toEqual([]);
  });
});

describe("a custom object's records in the trash", () => {
  /** A Pet object and a record of it in the trash, trashed this many days ago. */
  async function trashedPet(invocation: Invocation, name: string, days: number) {
    return database.as('crm_owner', async (sql) => {
      const business = businessOf(invocation);
      const object = await sql.query<{ id: string }>(
        `select id from crm.object_types where business_id = $1 and key = 'pet'`,
        [business],
      );
      let objectId = object[0]?.id;
      if (objectId === undefined) {
        const made = await sql.one<{ id: string; primary_field_id: string }>(
          `insert into crm.object_types (business_id, id, kind, key, singular_label, plural_label,
                                         primary_field_id)
           values ($1, uuidv7(), 'custom', 'pet', 'Pet', 'Pets', uuidv7())
           returning id, primary_field_id`,
          [business],
        );
        await sql.query(
          `insert into crm.field_definitions (business_id, id, object_type_id, key, label,
                                              description, value_type, folder_id, created_by_kind)
           select $1, $2, $3, 'pet_name', 'Pet name', 'Its name.', 'text', f.id, 'system'
           from crm.field_folders f where f.object_type_id = $3 limit 1`,
          [business, made.primary_field_id, made.id],
        );
        objectId = made.id;
      }
      const record = await sql.one<{ id: string }>(
        `with record as (
           insert into crm.records (business_id, kind, object_type_id)
           values ($1, 'custom', $2) returning id)
         insert into crm.custom_records (business_id, id, object_type_id, title, deleted_at,
                                         created_by_kind)
         select $1, id, $2, $3, now() - make_interval(days => $4), 'user' from record
         returning id`,
        [business, objectId, name, days],
      );
      return { objectId, id: toPublicId('custom', record.id) };
    });
  }

  it('lists them with their object, and purges them past the retention days', async () => {
    const invocation = await inBusiness();
    const old = await trashedPet(invocation, 'Old Buddy', 40);
    const recent = await trashedPet(invocation, 'Rex', 1);
    expect((await trash(invocation)).items).toMatchObject([
      { id: recent.id, kind: 'custom', name: 'Rex', object: { key: 'pet', label: 'Pet' } },
      { id: old.id, kind: 'custom', name: 'Old Buddy', object: { key: 'pet', label: 'Pet' } },
    ]);
    expect(await runCommand(services, purgeExpiredCommand, {}, invocation)).toEqual({ purged: 1 });
    expect((await trash(invocation, { kind: 'custom' })).items.map((item) => item.id)).toEqual([
      recent.id,
    ]);
    const [event] = await database.as('crm_owner', (sql) =>
      sql.query<{ payload: Record<string, unknown> }>(
        `select payload from events.events where business_id = $1 and type = 'trash.purged'`,
        [businessOf(invocation)],
      ),
    );
    expect(event?.payload).toMatchObject({ customRecords: 1, contacts: 0 });
  });

  it('leaves out the records of an object being deleted, which go with it', async () => {
    const invocation = await inBusiness();
    const pet = await trashedPet(invocation, 'Buddy', 1);
    await database.as('crm_owner', (sql) =>
      sql.query('update crm.object_types set archived_at = now() where id = $1', [pet.objectId]),
    );
    expect((await trash(invocation)).items).toEqual([]);
  });
});
