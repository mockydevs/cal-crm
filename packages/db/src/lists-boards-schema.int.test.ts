// Migration 0057 at the database's own level: the index a contact's last activity is read
// from, a view's table columns, a deal's source and the time its status last changed, a
// conversation's star, and the bound on an appointment's length; then what the migration
// does to the deals an install already had. What the modules do with these is theirs to
// prove (packages/modules/crm, messaging, calendar).
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TenantContext } from '@repo/kernel';
import {
  startPostgres,
  testDatabase,
  type Postgres,
  type Sql,
  type TestDatabase,
} from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { bootstrapFile, migrate } from './index.js';

const MIGRATION = '0057_lists_boards_data.sql';
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

/** The timeline entries that are a contact's activity, exactly as the list's query names them. */
const ACTIVITY_EVENTS = [
  'appointment.booked',
  'appointment.cancelled',
  'appointment.rescheduled',
  'form.submitted',
  'message.received',
];

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

/** A pipeline with one stage, and a way to add a deal to it. */
async function pipeline(sql: Sql): Promise<{ pipelineId: string; stageId: string }> {
  const created = await sql.one<{ id: string }>(
    `insert into crm.pipelines (business_id, name) values (app.business_id(), $1) returning id`,
    [`Sales ${randomUUID().slice(0, 8)}`],
  );
  const stage = await sql.one<{ id: string }>(
    `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
     values (app.business_id(), $1, 'New', 0) returning id`,
    [created.id],
  );
  return { pipelineId: created.id, stageId: stage.id };
}
interface DealRow {
  id: string;
  created_at: string;
  closed_at: string | null;
  status_changed_at: string;
  source: string | null;
}
const DEAL_COLUMNS = `id, created_at::text, closed_at::text, status_changed_at::text, source`;
async function deal(
  sql: Sql,
  place: { pipelineId: string; stageId: string },
  values: { status?: string; closedAt?: string | null; source?: string | null } = {},
): Promise<DealRow> {
  return sql.one<DealRow>(
    `with record as (
       insert into crm.records (business_id, kind, object_type_id)
       select app.business_id(), 'deal', id from crm.object_types where kind = 'deal'
       returning id)
     insert into crm.deals (business_id, id, name, pipeline_id, stage_id, currency, status,
                            closed_at, source, created_by_kind)
     select app.business_id(), id, 'Roof repair', $1, $2, 'KES', $3, $4::timestamptz, $5, 'user'
     from record returning ${DEAL_COLUMNS}`,
    [
      place.pipelineId,
      place.stageId,
      values.status ?? 'open',
      values.closedAt ?? null,
      values.source ?? null,
    ],
  );
}

describe("a contact's activity index", () => {
  it('is on the timeline and every partition of it, and holds the activity entries only', async () => {
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ table_name: string; definition: string }>(
        `select i.indrelid::regclass::text as table_name, pg_get_indexdef(i.indexrelid) as definition
         from pg_index i
         where pg_get_expr(i.indpred, i.indrelid) like '%message.received%'
           and (i.indrelid = 'crm.timeline_entries'::regclass
                or i.indrelid in (select inhrelid from pg_inherits
                                  where inhparent = 'crm.timeline_entries'::regclass))
         order by 1`,
      ),
    );
    const partitions = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string }>(
        `select inhrelid::regclass::text as name from pg_inherits
         where inhparent = 'crm.timeline_entries'::regclass order by 1`,
      ),
    );
    expect(partitions.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.table_name)).toEqual(
      ['crm.timeline_entries', ...partitions.map((partition) => partition.name)].sort(),
    );
    for (const { definition } of rows) {
      expect(definition).toContain(
        '(business_id, record_id, occurred_at DESC, event_id DESC) INCLUDE (event_recorded_at, event_type)',
      );
      // Each event that counts is named, and nothing else is.
      const named = [...definition.matchAll(/'([a-z_.]+)'::text/g)].map((match) => match[1]);
      expect(named.sort()).toEqual(ACTIVITY_EVENTS);
    }
  });

  it('covers a partition made after the migration', async () => {
    const made = await database.as('crm_owner', async (sql) => {
      // A month far ahead, as the daily maintenance would make it when its time comes.
      await sql.query(
        `create table crm.timeline_entries_p2031_01 partition of crm.timeline_entries
         for values from ('2031-01-01') to ('2031-02-01')`,
      );
      return sql.query<{ predicate: string }>(
        `select pg_get_expr(indpred, indrelid) as predicate from pg_index
         where indrelid = 'crm.timeline_entries_p2031_01'::regclass and indpred is not null`,
      );
    });
    expect(made).toHaveLength(1);
    expect(made[0]?.predicate).toContain('form.submitted');
  });
});

describe("a saved view's table columns", () => {
  it('are a list or nothing', async () => {
    const context = await business();
    const user = await database.fixtures.user();
    const person: TenantContext = {
      ...context,
      actorKind: 'user',
      userId: user.id,
      actorId: user.id,
    };
    const view = (columns: string | null) =>
      database.withTenant(person, (sql) =>
        sql.one<{ table_columns: unknown }>(
          `insert into crm.saved_views (business_id, object_type_id, name, owner_user_id, table_columns)
           select app.business_id(), id, $1, app.user_id(), $2::jsonb
           from crm.object_types where kind = 'contact' returning table_columns`,
          [`View ${randomUUID().slice(0, 8)}`, columns],
        ),
      );
    expect((await view(null)).table_columns).toBeNull();
    expect((await view('["name", "lastActivity"]')).table_columns).toEqual([
      'name',
      'lastActivity',
    ]);
    await refused(view('{"name": true}'), 'saved_views_table_columns_array');
    await refused(view('"name"'), 'saved_views_table_columns_array');
  });
});

describe("a deal's source", () => {
  it('is null or 1 to 200 characters without outer spaces', async () => {
    const context = await business();
    await database.withTenant(context, async (sql) => {
      const place = await pipeline(sql);
      expect((await deal(sql, place)).source).toBeNull();
      expect((await deal(sql, place, { source: 'Website form' })).source).toBe('Website form');
      expect((await deal(sql, place, { source: 'x'.repeat(200) })).source).toHaveLength(200);
    });
    for (const source of ['', ' ', ' Referral', 'Referral ', 'x'.repeat(201)]) {
      await refused(
        database.withTenant(context, async (sql) => deal(sql, await pipeline(sql), { source })),
        'deals_source_length',
      );
    }
  });
});

describe("the time a deal's status last changed", () => {
  it('is the creation for a new open deal and the close for one made closed', async () => {
    const context = await business();
    await database.withTenant(context, async (sql) => {
      const place = await pipeline(sql);
      const open = await deal(sql, place);
      expect(open.status_changed_at).toBe(open.created_at);
      const won = await deal(sql, place, {
        status: 'won',
        closedAt: '2026-03-04T05:06:07.123456Z',
      });
      expect(won.status_changed_at).toBe(won.closed_at);
      expect(won.status_changed_at).not.toBe(won.created_at);
    });
  });

  it('moves with every change of status, to the microsecond, and with nothing else', async () => {
    const context = await business();
    await database.withTenant(context, async (sql) => {
      const place = await pipeline(sql);
      const made = await deal(sql, place);
      const change = (set: string, values: readonly unknown[] = []) =>
        sql.one<DealRow>(`update crm.deals set ${set} where id = $1 returning ${DEAL_COLUMNS}`, [
          made.id,
          ...values,
        ]);
      // An edit that leaves the status alone leaves the time alone, whatever it tries to set.
      const renamed = await change(
        `name = 'Roof replacement', status_changed_at = now() + interval '1 day'`,
      );
      expect(renamed.status_changed_at).toBe(made.status_changed_at);

      const won = await change(`status = 'won', closed_at = $2::timestamptz`, [
        '2026-05-06T07:08:09.654321Z',
      ]);
      expect(won.status_changed_at).toBe(won.closed_at);
      const lost = await change(
        `status = 'lost', closed_at = $2::timestamptz, lost_note = 'Price'`,
        ['2026-05-07T07:08:09.000001Z'],
      );
      expect(lost.status_changed_at).toBe(lost.closed_at);

      // A reopening has no close to take its time from: the database's clock gives it,
      // read on both sides here.
      const [before] = await sql.query<{ at: string }>('select clock_timestamp()::text as at');
      const reopened = await change(`status = 'open', closed_at = null, lost_note = null`);
      const [after] = await sql.query<{ at: string }>('select clock_timestamp()::text as at');
      expect(reopened.closed_at).toBeNull();
      const [placed] = await sql.query<{ between: boolean }>(
        `select $1::timestamptz between $2::timestamptz and $3::timestamptz as between`,
        [reopened.status_changed_at, before?.at, after?.at],
      );
      expect(placed?.between).toBe(true);
    });
  });
});

describe("a conversation's star", () => {
  it('is a time or nothing, and the starred index holds starred conversations only', async () => {
    const context = await business();
    const contact = await database.fixtures.contact(context, { email: 'maya@example.test' });
    const row = await database.withTenant(context, async (sql) => {
      const created = await sql.one<{ id: string; starred_at: string | null }>(
        `insert into messaging.conversations (business_id, contact_id)
         values (app.business_id(), $1) returning id, starred_at::text`,
        [contact.id],
      );
      expect(created.starred_at).toBeNull();
      return sql.one<{ starred_at: string | null; unread_count: number }>(
        `update messaging.conversations set starred_at = now() where id = $1
         returning starred_at::text, unread_count`,
        [created.id],
      );
    });
    expect(row.starred_at).not.toBeNull();
    // The counters the database derives are untouched by a star.
    expect(row.unread_count).toBe(0);
    const [index] = await database.as('crm_owner', (sql) =>
      sql.query<{ predicate: string }>(
        `select pg_get_expr(indpred, indrelid) as predicate from pg_index
         where indexrelid = 'messaging.conversations_starred_idx'::regclass`,
      ),
    );
    expect(index?.predicate).toBe('(starred_at IS NOT NULL)');
  });
});

describe("an appointment's length", () => {
  it('is at most 31 days, so a window is read from one range of start times', async () => {
    const context = await business();
    const contact = await database.fixtures.contact(context, { email: 'ken@example.test' });
    const book = (length: string) =>
      database.withTenant(context, async (sql) => {
        const calendar = await sql.one<{ id: string }>(
          `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
           values (app.business_id(), 'Site visits', 'personal', 'Africa/Nairobi', $1) returning id`,
          [`visits-${randomUUID().slice(0, 8)}`],
        );
        return sql.one<{ id: string }>(
          `insert into calendar.appointments
             (business_id, calendar_id, contact_id, title, starts_at, ends_at, source)
           values (app.business_id(), $1, $2, 'Site visit', '2026-11-02T06:00:00Z',
                   '2026-11-02T06:00:00Z'::timestamptz + $3::interval, 'user') returning id`,
          [calendar.id, contact.id, length],
        );
      });
    expect((await book('31 days')).id).toEqual(expect.any(String));
    await refused(book('31 days 1 second'), 'appointments_duration_bounded');
  });
});

describe('an install that already has deals', () => {
  let postgres: Postgres;
  let earlier: string;
  beforeAll(async () => {
    postgres = await startPostgres({ bootstrapFile });
    earlier = await mkdtemp(join(tmpdir(), 'crm-before-lists-boards-'));
    for (const name of await readdir(migrationsDirectory))
      if (name < MIGRATION) await cp(join(migrationsDirectory, name), join(earlier, name));
  });
  afterAll(async () => {
    await postgres.stop();
    await rm(earlier, { recursive: true, force: true });
  });

  it('dates each status from its close, its reopening in the event log, or its creation', async () => {
    const created = await postgres.createDatabase();
    const connectionString = postgres.url(created);
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
      const businessId = await one(
        "insert into tenancy.businesses (agency_id, name, slug) values ($1, 'Business', 'business') returning id",
        [agency],
      );
      const objectType = await one(
        `insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
         values ($1, 'deal', 'deal', 'Deal', 'Deals') returning id`,
        [businessId],
      );
      const pipelineId = await one(
        "insert into crm.pipelines (business_id, name) values ($1, 'Sales') returning id",
        [businessId],
      );
      const stageId = await one(
        `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
         values ($1, $2, 'New', 0) returning id`,
        [businessId, pipelineId],
      );
      const earlierDeal = (status: string, closedAt: string | null) =>
        one(
          `with record as (
             insert into crm.records (business_id, kind, object_type_id)
             values ($1, 'deal', $2) returning id)
           insert into crm.deals (business_id, id, name, pipeline_id, stage_id, currency, status,
                                  closed_at, created_by_kind, created_at)
           select $1, id, 'Roof repair', $3, $4, 'KES', $5, $6::timestamptz, 'user',
                  '2026-01-02T03:04:05.000006Z'
           from record returning id`,
          [businessId, objectType, pipelineId, stageId, status, closedAt],
        );
      const reopenedAt = (dealId: string, at: string) =>
        owner.query(
          `insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
                                      subject_kind, subject_id, occurred_at)
           values ($1, $2, 'deal.reopened', 'user', uuidv7(), 'deal', $3, $4::timestamptz)`,
          [agency, businessId, dealId, at],
        );
      const neverClosed = await earlierDeal('open', null);
      const won = await earlierDeal('won', '2026-02-03T04:05:06.000007Z');
      // Reopened twice: the later reopening is when it last became open.
      const reopened = await earlierDeal('open', null);
      await reopenedAt(reopened, '2026-03-01T00:00:00.000001Z');
      await reopenedAt(reopened, '2026-04-01T00:00:00.000002Z');
      // Another deal's reopening, and this deal's other events, decide nothing for it.
      await owner.query(
        `insert into events.events (agency_id, business_id, type, actor_kind, correlation_id,
                                    subject_kind, subject_id, occurred_at)
         values ($1, $2, 'deal.updated', 'user', uuidv7(), 'deal', $3, '2026-05-01T00:00:00Z')`,
        [agency, businessId, neverClosed],
      );

      const upgrade = await migrate({ connectionString });
      expect(upgrade.applied).toContain(MIGRATION);

      const { rows } = await owner.query<{ id: string; at: string }>(
        `select id, to_char(status_changed_at at time zone 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
         from crm.deals where business_id = $1`,
        [businessId],
      );
      expect(new Map(rows.map((row) => [row.id, row.at]))).toEqual(
        new Map([
          [neverClosed, '2026-01-02T03:04:05.000006Z'],
          [won, '2026-02-03T04:05:06.000007Z'],
          [reopened, '2026-04-01T00:00:00.000002Z'],
        ]),
      );
      // Afterwards the column is kept by the database, and never empty.
      const { rows: columns } = await owner.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
         where table_schema = 'crm' and table_name = 'deals' and column_name = 'status_changed_at'`,
      );
      expect(columns).toEqual([{ is_nullable: 'NO' }]);
    } finally {
      await owner.end();
    }
  });
});
