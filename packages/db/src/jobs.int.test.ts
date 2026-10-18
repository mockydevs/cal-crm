// The job queue's database side: Graphile Worker's schema, the worker's role (crm_worker),
// and private.enqueue_job, which crm_app adds jobs with.
import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type ReceivedJob, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

let database: TestDatabase;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});

afterAll(async () => {
  await database.close();
});

async function inBusiness(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return { ...business.context, correlationId: randomUUID() };
}

const enqueue = (sql: Sql, task: string, data: unknown) =>
  sql.one<{ id: string }>('select private.enqueue_job($1, $2) as id', [task, JSON.stringify(data)]);

/** The jobs a context added, as the worker received them. */
async function jobsOf(context: TenantContext, tasks: readonly string[]): Promise<ReceivedJob[]> {
  return (await database.runJobs(tasks)).filter(
    ({ payload }) =>
      typeof payload === 'object' &&
      payload !== null &&
      'correlationId' in payload &&
      payload.correlationId === context.correlationId,
  );
}

describe('private.enqueue_job', () => {
  it('adds a job that carries the context of the transaction that added it', async () => {
    const context = await inBusiness();

    await database.withTenant(context, (sql) => enqueue(sql, 'tag.created', { tagId: 'tag_1' }));

    expect(await jobsOf(context, ['tag.created'])).toEqual([
      {
        task: 'tag.created',
        payload: {
          agencyId: context.agencyId,
          businessId: context.businessId,
          correlationId: context.correlationId,
          causationId: null,
          data: { tagId: 'tag_1' },
        },
      },
    ]);
  });

  it('carries the event behind the job, for the worker to pass on (0020)', async () => {
    const context = await inBusiness();
    const cause = randomUUID();

    await database.withTenant(context, (sql) =>
      sql.one('select private.enqueue_job($1, $2, $3) as id', [
        'tag.created',
        JSON.stringify({ tagId: 'tag_2' }),
        cause,
      ]),
    );

    expect(await jobsOf(context, ['tag.created'])).toMatchObject([
      { payload: { causationId: cause, data: { tagId: 'tag_2' } } },
    ]);
  });

  it('adds nothing when the transaction rolls back', async () => {
    const context = await inBusiness();

    const rolledBack = database.withTenant(context, async (sql) => {
      await enqueue(sql, 'tag.created', { tagId: 'tag_1' });
      throw new Error('the work failed');
    });

    await expect(rolledBack).rejects.toThrow('the work failed');
    expect(await jobsOf(context, ['tag.created'])).toEqual([]);
  });

  it('adds agency-level work with no business', async () => {
    const { businessId: _none, ...agencyStaff } = await inBusiness();

    await database.withTenant(agencyStaff, (sql) => enqueue(sql, 'agency.report', {}));

    expect(await jobsOf(agencyStaff, ['agency.report'])).toEqual([
      {
        task: 'agency.report',
        payload: {
          agencyId: agencyStaff.agencyId,
          businessId: null,
          correlationId: agencyStaff.correlationId,
          causationId: null,
          data: {},
        },
      },
    ]);
  });

  it('refuses a job without a tenant context', async () => {
    await expect(database.as('crm_app', (sql) => enqueue(sql, 'tag.created', {}))).rejects.toThrow(
      'a job needs a tenant context',
    );
  });

  it('refuses a task name that is not two or more dotted parts', async () => {
    const context = await inBusiness();

    for (const task of ['tag', 'Tag.created', 'tag..created', 'tag.created.', 'tag.created2']) {
      await expect(
        database.withTenant(context, (sql) => enqueue(sql, task, {})),
        task,
      ).rejects.toThrow(`"${task}" isn't a task name`);
    }
  });
});

describe('the queue', () => {
  it('is reached by crm_app only through private.enqueue_job', async () => {
    for (const statement of [
      'select count(*) from graphile_worker.jobs',
      "select graphile_worker.add_job('tag.created')",
    ]) {
      await expect(
        database.as('crm_app', (sql) => sql.query(statement)),
        statement,
      ).rejects.toThrow('permission denied for schema graphile_worker');
    }
  });

  it('is worked by crm_worker, which removes a job once it has run', async () => {
    const context = await inBusiness();
    const { id } = await database.withTenant(context, (sql) => enqueue(sql, 'tag.created', {}));

    expect(await jobsOf(context, ['tag.created'])).toHaveLength(1);

    const left = await database.as('crm_owner', (sql) =>
      sql.one<{ jobs: number }>(
        'select count(*)::int as jobs from graphile_worker.jobs where id = $1',
        [id],
      ),
    );
    expect(left).toEqual({ jobs: 0 });
  });

  it('gives crm_worker nothing outside the queue', async () => {
    await expect(
      database.as('crm_worker', (sql) => sql.query('select count(*) from crm.tags')),
    ).rejects.toThrow('permission denied for schema crm');
  });
});
