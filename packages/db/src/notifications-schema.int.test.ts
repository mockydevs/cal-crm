// Migration 0056: what a notification holds, the job an event queues for it, the job at a
// task's due time, read state, the refresh hint, the cleanup, and what an upgrade does for
// tasks that were already due later. Who may read and write a notification is proved in
// tests/02_tenant_isolation.sql.
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TenantContext } from '@repo/kernel';
import { startPostgres, testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { Logger, runMigrations } from 'graphile-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { bootstrapFile, migrate, workerPreset } from './index.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});

afterAll(async () => {
  await database.close();
});

const KINDS = [
  'conversation.assigned',
  'message.received',
  'message.received_other',
  // A contact you follow wrote (0117).
  'message.received_following',
  'task.assigned',
  // A task of yours is due soon, as long before as you chose (0121).
  'task.reminder',
  'task.due',
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.cancelled',
  'form.submitted',
  'ai.limit_reached',
  'automation.notice',
  // A member's Google Calendar stopped answering (0106).
  'calendar.google_disconnected',
];

const EVENT_TYPES = [
  'conversation.assigned',
  'message.received',
  'task.created',
  'task.updated',
  'form.submitted',
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.cancelled',
  'ai_settings.limit_reached',
];

interface Place {
  readonly agencyId: string;
  readonly businessId: string;
  /** The worker, in the business. */
  readonly system: TenantContext;
  /** Someone who belongs to the business, acting themselves. */
  readonly member: { readonly id: string; readonly context: TenantContext };
}

/** A person with a membership: of the business, or of the agency's staff. */
async function person(agencyId: string, businessId: string | null): Promise<string> {
  const { id } = await database.fixtures.user();
  await database.as('crm_owner', async (sql) => {
    const scope = businessId === null ? 'agency' : 'business';
    const role = await sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       values ($1, $2, 'member', 'Member', true)
       on conflict (agency_id, scope, key) do update set name = excluded.name returning id`,
      [agencyId, scope],
    );
    await sql.query(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       values ($1, $2, $3, $4)`,
      [id, agencyId, businessId, role.id],
    );
  });
  return id;
}

/** The worker with no business selected: the agency as a whole. */
function atAgency(at: { system: TenantContext }): TenantContext {
  const { businessId: _business, ...agency } = at.system;
  return agency;
}

const acting = (place: { system: TenantContext }, userId: string): TenantContext => ({
  ...place.system,
  userId,
  actorKind: 'user',
  actorId: userId,
});

async function place(): Promise<Place> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const system = { ...business.context, correlationId: randomUUID() };
  const id = await person(agency.id, business.id);
  return {
    agencyId: agency.id,
    businessId: business.id,
    system,
    member: { id, context: acting({ system }, id) },
  };
}

interface Told {
  readonly kind?: string;
  readonly sourceKey?: string;
  readonly collapseKey?: string | null;
  readonly subjectKind?: string;
  readonly subjectId?: string | null;
  readonly recordId?: string | null;
  readonly title?: string | null;
  readonly body?: string | null;
  readonly businessId?: string | null;
}

/** A notification as the worker writes one, for this person. */
function tell(sql: Sql, at: Place, userId: string, told: Told = {}): Promise<{ id: string }> {
  const kind = told.kind ?? 'ai.limit_reached';
  const subjectKind = told.subjectKind ?? 'ai_settings';
  return sql.one<{ id: string }>(
    `insert into notifications.notifications
       (agency_id, business_id, user_id, kind, source_key, collapse_key, actor_kind,
        subject_kind, subject_id, record_id, title, body)
     values ($1, $2, $3, $4, $5, $6, 'system', $7, $8, $9, $10, $11)
     returning id`,
    [
      at.agencyId,
      told.businessId === undefined ? at.businessId : told.businessId,
      userId,
      kind,
      told.sourceKey ?? `test:${randomUUID()}`,
      told.collapseKey ?? null,
      subjectKind,
      told.subjectId === undefined
        ? subjectKind === 'ai_settings'
          ? null
          : randomUUID()
        : told.subjectId,
      told.recordId ?? null,
      told.title ?? null,
      told.body ?? null,
    ],
  );
}

interface QueuedJob {
  readonly task: string;
  readonly key: string | null;
  readonly runAt: Date;
  readonly maxAttempts: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The notification jobs waiting for a business, oldest first. */
function jobsOf(businessId: string): Promise<QueuedJob[]> {
  return database.as('crm_owner', (sql) =>
    sql.query<QueuedJob>(
      `select t.identifier as task, j.key, j.run_at as "runAt", j.max_attempts as "maxAttempts",
              j.payload::jsonb as payload
       from graphile_worker._private_jobs j
       join graphile_worker._private_tasks t on t.id = j.task_id
       where t.identifier like 'notifications.%' and j.payload::jsonb ->> 'businessId' = $1
       order by j.id`,
      [businessId],
    ),
  );
}

/** Writes an event as a command does: as crm_app, in the business. */
function event(
  sql: Sql,
  at: Place,
  type: string,
  subject: { kind: string; id: string } = { kind: 'business', id: at.businessId },
): Promise<{ id: string }> {
  return sql.one<{ id: string }>(
    `insert into events.events
       (agency_id, business_id, type, actor_kind, correlation_id, subject_kind, subject_id)
     values ($1, $2, $3, 'system', $4, $5, $6) returning id`,
    [at.agencyId, at.businessId, type, at.system.correlationId, subject.kind, subject.id],
  );
}

describe('what a notification holds', () => {
  it('is a reference, a short title and a step’s words: exactly these columns, and no others', async () => {
    const columns = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; type: string; nullable: string }>(
        `select table_name || '.' || column_name as name, data_type as type, is_nullable as nullable
         from information_schema.columns where table_schema = 'notifications'
         order by table_name, ordinal_position`,
      ),
    );
    expect(columns.map(({ name, type, nullable }) => `${name} ${type} ${nullable}`)).toEqual([
      'notifications.agency_id uuid NO',
      'notifications.business_id uuid YES',
      'notifications.id uuid NO',
      'notifications.user_id uuid NO',
      'notifications.kind text NO',
      'notifications.source_key text NO',
      'notifications.collapse_key text YES',
      'notifications.event_id uuid YES',
      'notifications.actor_kind text NO',
      'notifications.actor_id uuid YES',
      'notifications.subject_kind text NO',
      'notifications.subject_id uuid YES',
      'notifications.record_id uuid YES',
      'notifications.title text YES',
      'notifications.body text YES',
      'notifications.read_at timestamp with time zone YES',
      'notifications.created_at timestamp with time zone NO',
      'notifications.expires_at timestamp with time zone NO',
      'preferences.business_id uuid NO',
      'preferences.user_id uuid NO',
      'preferences.kind text NO',
      'preferences.in_app boolean NO',
      'preferences.updated_at timestamp with time zone NO',
      'preferences.remind_minutes integer YES',
    ]);
  });

  it('is of one of the kinds, which a preference names too', async () => {
    const checks = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; definition: string }>(
        `select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint
         where conname in ('notifications_kind_valid', 'preferences_kind_valid') order by conname`,
      ),
    );
    const kindsIn = (definition: string) =>
      [...definition.matchAll(/'([a-z_.]+)'::text/g)].map((match) => match[1]);
    expect(checks.map(({ name }) => name)).toEqual([
      'notifications_kind_valid',
      'preferences_kind_valid',
    ]);
    for (const { definition } of checks) expect(kindsIn(definition)).toEqual(KINDS);
  });

  it('names what it is about, and only AI settings have no id', async () => {
    const at = await place();
    await expect(
      database.withTenant(at.system, (sql) =>
        tell(sql, at, at.member.id, { subjectKind: 'conversation', subjectId: null }),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'notifications_subject_named' });
    await expect(
      database.withTenant(at.system, (sql) =>
        tell(sql, at, at.member.id, { subjectKind: 'ai_settings', subjectId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'notifications_subject_named' });
    await expect(
      database.withTenant(at.system, (sql) =>
        tell(sql, at, at.member.id, { subjectKind: 'address' }),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'notifications_subject_kind_valid' });
  });

  it('carries words only for an automation’s notice, and bounded ones', async () => {
    const at = await place();
    await expect(
      database.withTenant(at.system, (sql) =>
        tell(sql, at, at.member.id, { body: 'Jordan wrote: call me on 0712 345 678.' }),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'notifications_body_only_notice' });
    const notice = { kind: 'automation.notice', subjectKind: 'automation' };
    await expect(
      database.withTenant(at.system, (sql) =>
        tell(sql, at, at.member.id, { ...notice, body: 'x'.repeat(1001) }),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'notifications_body_length' });
    await expect(
      database.withTenant(at.system, (sql) =>
        tell(sql, at, at.member.id, { ...notice, title: 'x'.repeat(301) }),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'notifications_title_length' });
    await database.withTenant(at.system, (sql) =>
      tell(sql, at, at.member.id, { ...notice, body: 'x'.repeat(1000), title: 'x'.repeat(300) }),
    );
  });

  it('is made once per person and source, and once while unread per person and key', async () => {
    const at = await place();
    const other = await person(at.agencyId, at.businessId);
    const first = { sourceKey: 'event:one', collapseKey: 'message.received:thread' };
    const { id } = await database.withTenant(at.system, (sql) =>
      tell(sql, at, at.member.id, first),
    );
    await expect(
      database.withTenant(at.system, (sql) =>
        tell(sql, at, at.member.id, { sourceKey: 'event:one' }),
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'notifications_once' });
    await expect(
      database.withTenant(at.system, (sql) =>
        tell(sql, at, at.member.id, { ...first, sourceKey: 'event:two' }),
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'notifications_one_unread_per_key_idx' });
    // Someone else is told of the same event, under the same key.
    await database.withTenant(at.system, (sql) => tell(sql, at, other, first));
    // Once it is read, the next one of that key is told.
    await database.withTenant(at.member.context, (sql) =>
      sql.query('update notifications.notifications set read_at = now() where id = $1', [id]),
    );
    await database.withTenant(at.system, (sql) =>
      tell(sql, at, at.member.id, { ...first, sourceKey: 'event:two' }),
    );
  });

  it('is about a record of its own business, and goes when the record is purged', async () => {
    const at = await place();
    const elsewhere = await place();
    const contact = await database.fixtures.contact(at.system);
    const theirs = await database.fixtures.contact(elsewhere.system);
    await expect(
      database.withTenant(at.system, (sql) => tell(sql, at, at.member.id, { recordId: theirs.id })),
    ).rejects.toMatchObject({ code: '23503' });
    const agencyWide = { businessId: null, recordId: contact.id };
    const staff = await person(at.agencyId, null);
    await expect(
      database.withTenant(atAgency(at), (sql) => tell(sql, at, staff, agencyWide)),
    ).rejects.toMatchObject({ code: '23514', constraint: 'notifications_record_in_business' });

    const { id } = await database.withTenant(at.system, (sql) =>
      tell(sql, at, at.member.id, { recordId: contact.id }),
    );
    const kept = await database.withTenant(at.system, (sql) => tell(sql, at, at.member.id));
    await database.withTenant(at.system, (sql) =>
      sql.query('delete from crm.records where id = $1', [contact.id]),
    );
    const left = await database.as('crm_owner', (sql) =>
      sql.query<{ id: string }>('select id from notifications.notifications where id in ($1, $2)', [
        id,
        kept.id,
      ]),
    );
    expect(left).toEqual([{ id: kept.id }]);
  });
});

describe('an event', () => {
  it('is one of exactly these types to be told of', async () => {
    const { types } = await database.withTenant((await place()).system, (sql) =>
      sql.one<{ types: string[] }>('select private.notification_event_types() as types'),
    );
    expect(types).toEqual(EVENT_TYPES);
  });

  it.each(EVENT_TYPES)('of type %s queues one job that names it', async (type) => {
    const at = await place();
    const written = await database.withTenant(at.system, (sql) => event(sql, at, type));
    expect((await jobsOf(at.businessId)).filter(({ key }) => key?.startsWith('notify:'))).toEqual([
      {
        task: 'notifications.from_event',
        key: `notify:${written.id}`,
        runAt: expect.any(Date) as Date,
        maxAttempts: 10,
        payload: {
          agencyId: at.agencyId,
          businessId: at.businessId,
          correlationId: at.system.correlationId,
          causationId: written.id,
          data: { eventId: written.id },
        },
      },
    ]);
  });

  it.each(['contact.created', 'conversation.unassigned', 'task.completed', 'tag.assigned'])(
    'of type %s queues none',
    async (type) => {
      const at = await place();
      await database.withTenant(at.system, (sql) => event(sql, at, type));
      expect(await jobsOf(at.businessId)).toEqual([]);
    },
  );

  it('that rolled back queues nothing', async () => {
    const at = await place();
    await expect(
      database.withTenant(at.system, async (sql) => {
        await event(sql, at, 'message.received');
        throw new Error('the command failed after its event');
      }),
    ).rejects.toThrow('the command failed after its event');
    expect(await jobsOf(at.businessId)).toEqual([]);
  });

  it('about the agency as a whole queues its job with no business', async () => {
    const at = await place();
    const written = await database.withTenant(atAgency(at), (sql) =>
      sql.one<{ id: string }>(
        `insert into events.events
           (agency_id, business_id, type, actor_kind, correlation_id, subject_kind, subject_id)
         values ($1, null, 'ai_settings.limit_reached', 'system', $2, 'agency', $1) returning id`,
        [at.agencyId, at.system.correlationId],
      ),
    );
    const jobs = await database.as('crm_owner', (sql) =>
      sql.query<{ payload: Record<string, unknown> }>(
        `select payload::jsonb as payload from graphile_worker._private_jobs where key = $1`,
        [`notify:${written.id}`],
      ),
    );
    expect(jobs).toEqual([
      {
        payload: {
          agencyId: at.agencyId,
          businessId: null,
          correlationId: at.system.correlationId,
          causationId: written.id,
          data: { eventId: written.id },
        },
      },
    ]);
  });
});

describe('a task’s due time', () => {
  const HOUR = 3_600_000;
  // Whole seconds, well clear of now, so the stored time compares exactly.
  const later = (hours: number) => new Date(Math.floor(Date.now() / 1000) * 1000 + hours * HOUR);

  async function task(
    at: Place,
    values: { dueAt: Date | null; assignee: string | null; completed?: boolean },
  ): Promise<string> {
    const { id } = await database.withTenant(at.system, (sql) =>
      sql.one<{ id: string }>(
        `insert into crm.tasks (business_id, title, due_at, assignee_user_id, created_by_kind,
                                completed_at, completed_by_kind)
         values ($1, 'Call the venue back', $2, $3, 'system', $4, $5) returning id`,
        [
          at.businessId,
          values.dueAt,
          values.assignee,
          values.completed === true ? new Date() : null,
          values.completed === true ? 'system' : null,
        ],
      ),
    );
    return id;
  }
  const said = (at: Place, type: string, taskId: string) =>
    database.withTenant(at.system, (sql) => event(sql, at, type, { kind: 'task', id: taskId }));
  const dueJobs = async (at: Place) =>
    (await jobsOf(at.businessId)).filter(({ task: name }) => name === 'notifications.task_due');

  it('gets one job at that time when the task is open and assigned', async () => {
    const at = await place();
    const dueAt = later(2);
    const taskId = await task(at, { dueAt, assignee: at.member.id });
    const written = await said(at, 'task.created', taskId);
    expect(await dueJobs(at)).toEqual([
      {
        task: 'notifications.task_due',
        key: `notify-task-due:${taskId}`,
        runAt: dueAt,
        maxAttempts: 10,
        payload: {
          agencyId: at.agencyId,
          businessId: at.businessId,
          correlationId: at.system.correlationId,
          causationId: written.id,
          data: { taskId },
        },
      },
    ]);
  });

  it('moves with the task: one job, at the new time', async () => {
    const at = await place();
    const taskId = await task(at, { dueAt: later(2), assignee: at.member.id });
    await said(at, 'task.created', taskId);
    const moved = later(30);
    await database.withTenant(at.system, (sql) =>
      sql.query('update crm.tasks set due_at = $2 where id = $1', [taskId, moved]),
    );
    await said(at, 'task.updated', taskId);
    expect((await dueJobs(at)).map(({ key, runAt }) => ({ key, runAt }))).toEqual([
      { key: `notify-task-due:${taskId}`, runAt: moved },
    ]);
  });

  it.each([
    ['is completed', 'task.completed', "completed_at = now(), completed_by_kind = 'system'"],
    ['loses its assignee', 'task.updated', 'assignee_user_id = null'],
    ['loses its due date', 'task.updated', 'due_at = null'],
  ])('is no longer waited for when the task %s', async (_name, type, change) => {
    const at = await place();
    const taskId = await task(at, { dueAt: later(2), assignee: at.member.id });
    await said(at, 'task.created', taskId);
    expect(await dueJobs(at)).toHaveLength(1);
    await database.withTenant(at.system, (sql) =>
      sql.query(`update crm.tasks set ${change} where id = $1`, [taskId]),
    );
    await said(at, type, taskId);
    expect(await dueJobs(at)).toEqual([]);
  });

  it('is no longer waited for when the task is deleted, and is again when it is reopened', async () => {
    const at = await place();
    const taskId = await task(at, { dueAt: later(2), assignee: at.member.id });
    await said(at, 'task.created', taskId);
    await database.withTenant(at.system, (sql) =>
      sql.query(
        "update crm.tasks set completed_at = now(), completed_by_kind = 'system' where id = $1",
        [taskId],
      ),
    );
    await said(at, 'task.completed', taskId);
    expect(await dueJobs(at)).toEqual([]);
    await database.withTenant(at.system, (sql) =>
      sql.query(
        'update crm.tasks set completed_at = null, completed_by_kind = null where id = $1',
        [taskId],
      ),
    );
    await said(at, 'task.reopened', taskId);
    expect(await dueJobs(at)).toHaveLength(1);
    await database.withTenant(at.system, (sql) =>
      sql.query('delete from crm.tasks where id = $1', [taskId]),
    );
    await said(at, 'task.deleted', taskId);
    expect(await dueJobs(at)).toEqual([]);
  });

  it.each([
    ['nobody has', { dueAt: later(2), assignee: null }],
    ['has no due date', { dueAt: null, assignee: 'member' }],
    ['was already due when it was made', { dueAt: later(-2), assignee: 'member' }],
  ] as const)('gets no job for a task that %s', async (_name, values) => {
    const at = await place();
    const taskId = await task(at, {
      dueAt: values.dueAt,
      assignee: values.assignee === null ? null : at.member.id,
    });
    await said(at, 'task.created', taskId);
    expect(await dueJobs(at)).toEqual([]);
  });
});

describe('read state', () => {
  it('keeps a notification 90 days, and 30 days from when it is read if that is sooner', async () => {
    const at = await place();
    const fresh = await database.withTenant(at.system, (sql) => tell(sql, at, at.member.id));
    const old = await database.withTenant(at.system, (sql) => tell(sql, at, at.member.id));
    // The second one was made 80 days ago: 10 days of its 90 are left.
    await database.as('crm_owner', (sql) =>
      sql.query(
        `update notifications.notifications
         set created_at = now() - interval '80 days', expires_at = now() + interval '10 days'
         where id = $1`,
        [old.id],
      ),
    );
    const kept = () =>
      database.as('crm_owner', (sql) =>
        sql.query<{ id: string; days: number; read: boolean }>(
          `select id, round(extract(epoch from expires_at - now()) / 86400)::int as days,
                  read_at is not null as read
           from notifications.notifications where id in ($1, $2) order by id`,
          [fresh.id, old.id],
        ),
      );
    expect(await kept()).toEqual([
      { id: fresh.id, days: 90, read: false },
      { id: old.id, days: 10, read: false },
    ]);
    await database.withTenant(at.member.context, (sql) =>
      sql.query('update notifications.notifications set read_at = now() where id in ($1, $2)', [
        fresh.id,
        old.id,
      ]),
    );
    expect(await kept()).toEqual([
      { id: fresh.id, days: 30, read: true },
      { id: old.id, days: 10, read: true },
    ]);
  });
});

describe('open dashboards', () => {
  it('are told to refetch by a new notification and by one read, and by nothing that rolled back', async () => {
    const at = await place();
    const staff = await person(at.agencyId, null);
    const listener = new pg.Client({ connectionString: database.url('crm_app') });
    const heard: string[] = [];
    listener.on('notification', (notification) => {
      if (notification.channel === 'crm_business_changed') heard.push(notification.payload ?? '');
    });
    await listener.connect();
    try {
      await listener.query('listen crm_business_changed');
      // Notifications arrive in commit order, so once a marker sent afterwards is heard,
      // everything the work caused has been heard too.
      const settled = async (): Promise<string[]> => {
        const marker = randomUUID();
        await database.as('postgres', (sql) =>
          sql.query("select pg_notify('crm_business_changed', $1)", [marker]),
        );
        await expect.poll(() => heard, { timeout: 10_000 }).toContain(marker);
        return heard.splice(0).filter((payload) => payload !== marker);
      };

      const { id } = await database.withTenant(at.system, (sql) => tell(sql, at, at.member.id));
      expect(await settled()).toEqual([at.businessId]);

      await database.withTenant(at.member.context, (sql) =>
        sql.query('update notifications.notifications set read_at = now() where id = $1', [id]),
      );
      expect(await settled()).toEqual([at.businessId]);

      await expect(
        database.withTenant(at.system, async (sql) => {
          await tell(sql, at, at.member.id);
          throw new Error('the job failed after writing');
        }),
      ).rejects.toThrow('the job failed after writing');
      expect(await settled()).toEqual([]);

      // About the agency as a whole: there is no business to tell.
      await database.withTenant(atAgency(at), (sql) => tell(sql, at, staff, { businessId: null }));
      expect(await settled()).toEqual([]);
    } finally {
      await listener.end();
    }
  });
});

describe('the cleanup', () => {
  it('removes what is past its time, a bounded number at a time, and nothing else', async () => {
    const at = await place();
    const ids: string[] = [];
    for (let made = 0; made < 4; made += 1)
      ids.push((await database.withTenant(at.system, (sql) => tell(sql, at, at.member.id))).id);
    const [oldest, older, old, current] = ids;
    await database.as('crm_owner', async (sql) => {
      for (const [id, days] of [
        [oldest, 3],
        [older, 2],
        [old, 1],
      ] as const)
        await sql.query(
          `update notifications.notifications set expires_at = now() - make_interval(days => $2)
           where id = $1`,
          [id, days],
        );
    });
    const expire = (limit: number) =>
      database.as('crm_app', (sql) =>
        sql.one<{ removed: number }>('select private.expire_notifications($1) as removed', [limit]),
      );
    const left = async () =>
      (
        await database.as('crm_owner', (sql) =>
          sql.query<{ id: string }>(
            'select id from notifications.notifications where business_id = $1 order by id',
            [at.businessId],
          ),
        )
      ).map(({ id }) => id);

    // The oldest go first, two at a time.
    expect(await expire(2)).toEqual({ removed: 2 });
    expect(await left()).toEqual([old, current]);

    // A row someone holds is skipped, not waited for: the call returns with it in place.
    await database.as('crm_owner', async (holder) => {
      await holder.query('select 1 from notifications.notifications where id = $1 for update', [
        old,
      ]);
      expect(await expire(10)).toEqual({ removed: 0 });
    });
    expect(await left()).toEqual([old, current]);
    expect(await expire(10)).toEqual({ removed: 1 });
    expect(await left()).toEqual([current]);
  });

  it('is the only way the application removes a notification', async () => {
    const at = await place();
    const { id } = await database.withTenant(at.system, (sql) => tell(sql, at, at.member.id));
    for (const context of [at.system, at.member.context])
      await expect(
        database.withTenant(context, (sql) =>
          sql.query('delete from notifications.notifications where id = $1', [id]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('an upgrade', () => {
  it('gives a job to each task that was already open, assigned and due later', async () => {
    const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
    const NOTIFICATIONS = '0056_notifications.sql';
    const postgres = await startPostgres({ bootstrapFile });
    const earlier = await mkdtemp(join(tmpdir(), 'crm-before-notifications-'));
    try {
      for (const name of await readdir(migrationsDirectory))
        if (name < NOTIFICATIONS) await cp(join(migrationsDirectory, name), join(earlier, name));
      const name = await postgres.createDatabase();
      const owner = postgres.url(name, 'crm_owner');
      // An install as it was before: its migrations, then the queue.
      await migrate({ connectionString: owner, directory: earlier });
      await runMigrations({
        connectionString: owner,
        preset: workerPreset,
        logger: new Logger(() => () => undefined),
      });
      const client = new pg.Client({ connectionString: owner });
      await client.connect();
      try {
        const one = async (text: string, values: readonly unknown[] = []): Promise<string> => {
          const { rows } = await client.query<{ id: string }>(text, [...values]);
          const id = rows[0]?.id;
          if (id === undefined) throw new Error(`Nothing was returned by: ${text}`);
          return id;
        };
        const agency = await one(
          "insert into tenancy.agencies (name, slug) values ('Before', 'before') returning id",
        );
        const business = await one(
          `insert into tenancy.businesses (agency_id, name, slug) values ($1, 'Before', 'before')
           returning id`,
          [agency],
        );
        const user = await one(
          "insert into auth.users (email, name) values ('before@example.com', 'Before') returning id",
        );
        const taskOf = (title: string, due: string, assignee: string | null, done: boolean) =>
          one(
            `insert into crm.tasks (business_id, title, due_at, assignee_user_id, created_by_kind,
                                    completed_at, completed_by_kind)
             values ($1, $2, now() + $3::interval, $4, 'system',
                     case when $5 then now() end, case when $5 then 'system' end)
             returning id`,
            [business, title, due, assignee, done],
          );
        const waiting = await taskOf('Due later', '3 days', user, false);
        await taskOf('Already due', '-1 day', user, false);
        await taskOf('Nobody has it', '3 days', null, false);
        await taskOf('Done', '3 days', user, true);

        const { applied } = await migrate({ connectionString: owner });
        expect(applied).toContain(NOTIFICATIONS);

        const { rows } = await client.query<{ key: string; onTime: boolean; payload: unknown }>(
          `select j.key, j.run_at = t.due_at as "onTime", j.payload::jsonb as payload
           from graphile_worker._private_jobs j
           join crm.tasks t on j.key = 'notify-task-due:' || t.id::text`,
        );
        expect(rows).toEqual([
          {
            key: `notify-task-due:${waiting}`,
            onTime: true,
            payload: {
              agencyId: agency,
              businessId: business,
              correlationId: expect.any(String) as string,
              causationId: null,
              data: { taskId: waiting },
            },
          },
        ]);
      } finally {
        await client.end();
      }
    } finally {
      await postgres.stop();
      await rm(earlier, { recursive: true, force: true });
    }
  });
});
