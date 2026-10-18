// Migration 0055: folders for automations, the Deleted list's purge, the columns the
// enrollment history and execution logs read, and the statistics kept as counters. The
// upgrade case migrates a database up to the migration before it, stores runs as the engine
// stored them then, and lets the runner apply 0055 as it does on an upgrade. The rest runs
// on a database with every migration applied.
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPostgres, type Postgres } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapFile, migrate } from './index.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const WORKFLOWS = '0055_automation_workflows.sql';

let postgres: Postgres;
let earlier: string;
beforeAll(async () => {
  postgres = await startPostgres({ bootstrapFile });
  // The migrations an install had before this one.
  earlier = await mkdtemp(join(tmpdir(), 'crm-before-workflows-'));
  for (const name of await readdir(migrationsDirectory))
    if (name < WORKFLOWS) await cp(join(migrationsDirectory, name), join(earlier, name));
});
afterAll(async () => {
  await postgres.stop();
  await rm(earlier, { recursive: true, force: true });
});

type Query = <Row extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  values?: readonly unknown[],
) => Promise<Row[]>;

/** A connection as a role, closed when the work is done. */
async function connected<T>(
  connectionString: string,
  work: (query: Query) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const query: Query = async <Row extends pg.QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ) => (await client.query<Row>(text, [...values])).rows;
  try {
    return await work(query);
  } finally {
    await client.end();
  }
}

const document = {
  name: 'Follow-up',
  triggers: [
    { id: 'created', type: 'contact.created', config: {} },
    { id: 'tagged', type: 'tag.added', config: {} },
  ],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
};

interface Seeded {
  readonly business: string;
  readonly objectType: string;
  readonly automation: string;
  readonly version: string;
  contact(): Promise<string>;
}

let names = 0;

/** A business with a published automation, written as crm_owner: not held to a tenant. */
async function seed(query: Query): Promise<Seeded> {
  const one = async (text: string, values: readonly unknown[] = []): Promise<string> => {
    const [row] = await query<{ id: string }>(text, values);
    if (row === undefined) throw new Error(`No row: ${text}`);
    return row.id;
  };
  const slug = `workflows-${String(++names)}`;
  const agency = await one(
    'insert into tenancy.agencies (name, slug) values ($1, $1) returning id',
    [`agency-${slug}`],
  );
  const business = await one(
    'insert into tenancy.businesses (agency_id, name, slug) values ($1, $2, $2) returning id',
    [agency, slug],
  );
  const objectType = await one(
    `insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
     values ($1, 'contact', 'contact', 'Contact', 'Contacts') returning id`,
    [business],
  );
  const automation = await one(
    `insert into automation.automations (business_id, name, draft, created_by_kind)
     values ($1, 'Follow-up', $2::jsonb, 'user') returning id`,
    [business, JSON.stringify(document)],
  );
  const version = await one(
    `insert into automation.versions (business_id, automation_id, version, document, published_by_kind)
     values ($1, $2, 1, $3::jsonb, 'user') returning id`,
    [business, automation, JSON.stringify(document)],
  );
  await query(
    `update automation.automations set published_version_id = $2, status = 'active' where id = $1`,
    [automation, version],
  );
  return {
    business,
    objectType,
    automation,
    version,
    contact: () =>
      one(
        `with record as (
           insert into crm.records (business_id, kind, object_type_id)
           values ($1, 'contact', $2) returning id)
         insert into crm.contacts (business_id, id, first_name, created_by_kind)
         select $1, id, 'Maya', 'import' from record returning id`,
        [business, objectType],
      ),
  };
}

const differences = (query: Query) =>
  query(
    `select scope, key, metric, counted::int, actual::int
     from private.automation_stat_differences() order by scope, key, metric`,
  );

/** The counters of one automation as a reader adds them: both tables, in one statement. */
const counters = async (query: Query, automation: string): Promise<Record<string, number>> =>
  Object.fromEntries(
    (
      await query<{ name: string; n: number }>(
        `select scope || ':' || key || ':' || metric as name, sum(n)::int as n
         from (select scope, key, metric, n from automation.stat_counts where automation_id = $1
               union all
               select scope, key, metric, n from automation.stat_deltas where automation_id = $1) c
         group by 1 having sum(n) <> 0 order by 1`,
        [automation],
      )
    ).map((row) => [row.name, row.n]),
  );

it('puts right the step rows written before it, names each trigger, and starts the counters equal to the rows', async () => {
  const database = await postgres.createDatabase();
  const connectionString = postgres.url(database);
  const before = await migrate({ connectionString, directory: earlier });
  expect(before.applied).not.toContain(WORKFLOWS);

  await connected(connectionString, async (query) => {
    const s = await seed(query);
    /** A run as the engine stored one: its trigger inside state, and its steps in order. */
    const run = async (
      status: string,
      trigger: string | null,
      steps: readonly (readonly [key: string, type: string, status: string])[],
    ): Promise<string> => {
      const ended = ['completed', 'exited', 'failed', 'cancelled'].includes(status);
      const [enrolment] = await query<{ id: string }>(
        `insert into automation.enrolments
           (business_id, automation_id, version_id, record_id, reentry_key, status, state,
            correlation_id, started_at, finished_at)
         values ($1, $2, $3, $4, $4, $5, $6::jsonb, uuidv7(), now() - interval '50 minutes',
                 case when $7 then now() - interval '5 minutes' end)
         returning id`,
        [
          s.business,
          s.automation,
          s.version,
          await s.contact(),
          status,
          JSON.stringify(trigger === null ? { sequence: steps.length } : { triggerId: trigger }),
          ended,
        ],
      );
      if (enrolment === undefined) throw new Error('No enrolment.');
      // Every row was stamped finished as it was written, a waiting one included.
      for (const [position, [key, type, stepStatus]] of steps.entries())
        await query(
          `insert into automation.step_runs
             (business_id, enrolment_id, step_key, status, input, started_at, finished_at)
           values ($1, $2, $3, $4, $5::jsonb, now() - make_interval(mins => 40 - $6::int),
                   now() - make_interval(mins => 40 - $6::int))`,
          [s.business, enrolment.id, key, stepStatus, JSON.stringify({ type }), position],
        );
      return enrolment.id;
    };

    const finished = await run('completed', 'created', [
      ['check', 'condition', 'succeeded'],
      ['pause', 'wait', 'waiting'],
      ['done', 'tag.add', 'succeeded'],
    ]);
    const waiting = await run('waiting', 'created', [['pause', 'wait', 'waiting']]);
    const stopped = await run('exited', 'tagged', [['pause', 'wait', 'waiting']]);
    const cancelled = await run('cancelled', 'tagged', [['pause', 'wait', 'waiting']]);
    // The path ended at the wait, or the step after it was not in the version.
    const endedOnWait = await run('failed', null, [['pause', 'wait', 'waiting']]);
    const answered = await run('completed', 'created', [
      ['hear', 'wait.event', 'waiting'],
      ['hear', 'wait.event', 'succeeded'],
      ['call', 'webhook.call', 'waiting'],
      ['call', 'webhook.call', 'failed'],
    ]);
    // A wait that leads back to itself is visited again each time: no row continues another.
    const looping = await run('waiting', 'created', [
      ['again', 'wait', 'waiting'],
      ['again', 'wait', 'waiting'],
    ]);

    // What each run was last changed at, to see that the upgrade changes none of them.
    const touched = () =>
      query(
        `select md5(string_agg(id::text || updated_at::text, ',' order by id)) as stamp
         from automation.enrolments`,
      );
    const untouched = await touched();

    // The upgrade: the runner applies what is new, this migration among it.
    const upgrade = await migrate({ connectionString });
    expect(upgrade.applied).toContain(WORKFLOWS);

    const steps = async (enrolment: string) =>
      (
        await query<{
          step_key: string;
          status: string;
          resumes: boolean;
          finished: string;
          named: boolean;
        }>(
          `select s.step_key, s.status, s.resumes,
                  case when s.finished_at is null then 'no'
                       when s.finished_at = e.finished_at then 'with the run'
                       when s.finished_at = lead(s.started_at) over (order by s.started_at, s.id)
                         then 'as the next began'
                       else 'as written' end as finished,
                  s.automation_id = e.automation_id and s.version_id = e.version_id as named
           from automation.step_runs s
           join automation.enrolments e on e.id = s.enrolment_id
           where s.enrolment_id = $1 order by s.started_at, s.id`,
          [enrolment],
        )
      ).map((row) => [row.step_key, row.status, row.resumes, row.finished, row.named]);

    expect(await steps(finished)).toEqual([
      ['check', 'succeeded', false, 'as written', true],
      ['pause', 'succeeded', false, 'as the next began', true],
      ['done', 'succeeded', false, 'as written', true],
    ]);
    expect(await steps(waiting)).toEqual([['pause', 'waiting', false, 'no', true]]);
    expect(await steps(stopped)).toEqual([['pause', 'skipped', false, 'with the run', true]]);
    expect(await steps(cancelled)).toEqual([['pause', 'skipped', false, 'with the run', true]]);
    expect(await steps(endedOnWait)).toEqual([['pause', 'succeeded', false, 'with the run', true]]);
    expect(await steps(answered)).toEqual([
      ['hear', 'succeeded', false, 'as the next began', true],
      ['hear', 'succeeded', true, 'as written', true],
      ['call', 'succeeded', false, 'as the next began', true],
      ['call', 'failed', true, 'as written', true],
    ]);
    expect(await steps(looping)).toEqual([
      ['again', 'succeeded', false, 'as the next began', true],
      ['again', 'waiting', false, 'no', true],
    ]);

    expect(
      await query(
        `select trigger_key, count(*)::int as runs from automation.enrolments
         group by trigger_key order by trigger_key nulls last`,
      ),
    ).toEqual([
      { trigger_key: 'created', runs: 4 },
      { trigger_key: 'tagged', runs: 2 },
      { trigger_key: null, runs: 1 },
    ]);
    // Naming the trigger is not a change anybody made to a run.
    expect(await touched()).toEqual(untouched);

    // The counters hold exactly what the rows say, and nothing waits to be folded.
    expect(await differences(query)).toEqual([]);
    expect(await query('select count(*)::int as waiting from automation.stat_deltas')).toEqual([
      { waiting: 0 },
    ]);
    expect(await counters(query, s.automation)).toEqual({
      'run::cancelled': 1,
      'run::completed': 2,
      'run::enrolled': 7,
      'run::exited': 1,
      'run::failed': 1,
      'run::waiting': 2,
      'step:again:entered': 2,
      'step:again:succeeded': 1,
      'step:again:waiting': 1,
      'step:call:entered': 1,
      'step:call:failed': 1,
      'step:call:resumed': 1,
      'step:call:succeeded': 1,
      'step:check:entered': 1,
      'step:check:succeeded': 1,
      'step:done:entered': 1,
      'step:done:succeeded': 1,
      'step:hear:entered': 1,
      'step:hear:resumed': 1,
      'step:hear:succeeded': 2,
      'step:pause:entered': 5,
      'step:pause:skipped': 2,
      'step:pause:succeeded': 2,
      'step:pause:waiting': 1,
      'trigger:created:enrolled': 4,
      'trigger:tagged:enrolled': 2,
    });
    expect(
      await query(
        'select count(*)::int as filed from automation.automations where folder_id is not null',
      ),
    ).toEqual([{ filed: 0 }]);
  });
});

describe('with every migration applied', () => {
  let owner: string;
  let app: string;
  beforeAll(async () => {
    const database = await postgres.createDatabase();
    owner = postgres.url(database);
    app = postgres.url(database, 'crm_app');
    await migrate({ connectionString: owner });
  });

  const enrol = async (query: Query, s: Seeded, trigger: string | null = 'created') => {
    const [row] = await query<{ id: string }>(
      `insert into automation.enrolments
         (business_id, automation_id, version_id, record_id, reentry_key, trigger_key, correlation_id)
       values ($1, $2, $3, $4, $4, $5, uuidv7()) returning id`,
      [s.business, s.automation, s.version, await s.contact(), trigger],
    );
    if (row === undefined) throw new Error('No enrolment.');
    return row.id;
  };

  it('keeps the counters equal to the rows through every insert, change and delete, folded or not', async () => {
    await connected(owner, async (query) => {
      const s = await seed(query);
      const first = await enrol(query, s);
      const second = await enrol(query, s, 'tagged');
      const third = await enrol(query, s, null);
      expect(await differences(query)).toEqual([]);
      expect(await counters(query, s.automation)).toEqual({
        'run::enrolled': 3,
        'run::running': 3,
        'trigger:created:enrolled': 1,
        'trigger:tagged:enrolled': 1,
      });

      const step = (enrolment: string, key: string, status: string, resumes = false) =>
        query<{ id: string }>(
          `insert into automation.step_runs (business_id, enrolment_id, step_key, status, resumes)
           values ($1, $2, $3, $4, $5) returning id`,
          [s.business, enrolment, key, status, resumes],
        );
      const [waited] = await step(first, 'pause', 'waiting');
      await step(second, 'pause', 'waiting');
      await query(
        `update automation.enrolments set status = 'waiting' where id = any($1::uuid[])`,
        [[first, second]],
      );
      // Folding moves the rows into the counters and changes no total.
      const [{ folded } = { folded: 0 }] = await query<{ folded: number }>(
        'select private.compact_automation_stats(1000) as folded',
      );
      expect(folded).toBeGreaterThan(0);
      expect(
        await query(
          'select count(*)::int as left from automation.stat_deltas where automation_id = $1',
          [s.automation],
        ),
      ).toEqual([{ left: 0 }]);
      expect(await differences(query)).toEqual([]);

      // The first run goes on from its wait and fails at the next step; the second is stopped
      // in its wait; the third completes without a step.
      await query(
        `update automation.step_runs set status = 'succeeded', finished_at = now() where id = $1`,
        [waited?.id],
      );
      await step(first, 'send', 'waiting');
      await step(first, 'send', 'failed', true);
      await query(
        `update automation.step_runs set status = 'succeeded' where enrolment_id = $1 and step_key = 'send' and status = 'waiting'`,
        [first],
      );
      await query(
        `update automation.enrolments set status = 'failed', finished_at = now() where id = $1`,
        [first],
      );
      await query(
        `update automation.step_runs set status = 'skipped' where enrolment_id = $1 and status = 'waiting'`,
        [second],
      );
      await query(
        `update automation.enrolments set status = 'exited', finished_at = now() where id = $1`,
        [second],
      );
      await query(
        `update automation.enrolments set status = 'completed', finished_at = now() where id = $1`,
        [third],
      );
      expect(await differences(query)).toEqual([]);
      expect(await counters(query, s.automation)).toEqual({
        'run::completed': 1,
        'run::enrolled': 3,
        'run::exited': 1,
        'run::failed': 1,
        'step:pause:entered': 2,
        'step:pause:skipped': 1,
        'step:pause:succeeded': 1,
        'step:send:entered': 1,
        'step:send:failed': 1,
        'step:send:resumed': 1,
        'step:send:succeeded': 1,
        'trigger:created:enrolled': 1,
        'trigger:tagged:enrolled': 1,
      });

      // A record purged takes its run and its steps out of the counters, as out of the rows.
      await query(
        'delete from crm.records where id = (select record_id from automation.enrolments where id = $1)',
        [first],
      );
      expect(await differences(query)).toEqual([]);
      expect(await counters(query, s.automation)).toMatchObject({
        'run::enrolled': 2,
        'step:pause:entered': 1,
      });
      expect(await counters(query, s.automation)).not.toHaveProperty('step:send:entered');

      // The automation deleted for good takes its counters with it, folded and unfolded.
      await query('delete from automation.automations where id = $1', [s.automation]);
      expect(await counters(query, s.automation)).toEqual({});
      expect(await differences(query)).toEqual([]);
    });
  });

  it('names a step row after its own enrolment, whatever the writer says', async () => {
    await connected(owner, async (query) => {
      const s = await seed(query);
      const other = await seed(query);
      const enrolment = await enrol(query, s);
      const [row] = await query<{ automation_id: string; version_id: string }>(
        `insert into automation.step_runs
           (business_id, enrolment_id, step_key, status, automation_id, version_id)
         values ($1, $2, 'pause', 'succeeded', $3, $4) returning automation_id, version_id`,
        [s.business, enrolment, other.automation, other.version],
      );
      expect(row).toEqual({ automation_id: s.automation, version_id: s.version });
      await query(`update automation.step_runs set automation_id = $2 where enrolment_id = $1`, [
        enrolment,
        other.automation,
      ]);
      expect(
        await query('select automation_id from automation.step_runs where enrolment_id = $1', [
          enrolment,
        ]),
      ).toEqual([{ automation_id: s.automation }]);
    });
  });

  it('keeps one folder name per place, no folder in itself, and a deleted automation in no folder', async () => {
    await connected(owner, async (query) => {
      const s = await seed(query);
      const folder = async (name: string, parent: string | null = null) => {
        const [row] = await query<{ id: string }>(
          `insert into automation.folders (business_id, parent_id, name, created_by_kind)
           values ($1, $2, $3, 'user') returning id`,
          [s.business, parent, name],
        );
        if (row === undefined) throw new Error('No folder.');
        return row.id;
      };
      const leads = await folder('Leads');
      await expect(folder('LEADS')).rejects.toMatchObject({
        code: '23505',
        constraint: 'folders_sibling_name_idx',
      });
      await expect(folder(' Leads')).rejects.toMatchObject({
        code: '23514',
        constraint: 'folders_name_trimmed',
      });
      // The same name is free one level down, and taken there too once used.
      const inner = await folder('Leads', leads);
      await expect(folder('leads', leads)).rejects.toMatchObject({ code: '23505' });
      await expect(
        query('update automation.folders set parent_id = id where id = $1', [inner]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'folders_not_own_parent' });

      await query('update automation.automations set folder_id = $2 where id = $1', [
        s.automation,
        inner,
      ]);
      await expect(
        query(
          `update automation.automations set status = 'archived', archived_at = now() where id = $1`,
          [s.automation],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'automations_archived_unfiled' });
      // A folder removed without its command still loses nothing but itself.
      await query('delete from automation.folders where id = $1', [inner]);
      expect(
        await query('select folder_id from automation.automations where id = $1', [s.automation]),
      ).toEqual([{ folder_id: null }]);
    });
  });

  it('finds the businesses whose deleted automations are past their days, and no others', async () => {
    await connected(owner, async (query) => {
      const old = await seed(query);
      const recent = await seed(query);
      const live = await seed(query);
      const remove = (automation: string, days: number) =>
        query(
          `update automation.automations
           set status = 'archived', archived_at = now() - make_interval(days => $2) where id = $1`,
          [automation, days],
        );
      await remove(old.automation, 31);
      await remove(recent.automation, 29);
      const found = (
        await query<{ business_id: string }>(
          'select business_id from private.businesses_with_deleted_automations(30, 1000)',
        )
      ).map((row) => row.business_id);
      expect(found).toContain(old.business);
      expect(found).not.toContain(recent.business);
      expect(found).not.toContain(live.business);
    });
  });

  it('folds without waiting for an automation that is being deleted, and leaves its rows to the delete', async () => {
    await connected(owner, async (query) => {
      const s = await seed(query);
      const kept = await seed(query);
      await enrol(query, s);
      await enrol(query, kept);
      await connected(owner, async (other) => {
        // Someone holds the automation's row, as a delete of it does until it commits.
        await other('begin');
        await other('select 1 from automation.automations where id = $1 for update', [
          s.automation,
        ]);
        await query("set lock_timeout = '2s'");
        await query('select private.compact_automation_stats(1000)');
        const left = async (automation: string) =>
          (
            await query<{ left: number }>(
              'select count(*)::int as left from automation.stat_deltas where automation_id = $1',
              [automation],
            )
          )[0]?.left;
        expect(await left(s.automation)).toBeGreaterThan(0);
        expect(await left(kept.automation)).toBe(0);
        await other('rollback');
        await query('select private.compact_automation_stats(1000)');
        expect(await left(s.automation)).toBe(0);
        expect(await differences(query)).toEqual([]);
      });
    });
  });

  it("lets the application read a business's statistics and write none of them", async () => {
    const s = await connected(owner, async (query) => {
      const seeded = await seed(query);
      await enrol(query, seeded);
      const [business] = await query<{ agency_id: string }>(
        'select agency_id from tenancy.businesses where id = $1',
        [seeded.business],
      );
      return { ...seeded, agency: business?.agency_id ?? '' };
    });
    await connected(app, async (query) => {
      await query('begin');
      await query(
        `select set_config('app.agency_id', $1, true), set_config('app.business_id', $2, true)`,
        [s.agency, s.business],
      );
      expect(await query('select metric, n from automation.stat_deltas order by metric')).toEqual([
        { metric: 'enrolled', n: 1 },
        { metric: 'enrolled', n: 1 },
        { metric: 'running', n: 1 },
      ]);
      await query('savepoint attempt');
      await expect(
        query(
          `insert into automation.stat_deltas (business_id, version_id, automation_id, scope, key, metric, n)
           values ($1, $2, $3, 'run', '', 'enrolled', 100)`,
          [s.business, s.version, s.automation],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await query('rollback to savepoint attempt');
      await expect(query('delete from automation.stat_deltas')).rejects.toMatchObject({
        code: '42501',
      });
      await query('rollback to savepoint attempt');
      await expect(query('update automation.stat_counts set n = 0')).rejects.toMatchObject({
        code: '42501',
      });
      await query('rollback to savepoint attempt');
      // Reconciling crosses businesses and names step keys: not the application's to run.
      await expect(
        query('select * from private.automation_stat_differences()'),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await query('rollback');
    });
  });
});
