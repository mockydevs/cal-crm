// Migration 0041 over a database that already has finished test runs: the migration file
// itself is run after such a run exists. The old run keeps no outcome, since none was ever
// stored, and still reads through the API; runs finished afterwards must keep theirs.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { readTestRun } from './test-runs.js';

const MIGRATION = fileURLToPath(
  new URL('../../../db/migrations/0041_automation_test_outcome.sql', import.meta.url),
);

let database: TestDatabase;
let db: Database;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

it('leaves a run finished before the migration without an outcome, and readable', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  const trace = [
    {
      step: 'tag',
      type: 'tag.add',
      kind: 'would_change',
      at: '2026-10-01T09:00:00.000Z',
      explanation: 'The tag would be added.',
    },
  ];

  // Back to the schema before 0041, then a finished run as one was stored then.
  const ids = await database.as('postgres', async (sql) => {
    await sql.query(
      'alter table automation.test_runs drop constraint test_runs_finished_have_outcome',
    );
    await sql.query('alter table automation.test_runs drop column outcome');
    const [automation] = await sql.query<{ id: string }>(
      `insert into automation.automations (business_id, name, draft, created_by_kind)
       values ($1, 'Welcome', '{"name": "Welcome"}', 'user') returning id`,
      [business.id],
    );
    const [run] = await sql.query<{ id: string }>(
      `insert into automation.test_runs
         (business_id, automation_id, draft_revision, status, trace, created_by_kind, finished_at)
       values ($1, $2, 1, 'passed', $3::jsonb, 'user', now()) returning id`,
      [business.id, automation?.id, JSON.stringify(trace)],
    );
    // The migration exactly as it ships.
    await sql.query(await readFile(MIGRATION, 'utf8'));
    return { automation: automation?.id ?? '', run: run?.id ?? '' };
  });

  const stored = await database.as('postgres', (sql) =>
    sql.query<{ status: string; outcome: unknown }>(
      'select status, outcome from automation.test_runs where id = $1',
      [ids.run],
    ),
  );
  expect(stored).toEqual([{ status: 'passed', outcome: null }]);

  const read = await withTenant(db, context, (trx) =>
    readTestRun(
      trx,
      toPublicId('automation', ids.automation),
      toPublicId('automation_test_run', ids.run),
    ),
  );
  expect(read).toMatchObject({ status: 'passed', outcome: null, steps: trace, draftVersion: 1 });

  // The rule holds for every run finished from now on, and for a change to the old one.
  const finish = (outcome: string | null) =>
    database.withTenant(context, (sql) =>
      sql.query(
        `insert into automation.test_runs
           (business_id, automation_id, draft_revision, status, outcome, created_by_kind)
         values (app.business_id(), $1, 1, 'failed', $2::jsonb, 'user')`,
        [ids.automation, outcome],
      ),
    );
  await expect(finish(null)).rejects.toMatchObject({
    code: '23514',
    constraint: 'test_runs_finished_have_outcome',
  });
  await finish('{"kind":"limit","steps":200}');
  await expect(
    database.as('postgres', (sql) =>
      sql.query("update automation.test_runs set status = 'failed' where id = $1", [ids.run]),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
