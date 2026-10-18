// Migration 0041: a finished test run keeps its outcome, and runs finished before the
// migration keep none rather than a guessed one.
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

const run = (sql: Sql, status: string, outcome: string | null) =>
  sql.query(
    `with automation as (
       insert into automation.automations (business_id, name, draft, created_by_kind)
       values (app.business_id(), 'Welcome', '{}', 'user') returning id)
     insert into automation.test_runs
       (business_id, automation_id, draft_revision, status, outcome, created_by_kind)
     select app.business_id(), id, 1, $1, $2::jsonb, 'user' from automation`,
    [status, outcome],
  );

it('keeps the outcome of every finished run, and needs none while a run is running', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const tenant = <T>(work: (sql: Sql) => Promise<T>) => database.withTenant(business.context, work);
  await tenant((sql) => run(sql, 'running', null));
  await tenant((sql) => run(sql, 'passed', '{"kind":"completed"}'));
  await tenant((sql) => run(sql, 'failed', '{"kind":"failed","step":"a","error":"x"}'));
  for (const status of ['passed', 'failed'])
    await expect(tenant((sql) => run(sql, status, null))).rejects.toMatchObject({
      code: '23514',
      constraint: 'test_runs_finished_have_outcome',
    });
  await expect(tenant((sql) => run(sql, 'passed', '["completed"]'))).rejects.toMatchObject({
    code: '23514',
    constraint: 'test_runs_outcome_object',
  });
});

it('does not apply the rule to runs finished before it, so none gets an invented outcome', async () => {
  const [constraint] = await database.as('crm_owner', (sql) =>
    sql.query<{ convalidated: boolean }>(
      "select convalidated from pg_constraint where conname = 'test_runs_finished_have_outcome'",
    ),
  );
  expect(constraint).toEqual({ convalidated: false });
});
