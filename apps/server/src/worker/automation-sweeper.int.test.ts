import { randomUUID } from 'node:crypto';

import { allowEveryone, defineTask, type Services } from '@repo/commands';
import { automationDocument } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { publishAutomationVersion } from '@repo/module-automation';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import * as z from 'zod';

import { SCHEDULE_AUTOMATIONS, startWorker, type Worker } from './worker.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let worker: Worker | undefined;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await worker?.stop();
  await db.destroy();
  await database.close();
});

it('registers the due-enrolment sweeper and queues only identifiers in the enrolment tenant', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context);
  const enrolment = await database.withTenant(business.context, (client) =>
    client.one<{ id: string }>(
      `with automation as (
         insert into automation.automations (business_id,name,draft,created_by_kind)
         values ($1,'Sweeper fixture','{}','system') returning id
       ), version as (
         insert into automation.versions (business_id,automation_id,version,document,published_by_kind)
         select $1,id,1,'{}','system' from automation returning id,automation_id
       )
       insert into automation.enrolments
         (business_id,automation_id,version_id,record_id,reentry_key,current_step,status,wake_at,state,correlation_id)
       select $1,automation_id,id,$2,$2,'resume','waiting',now()-interval '1 second','{"sequence":3}',$3
       from version returning id`,
      [business.id, contact.id, randomUUID()],
    ),
  );
  const received: { data: unknown; context: TenantContext }[] = [];
  const step = defineTask({
    name: 'automations.run_step',
    data: z.strictObject({ enrolmentId: z.uuid(), sequence: z.int().min(0) }),
    run(data, job) {
      received.push({ data, context: job.invocation.context });
      return Promise.resolve();
    },
  });
  worker = await startWorker({
    connectionString: database.url('crm_worker'),
    services,
    tasks: [step],
    logger: pino({ level: 'silent' }),
    shutdownTimeoutMs: 1000,
  });
  // Exercise the registered cron task directly, without waiting for a minute boundary.
  await database.as('crm_owner', (client) =>
    client.query('select graphile_worker.add_job($1)', ['automations.schedule_due']),
  );
  await expect.poll(() => received.length, { timeout: 5000 }).toBe(1);
  expect(received).toEqual([
    {
      data: { enrolmentId: enrolment.id, sequence: 3 },
      context: {
        agencyId: agency.id,
        businessId: business.id,
        actorKind: 'system',
        correlationId: received[0]?.context.correlationId,
      },
    },
  ]);
  expect(received[0]?.context.correlationId).toMatch(
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
  );
});

it('folds automation statistics on the same minute, and purges deleted automations with the daily purge', async () => {
  await worker?.stop();
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context);
  // One automation with a run, whose statistics wait to be folded; and one deleted 31 days ago.
  const made = await database.withTenant(business.context, (client) =>
    client.one<{ live: string; deleted: string }>(
      `with live as (
         insert into automation.automations (business_id,name,draft,created_by_kind)
         values ($1,'Counted','{}','system') returning id
       ), version as (
         insert into automation.versions (business_id,automation_id,version,document,published_by_kind)
         select $1,id,1,'{}','system' from live returning id,automation_id
       ), run as (
         insert into automation.enrolments
           (business_id,automation_id,version_id,record_id,reentry_key,current_step,correlation_id)
         select $1,automation_id,id,$2,$2,'pause',$3 from version returning automation_id
       ), deleted as (
         insert into automation.automations (business_id,name,draft,created_by_kind,status,archived_at)
         values ($1,'Long gone','{}','system','archived',now()-interval '31 days') returning id
       )
       select run.automation_id as live, deleted.id as deleted from run, deleted`,
      [business.id, contact.id, randomUUID()],
    ),
  );
  const counters = () =>
    database.as('crm_owner', (client) =>
      client.one<{ unfolded: number; enrolled: number }>(
        `select (select count(*)::int from automation.stat_deltas where automation_id = $1) as unfolded,
                (select coalesce(sum(n), 0)::int from automation.stat_counts
                 where automation_id = $1 and scope = 'run' and metric = 'enrolled') as enrolled`,
        [made.live],
      ),
    );
  expect(await counters()).toMatchObject({ enrolled: 0 });
  expect((await counters()).unfolded).toBeGreaterThan(0);
  worker = await startWorker({
    connectionString: database.url('crm_worker'),
    services,
    tasks: [
      defineTask({
        name: 'automations.run_step',
        data: z.strictObject({ enrolmentId: z.uuid(), sequence: z.int().min(0) }),
        run: () => Promise.resolve(),
      }),
    ],
    logger: pino({ level: 'silent' }),
    shutdownTimeoutMs: 1000,
  });
  // Each registered task is asked for directly, without waiting for its minute or its day.
  await database.as('crm_owner', (client) =>
    client.query('select graphile_worker.add_job($1)', ['automations.schedule_due']),
  );
  await expect.poll(counters, { timeout: 30_000 }).toEqual({ unfolded: 0, enrolled: 1 });
  const left = () =>
    database.as('crm_owner', (client) =>
      client.query<{ name: string }>(
        'select name from automation.automations where business_id = $1 order by name',
        [business.id],
      ),
    );
  expect(await left()).toEqual([{ name: 'Counted' }, { name: 'Long gone' }]);
  await database.as('crm_owner', (client) =>
    client.query('select graphile_worker.add_job($1)', ['trash.purge']),
  );
  await expect.poll(left, { timeout: 30_000 }).toEqual([{ name: 'Counted' }]);
});

// A line of the worker's log, as pino writes it.
const logLine = z.looseObject({ level: z.number(), msg: z.string() });
type LogLine = z.infer<typeof logLine>;

const ENROLLED = 'enrolled contacts on their dates';
const SKIPPED = 'date triggers skipped firings too old';

/** Stops the worker before it, and starts one that runs no steps and keeps what it logs. */
async function restartWorker(): Promise<LogLine[]> {
  const log: LogLine[] = [];
  await worker?.stop();
  worker = await startWorker({
    connectionString: database.url('crm_worker'),
    services,
    tasks: [
      defineTask({
        name: 'automations.run_step',
        data: z.strictObject({ enrolmentId: z.uuid(), sequence: z.int().min(0) }),
        run: () => Promise.resolve(),
      }),
    ],
    logger: pino(
      { level: 'debug' },
      {
        write: (line: string) => {
          log.push(logLine.parse(JSON.parse(line)));
        },
      },
    ),
    shutdownTimeoutMs: 1000,
  });
  return log;
}

// As the schedule does each minute, without waiting for the minute. It goes in the
// schedule's own queue, so a sweep the schedule adds meanwhile runs before or after it.
const sweepNow = () =>
  database.as('crm_owner', (client) =>
    client.query('select graphile_worker.add_job($1, queue_name => $1)', [SCHEDULE_AUTOMATIONS]),
  );

/** Settles when every sweep asked for has run to its end. */
const sweepsDone = () =>
  expect
    .poll(
      () =>
        database.as('crm_owner', (client) =>
          client.query('select id from graphile_worker.jobs where task_identifier = $1', [
            SCHEDULE_AUTOMATIONS,
          ]),
        ),
      { timeout: 30_000 },
    )
    .toEqual([]);

/**
 * A business whose contacts hold a renewal date and time, with a published automation that
 * starts when it comes round. The worker has looked at it once, which starts its clock, and
 * is down since: the trigger was last swept `unswept` ago.
 */
async function renewalReminder(unswept: string) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const field = await database.withTenant(business.context, (client) =>
    client.one<{ id: string }>(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, description, value_type, created_by_kind)
       select app.business_id(), id, 'renewal_at', 'Renewal', 'When the plan renews.', 'datetime', 'system'
       from crm.object_types where kind = 'contact'
       returning id`,
    ),
  );
  /** A contact whose renewal came round that long ago. */
  const renewed = async (ago: string): Promise<string> => {
    const contact = await database.fixtures.contact(business.context);
    await database.withTenant(business.context, (client) =>
      client.query(
        `insert into crm.field_values
           (business_id, record_id, field_id, value_type, value_datetime, source_kind)
         values (app.business_id(), $1, $2, 'datetime', now() - $3::interval, 'system')`,
        [contact.id, field.id, ago],
      ),
    );
    return contact.id;
  };
  const document = automationDocument.parse({
    name: 'Renewal reminder',
    triggers: [
      {
        id: 'renewal',
        type: 'date.reached',
        config: { field: 'contact.custom.renewal_at', repeat: 'never' },
      },
    ],
    start: 'pause',
    steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
  });
  const automationId = await withTenant(db, business.context, async (trx) => {
    const { id } = await trx
      .insertInto('automation.automations')
      .values({
        business_id: business.id,
        name: document.name,
        draft: JSON.stringify(document),
        created_by_kind: 'system',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await publishAutomationVersion(trx, business.context, id, document, 'Published');
    return id;
  });
  const cursors = () =>
    database.withTenant(business.context, (client) =>
      client.query<{ trigger_id: string; recent: boolean }>(
        `select trigger_id, swept_through > now() - interval '5 minutes' as recent
         from automation.trigger_cursors where automation_id = $1`,
        [automationId],
      ),
    );
  // The first look starts the clock, and fires nothing behind it.
  await restartWorker();
  await sweepNow();
  await expect
    .poll(cursors, { timeout: 30_000 })
    .toEqual([{ trigger_id: 'renewal', recent: true }]);
  await worker?.stop();
  worker = undefined;
  await database.withTenant(business.context, (client) =>
    client.query(
      `update automation.trigger_cursors set swept_through = now() - $2::interval
       where automation_id = $1`,
      [automationId, unswept],
    ),
  );
  expect(await cursors()).toEqual([{ trigger_id: 'renewal', recent: false }]);
  const runs = () =>
    database.withTenant(business.context, (client) =>
      client.query<{ record_id: string; trigger_key: string | null; status: string }>(
        `select record_id, trigger_key, status from automation.enrolments
         where automation_id = $1 order by started_at, id`,
        [automationId],
      ),
    );
  const firings = () =>
    database.withTenant(business.context, (client) =>
      client.query<{ record_id: string }>(
        'select record_id from automation.trigger_firings where automation_id = $1',
        [automationId],
      ),
    );
  return { renewed, runs, firings, cursors };
}

it('enrols a contact whose date came round since the last sweep, once, and says how many', async () => {
  const reminder = await renewalReminder('1 hour');
  const due = await reminder.renewed('10 minutes');
  // Came round before the trigger was last swept: not this sweep's to fire.
  await reminder.renewed('3 hours');
  expect(await reminder.runs()).toEqual([]);

  const log = await restartWorker();
  await sweepNow();
  await sweepsDone();

  expect(await reminder.runs()).toEqual([
    { record_id: due, trigger_key: 'renewal', status: 'running' },
  ]);
  expect(await reminder.firings()).toEqual([{ record_id: due }]);
  expect(await reminder.cursors()).toEqual([{ trigger_id: 'renewal', recent: true }]);
  expect(log.filter((line) => line.msg === ENROLLED)).toMatchObject([{ level: 30, enrolled: 1 }]);
  // Swept within the day a firing may be late: nothing was skipped.
  expect(log.filter((line) => line.msg === SKIPPED)).toEqual([]);

  // The next sweep finds the firing done: nobody is enrolled twice, and nothing is said.
  await sweepNow();
  await sweepsDone();
  expect(await reminder.runs()).toHaveLength(1);
  expect(log.filter((line) => line.msg === ENROLLED)).toHaveLength(1);
});

it('warns that a date trigger left unswept for over a day skipped firings, and fires only the last day', async () => {
  const reminder = await renewalReminder('2 days');
  // Within the day a firing may be late, and beyond it.
  const caughtUp = await reminder.renewed('10 minutes');
  await reminder.renewed('36 hours');

  const log = await restartWorker();
  await sweepNow();
  await sweepsDone();

  expect(log.filter((line) => line.msg === SKIPPED)).toMatchObject([{ level: 40, triggers: 1 }]);
  expect(await reminder.runs()).toEqual([
    { record_id: caughtUp, trigger_key: 'renewal', status: 'running' },
  ]);
  expect(await reminder.firings()).toEqual([{ record_id: caughtUp }]);
  expect(log.filter((line) => line.msg === ENROLLED)).toMatchObject([{ level: 30, enrolled: 1 }]);

  // Swept through to now: the next sweep is on time, and does not warn again.
  expect(await reminder.cursors()).toEqual([{ trigger_id: 'renewal', recent: true }]);
  await sweepNow();
  await sweepsDone();
  expect(await reminder.runs()).toHaveLength(1);
  expect(log.filter((line) => line.msg === SKIPPED)).toHaveLength(1);
});
