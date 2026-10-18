import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type JobRun, type Services } from '@repo/commands';
import { tag } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { crmRoutes, crmTasks } from '../index.js';
import { countTagsCreated, TAGS_CREATED } from './counts.js';

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

interface Business {
  readonly id: string;
  /** A person in the business, as the API runs commands. */
  readonly person: Invocation;
  /** The system in the business, as the worker runs a job. */
  readonly job: JobRun;
}

async function business(timezone = 'UTC'): Promise<Business> {
  const agency = await database.fixtures.agency();
  const { id, context } = await database.fixtures.business(agency.id);
  await database.as('crm_owner', (sql) =>
    sql.query('update tenancy.businesses set timezone = $1 where id = $2', [timezone, id]),
  );
  const user = await database.fixtures.user();
  const correlationId = randomUUID();
  return {
    id,
    person: {
      context: { ...context, userId: user.id, actorKind: 'user', actorId: user.id, correlationId },
      permissions: 'all',
    },
    job: {
      invocation: {
        context: { ...context, actorKind: 'system', correlationId },
        permissions: 'all',
      },
      services,
    },
  };
}

/** Creates a tag through the API's route, and returns its id. */
async function createTag(invocation: Invocation, name: string): Promise<string> {
  const route = crmRoutes.find((each) => each.endpoint.operationId === 'createTag');
  if (route === undefined) throw new Error('No createTag route.');
  const created = tag.parse(
    await route.run({ invocation, params: {}, query: {}, body: { name } }, services),
  );
  const id = parsePublicId('tag', created.id);
  if (id === undefined) throw new Error(`Not a tag id: ${created.id}`);
  return id;
}

/** The business's daily counts of tags created, oldest first. */
function counts(businessId: string): Promise<{ day: string; value: number }[]> {
  return database.as('crm_owner', (sql) =>
    sql.query<{ day: string; value: number }>(
      `select day::text, value::int from reporting.daily_metrics
       where business_id = $1 and metric = $2 order by day`,
      [businessId, TAGS_CREATED],
    ),
  );
}

/** The day a tag was created on, in its business's time zone. */
async function dayOf(tagId: string): Promise<string> {
  const { day } = await database.as('crm_owner', (sql) =>
    sql.one<{ day: string }>(
      `select (e.occurred_at at time zone b.timezone)::date::text as day
       from events.events e join tenancy.businesses b on b.id = e.business_id
       where e.subject_id = $1`,
      [tagId],
    ),
  );
  return day;
}

describe('tags.count_created', () => {
  it('is queued with each new tag, in the business that made it', async () => {
    const ours = await business();
    const tagId = await createTag(ours.person, 'Wedding');
    const event = await database.as('crm_owner', (sql) =>
      sql.one<{ id: string }>(
        "select id from events.events where business_id = $1 and subject_id = $2 and type = 'tag.created'",
        [ours.id, tagId],
      ),
    );

    const jobs = await database.runJobs([countTagsCreated.name]);

    expect(jobs.filter((job) => JSON.stringify(job.payload).includes(ours.id))).toEqual([
      {
        task: 'tags.count_created',
        payload: {
          agencyId: ours.person.context.agencyId,
          businessId: ours.id,
          correlationId: ours.person.context.correlationId,
          causationId: event.id,
          data: { tagId },
        },
      },
    ]);
    expect(crmTasks).toContain(countTagsCreated);
  });

  it("counts the day's new tags, and running again changes nothing", async () => {
    const ours = await business();
    const first = await createTag(ours.person, 'Wedding');
    const second = await createTag(ours.person, 'Corporate');

    await countTagsCreated.run({ tagId: first }, ours.job);
    const once = await counts(ours.id);
    await countTagsCreated.run({ tagId: first }, ours.job);
    await countTagsCreated.run({ tagId: second }, ours.job);

    expect(once).toEqual([{ day: await dayOf(first), value: 2 }]);
    expect(await counts(ours.id)).toEqual(once);
  });

  it("counts by the business's own day, not UTC's", async () => {
    const ours = await business('America/New_York');
    // Half an hour either side of the latest midnight in New York.
    const tagIds = await database.as('crm_owner', (sql) =>
      sql.query<{ subject_id: string }>(
        `with midnight as (
           select date_trunc('day', now() at time zone 'America/New_York') as local
         )
         insert into events.events
           (agency_id, business_id, recorded_at, occurred_at, type, actor_kind, correlation_id,
            subject_kind, subject_id)
         select b.agency_id, b.id, at, at, 'tag.created', 'user', gen_random_uuid(), 'tag',
                gen_random_uuid()
         from tenancy.businesses b, midnight,
              unnest(array[(local - interval '30 minutes') at time zone 'America/New_York',
                           (local + interval '30 minutes') at time zone 'America/New_York'])
                with ordinality as instant (at, position)
         where b.id = $1
         order by position
         returning subject_id`,
        [ours.id],
      ),
    );
    const [before, after] = tagIds.map((row) => row.subject_id);
    if (before === undefined || after === undefined) throw new Error('Expected two events.');

    await countTagsCreated.run({ tagId: before }, ours.job);
    await countTagsCreated.run({ tagId: after }, ours.job);

    const yesterday = await dayOf(before);
    const today = await dayOf(after);
    expect(yesterday < today).toBe(true);
    expect(await counts(ours.id)).toEqual([
      { day: yesterday, value: 1 },
      { day: today, value: 1 },
    ]);
  });

  it('keeps the higher count when a job that counted earlier writes last', async () => {
    // Two count jobs for one day at once, as two workers can run them: job A counts before
    // tag B commits, then waits on the day's row while job B, which counted both, writes it.
    const ours = await business();
    const first = await createTag(ours.person, 'Wedding');
    await countTagsCreated.run({ tagId: first }, ours.job);

    // Job B holds the day's row, as a job does between its count and its commit.
    const holding = Promise.withResolvers<number>();
    const finishB = Promise.withResolvers<undefined>();
    const jobB = database.as('crm_owner', async (sql) => {
      const { pid } = await sql.one<{ pid: number }>(
        `select pg_backend_pid() as pid from reporting.daily_metrics
         where business_id = $1 and metric = $2 for update`,
        [ours.id, TAGS_CREATED],
      );
      holding.resolve(pid);
      await finishB.promise;
      await sql.query(
        'update reporting.daily_metrics set value = 2 where business_id = $1 and metric = $2',
        [ours.id, TAGS_CREATED],
      );
    });
    const jobBPid = await holding.promise;

    // Job A counts one tag, then waits for job B's row.
    const jobA = countTagsCreated.run({ tagId: first }, ours.job);
    for (let waiting = false; !waiting;) {
      const blocked = await database.as('postgres', (sql) =>
        sql.query('select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))', [
          jobBPid,
        ]),
      );
      waiting = blocked.length > 0;
    }
    // Tag B commits while job A waits, and job B writes the count of both.
    await createTag(ours.person, 'Corporate');
    finishB.resolve(undefined);
    await jobB;
    await jobA;

    expect(await counts(ours.id)).toEqual([{ day: await dayOf(first), value: 2 }]);
  });

  it("never counts another business's tags", async () => {
    const ours = await business();
    const theirs = await business();
    const tagId = await createTag(ours.person, 'Wedding');
    await createTag(theirs.person, 'Wedding');
    await createTag(theirs.person, 'Corporate');

    await countTagsCreated.run({ tagId }, ours.job);

    expect(await counts(ours.id)).toEqual([{ day: await dayOf(tagId), value: 1 }]);
    expect(await counts(theirs.id)).toEqual([]);
  });

  it('counts nothing for a tag with no tag.created event', async () => {
    const ours = await business();

    await countTagsCreated.run({ tagId: randomUUID() }, ours.job);

    expect(await counts(ours.id)).toEqual([]);
  });
});
