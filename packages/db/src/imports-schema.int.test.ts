// Migration 0054 (imports) at the database's own level: what it adds to imports.jobs, the
// new imports.job_rows, their grants and policies, the rules an import's record keeps
// whatever the code does, the sweep's lookup, and what it does to an import an install
// already had. What the module does with these tables is the CRM package's to prove
// (packages/modules/crm/src/imports).
import { randomBytes, randomUUID } from 'node:crypto';
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

const TABLES = ['imports.job_rows', 'imports.jobs'];
const IMPORTS = '0054_imports.sql';
const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

async function business() {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...created.context, correlationId: randomUUID() };
  return { agency, business: created, context };
}

/** A stored file of the context's business, or of its agency alone. */
const file = (sql: Sql, shared = false): Promise<{ id: string }> =>
  sql.one<{ id: string }>(
    `insert into files.files (agency_id, business_id, storage, storage_key, filename,
                              content_type, size_bytes, sha256, uploaded_by_kind)
     values (app.agency_id(), case when $1 then null else app.business_id() end, 'local',
             uuidv7()::text, 'contacts.csv', 'text/csv', 10, $2, 'user')
     returning id`,
    [shared, randomBytes(32)],
  );

/** An import waiting for the worker, as starting one stores it. */
const waiting = (sql: Sql, values: { rows?: number; fileId?: string | null } = {}) =>
  sql.one<{ id: string }>(
    `insert into imports.jobs (business_id, source, objects, created_by_kind, file_id, file_name,
                               row_count, heartbeat_at)
     values (app.business_id(), 'csv', '{contact}', 'user', $1, 'contacts.csv', $2, now())
     returning id`,
    [values.fileId ?? null, values.rows ?? 3],
  );

const change = (sql: Sql, id: string, set: string, values: readonly unknown[] = []) =>
  sql.query(`update imports.jobs set ${set} where id = $1 returning id`, [id, ...values]);

const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};

/** A contact of the context's business, by its record id. */
const contact = async (context: TenantContext): Promise<string> =>
  (await database.fixtures.contact(context)).id;

describe('the tables', () => {
  it('have forced row-level security and the tenant policy alone', async () => {
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; enabled: boolean; forced: boolean; policies: string[] }>(
        `select c.oid::regclass::text as name, c.relrowsecurity as enabled,
                c.relforcerowsecurity as forced,
                array(select format('%s %s %s', p.policyname, p.permissive, p.cmd)
                      from pg_policies p
                      where p.schemaname = n.nspname and p.tablename = c.relname
                      order by 1) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.oid = any($1::regclass[]) order by 1`,
        [TABLES],
      ),
    );
    expect(rows).toEqual(
      TABLES.map((name) => ({
        name,
        enabled: true,
        forced: true,
        policies: ['tenant_isolation PERMISSIVE ALL'],
      })),
    );
  });

  it('grant crm_app what it uses and nothing to the other runtime roles', async () => {
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ table_name: string; grantee: string; privileges: string[] }>(
        `select table_name::text, grantee::text,
                array_agg(privilege_type::text order by privilege_type) as privileges
         from information_schema.role_table_grants
         where table_schema = 'imports'
           and grantee in ('crm_app', 'crm_auth', 'crm_worker', 'PUBLIC')
         group by 1, 2 order by 1, 2`,
      ),
    );
    expect(grants).toEqual([
      { table_name: 'id_map', grantee: 'crm_app', privileges: ['INSERT', 'SELECT', 'UPDATE'] },
      // No UPDATE and no DELETE: what became of a row is recorded once.
      { table_name: 'job_rows', grantee: 'crm_app', privileges: ['INSERT', 'SELECT'] },
      // No DELETE: the history of imports stays.
      { table_name: 'jobs', grantee: 'crm_app', privileges: ['INSERT', 'SELECT', 'UPDATE'] },
    ]);
  });

  it('read as empty with no tenant context', async () => {
    const { context } = await business();
    const record = await contact(context);
    await database.withTenant(context, async (sql) => {
      const job = await waiting(sql);
      await sql.query(
        `insert into imports.job_rows (business_id, job_id, row_number, outcome, record_id)
         values (app.business_id(), $1, 2, 'created', $2)`,
        [job.id, record],
      );
    });
    for (const table of TABLES)
      expect(await database.as('crm_app', (sql) => sql.query(`select 1 from ${table}`))).toEqual(
        [],
      );
  });
});

describe('isolation between businesses', () => {
  it("hides one business's imports and their rows from another, and refuses writes across", async () => {
    const mine = await business();
    const theirs = await business();
    const record = await contact(mine.context);
    const job = await database.withTenant(mine.context, async (sql) => {
      const made = await waiting(sql);
      await sql.query(
        `insert into imports.job_rows (business_id, job_id, row_number, outcome, record_id)
         values (app.business_id(), $1, 2, 'created', $2)`,
        [made.id, record],
      );
      return made;
    });
    await database.withTenant(theirs.context, async (sql) => {
      expect(await sql.query('select 1 from imports.jobs')).toEqual([]);
      expect(await sql.query('select 1 from imports.job_rows')).toEqual([]);
      expect(await change(sql, job.id, 'cancel_requested_at = now()')).toEqual([]);
    });
    // A row for another business's import has no import to belong to.
    await refused(
      database.withTenant(theirs.context, (sql) =>
        sql.query(
          `insert into imports.job_rows (business_id, job_id, row_number, outcome, code, detail)
           values (app.business_id(), $1, 3, 'failed', 'invalid', 'Reached from another business.')`,
          [job.id],
        ),
      ),
      'job_rows_business_id_job_id_fkey',
    );
    await expect(
      database.withTenant(theirs.context, (sql) =>
        sql.query(
          `insert into imports.job_rows (business_id, job_id, row_number, outcome, code, detail)
           values ($1, $2, 3, 'failed', 'invalid', 'Reached from another business.')`,
          [mine.business.id, job.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await database.withTenant(mine.context, async (sql) => {
      expect(await sql.query('select 1 from imports.jobs')).toHaveLength(1);
      expect(await sql.query('select 1 from imports.job_rows')).toHaveLength(1);
    });
  });
});

describe('an import', () => {
  it('waits or runs one at a time in a business, and another may start once it has ended', async () => {
    const { context } = await business();
    const other = await business();
    const first = await database.withTenant(context, (sql) => waiting(sql));
    await refused(
      database.withTenant(context, (sql) => waiting(sql)),
      'jobs_one_active_idx',
    );
    // Another business is not held up by it.
    await database.withTenant(other.context, (sql) => waiting(sql));
    await database.withTenant(context, (sql) =>
      change(sql, first.id, "status = 'running', started_at = now()"),
    );
    await refused(
      database.withTenant(context, (sql) => waiting(sql)),
      'jobs_one_active_idx',
    );
    await database.withTenant(context, (sql) =>
      change(sql, first.id, "status = 'completed', finished_at = now()"),
    );
    await database.withTenant(context, (sql) => waiting(sql));
  });

  it('keeps its file to its own business, and outlives the file with the name it had', async () => {
    const mine = await business();
    const theirs = await business();
    const own = await database.withTenant(mine.context, (sql) => file(sql));
    const foreign = await database.withTenant(theirs.context, (sql) => file(sql));
    const shared = await database.withTenant(mine.context, (sql) => file(sql, true));
    for (const fileId of [foreign.id, shared.id])
      await refused(
        database.withTenant(mine.context, (sql) => waiting(sql, { fileId })),
        'jobs_file_fkey',
      );
    const job = await database.withTenant(mine.context, (sql) => waiting(sql, { fileId: own.id }));
    await database.withTenant(mine.context, (sql) =>
      change(
        sql,
        job.id,
        "status = 'failed', error_code = 'file_unreadable', finished_at = now(), error_file_id = $2",
        [own.id],
      ),
    );
    await database.as('crm_owner', (sql) =>
      sql.query('delete from files.files where id = $1', [own.id]),
    );
    expect(
      await database.withTenant(mine.context, (sql) =>
        sql.query('select file_id, error_file_id, file_name, status from imports.jobs'),
      ),
    ).toEqual([
      { file_id: null, error_file_id: null, file_name: 'contacts.csv', status: 'failed' },
    ]);
  });

  it('says what it reads, names a CSV file, and keeps its documents bounded', async () => {
    const { context } = await business();
    const insert = (columns: string, values: string, parameters: readonly unknown[] = []) =>
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into imports.jobs (business_id, source, heartbeat_at${columns})
           values (app.business_id(), 'csv', now()${values})`,
          parameters,
        ),
      );
    await refused(insert('', ''), 'jobs_csv_names_its_file');
    await refused(insert(', file_name', ", ''"), 'jobs_file_name_length');
    await refused(insert(', file_name', ', $1', ['x'.repeat(256)]), 'jobs_file_name_length');
    await refused(insert(', file_name, objects', ", 'a.csv', '{}'"), 'jobs_objects_valid');
    await refused(insert(', file_name, objects', ", 'a.csv', '{invoice}'"), 'jobs_objects_valid');
    await refused(
      insert(', file_name, created_by_kind', ", 'a.csv', 'robot'"),
      'jobs_created_by_kind_valid',
    );
    await refused(insert(', file_name, mapping', ", 'a.csv', '{}'"), 'jobs_mapping_array');
    await refused(
      insert(', file_name, mapping', ", 'a.csv', $1", [JSON.stringify(['x'.repeat(131_072)])]),
      'jobs_mapping_bounded',
    );
    await refused(
      insert(', file_name, settings', ", 'a.csv', $1", [JSON.stringify({ x: 'x'.repeat(16_384) })]),
      'jobs_settings_bounded',
    );
    await refused(
      insert(', file_name, error', ", 'a.csv', $1", ['x'.repeat(2001)]),
      'jobs_error_length',
    );
    await insert(
      ', file_name, objects, mapping',
      ", 'a.csv', '{contact,deal}', '[{\"column\": 0}]'",
    );
  });

  it('gives every row it has dealt with exactly one outcome, within the rows it found', async () => {
    const { context } = await business();
    const job = await database.withTenant(context, (sql) => waiting(sql, { rows: 3 }));
    const set = (counts: string) =>
      database.withTenant(context, (sql) => change(sql, job.id, counts));
    await refused(set('processed_count = 1'), 'jobs_counts_add_up');
    await refused(set('created_count = 1'), 'jobs_counts_add_up');
    await refused(set('row_count = -1'), 'jobs_counts_nonnegative');
    // A count below zero can only be written with the row: the guard stops one going down.
    const other = await business();
    await refused(
      database.withTenant(other.context, (sql) =>
        sql.query(
          `insert into imports.jobs (business_id, source, file_name, heartbeat_at, row_count,
                                     processed_count, failed_count)
           values (app.business_id(), 'csv', 'a.csv', now(), 3, -1, -1)`,
        ),
      ),
      'jobs_counts_nonnegative',
    );
    await refused(
      set(
        'processed_count = 4, created_count = 1, updated_count = 1, skipped_count = 1, failed_count = 1',
      ),
      'jobs_processed_within_rows',
    );
    await set('processed_count = 3, created_count = 1, updated_count = 1, failed_count = 1');
  });

  it('has the times and the failure its status calls for', async () => {
    const { context } = await business();
    const job = await database.withTenant(context, (sql) => waiting(sql));
    const set = (changes: string) =>
      database.withTenant(context, (sql) => change(sql, job.id, changes));
    await refused(set('heartbeat_at = null'), 'jobs_active_has_heartbeat');
    await refused(set("status = 'running'"), 'jobs_started_when_run');
    await refused(set('finished_at = now()'), 'jobs_finished_when_done');
    await refused(set("status = 'cancelled'"), 'jobs_finished_when_done');
    await refused(set("error_code = 'file_unreadable'"), 'jobs_failure_is_named');
    await refused(set("status = 'failed', finished_at = now()"), 'jobs_failure_is_named');
    await refused(
      set("status = 'failed', finished_at = now(), error_code = 'Not A Code'"),
      'jobs_error_code_format',
    );
    await set("status = 'running', started_at = now()");
    await refused(set("status = 'completed'"), 'jobs_finished_when_done');
    await set("status = 'completed', finished_at = now(), heartbeat_at = null");
  });

  it('only moves forward: waiting to running, and either to an end', async () => {
    const { context } = await business();
    const start = async (through: readonly string[]) => {
      const job = await database.withTenant(context, (sql) => waiting(sql));
      for (const step of through)
        await database.withTenant(context, (sql) => change(sql, job.id, step));
      return (changes: string) =>
        database.withTenant(context, (sql) => change(sql, job.id, changes));
    };
    const running = "status = 'running', started_at = now()";
    const ended = (status: string) =>
      `status = '${status}', finished_at = now()${status === 'failed' ? ", error_code = 'internal'" : ''}`;

    const fromWaiting = await start([]);
    await refused(fromWaiting(`${ended('completed')}, started_at = now()`), 'jobs_status_forward');
    await fromWaiting(ended('cancelled'));

    const fromRunning = await start([running]);
    await refused(fromRunning("status = 'pending'"), 'jobs_status_forward');
    await fromRunning(ended('failed'));

    for (const last of ['completed', 'failed', 'cancelled']) {
      const finished = await start([running, ended(last)]);
      for (const next of ['pending', 'running', 'completed', 'failed', 'cancelled'])
        if (next !== last)
          await refused(
            finished(
              next === 'pending' || next === 'running'
                ? `status = '${next}', finished_at = null, error_code = null`
                : `${ended(next)}${next === 'failed' ? '' : ', error_code = null'}`,
            ),
            'jobs_finished_fixed',
          );
    }
  });

  it('never counts backwards, and never changes what it was started with', async () => {
    const { context } = await business();
    const own = await database.withTenant(context, (sql) => file(sql));
    const another = await database.withTenant(context, (sql) => file(sql));
    const job = await database.withTenant(context, (sql) => waiting(sql, { fileId: own.id }));
    const set = (changes: string, values: readonly unknown[] = []) =>
      database.withTenant(context, (sql) => change(sql, job.id, changes, values));
    await set("status = 'running', started_at = now()");
    await set('processed_count = 2, created_count = 1, failed_count = 1');
    for (const backwards of [
      'processed_count = 1, created_count = 1, failed_count = 0',
      'processed_count = 2, created_count = 0, failed_count = 1, updated_count = 1',
      'processed_count = 2, created_count = 2, failed_count = 0',
    ])
      await refused(set(backwards), 'jobs_counts_forward');
    for (const [changes, values] of [
      ["source = 'ghl'", []],
      ["objects = '{deal}'", []],
      ["mapping = '[1]'", []],
      ['settings = \'{"mode": "update"}\'', []],
      ["file_name = 'other.csv'", []],
      ["created_by_kind = 'system'", []],
      ['created_by_id = uuidv7()', []],
      ['created_at = now()', []],
      ['file_id = $2', [another.id]],
    ] as const)
      await refused(set(changes, values), 'jobs_start_fixed');
    // Progress, a request to stop and the run working it are what does change.
    await set(
      'processed_count = 3, created_count = 2, failed_count = 1, cancel_requested_at = now(), runner = uuidv7(), heartbeat_at = now()',
    );
  });

  it('changes in nothing once it has ended, except that its files may go', async () => {
    const { context } = await business();
    const own = await database.withTenant(context, (sql) => file(sql));
    const errors = await database.withTenant(context, (sql) => file(sql));
    const another = await database.withTenant(context, (sql) => file(sql));
    const job = await database.withTenant(context, (sql) => waiting(sql, { fileId: own.id }));
    const set = (changes: string, values: readonly unknown[] = []) =>
      database.withTenant(context, (sql) => change(sql, job.id, changes, values));
    await set("status = 'running', started_at = now()");
    await set(
      "status = 'completed', finished_at = now(), processed_count = 3, created_count = 2, failed_count = 1, error_file_id = $2",
      [errors.id],
    );
    for (const [changes, values] of [
      ['processed_count = 3, created_count = 3, failed_count = 0', []],
      ['cancel_requested_at = now()', []],
      ['heartbeat_at = now()', []],
      ['runner = uuidv7()', []],
      ["error = 'changed afterwards'", []],
      ['finished_at = now()', []],
      ['error_file_id = $2', [another.id]],
    ] as const)
      await refused(set(changes, values), 'jobs_finished_fixed');
    await set('file_id = null, error_file_id = null');
  });
});

describe("an import's rows", () => {
  const row = (
    sql: Sql,
    jobId: string,
    values: {
      number: number;
      outcome: string;
      recordId?: string;
      code?: string | null;
      detail?: string | null;
    },
  ) =>
    sql.query(
      `insert into imports.job_rows (business_id, job_id, row_number, outcome, record_id, code, detail)
       values (app.business_id(), $1, $2, $3, $4, $5, $6)`,
      [
        jobId,
        values.number,
        values.outcome,
        values.recordId ?? null,
        values.code ?? null,
        values.detail ?? null,
      ],
    );

  it('are recorded once each: a row of the file cannot be applied twice', async () => {
    const { context } = await business();
    const record = await contact(context);
    const another = await contact(context);
    const job = await database.withTenant(context, (sql) => waiting(sql));
    await database.withTenant(context, (sql) =>
      row(sql, job.id, { number: 2, outcome: 'created', recordId: record }),
    );
    for (const again of [
      { number: 2, outcome: 'created', recordId: another },
      { number: 2, outcome: 'failed', code: 'invalid', detail: 'Enter an email address.' },
    ])
      await refused(
        database.withTenant(context, (sql) => row(sql, job.id, again)),
        'job_rows_pkey',
      );
  });

  it('write a record once in an import, and may write it again in the next', async () => {
    const { context } = await business();
    const record = await contact(context);
    const job = await database.withTenant(context, (sql) => waiting(sql));
    await database.withTenant(context, (sql) =>
      row(sql, job.id, { number: 2, outcome: 'created', recordId: record }),
    );
    await refused(
      database.withTenant(context, (sql) =>
        row(sql, job.id, { number: 3, outcome: 'updated', recordId: record }),
      ),
      'job_rows_one_write_per_record_idx',
    );
    await database.withTenant(context, (sql) =>
      change(sql, job.id, "status = 'cancelled', finished_at = now()"),
    );
    const next = await database.withTenant(context, (sql) => waiting(sql));
    await database.withTenant(context, (sql) =>
      row(sql, next.id, { number: 2, outcome: 'updated', recordId: record }),
    );
  });

  it('say why a row was skipped or failed, and name a record only when one was written', async () => {
    const { context } = await business();
    const record = await contact(context);
    const job = await database.withTenant(context, (sql) => waiting(sql));
    const add = (values: Parameters<typeof row>[2]) =>
      database.withTenant(context, (sql) => row(sql, job.id, values));
    const reason = { code: 'invalid', detail: 'Enter an email address.' };
    await refused(add({ number: 0, outcome: 'created' }), 'job_rows_row_number_positive');
    await refused(add({ number: 2, outcome: 'merged' }), 'job_rows_outcome_valid');
    await refused(add({ number: 2, outcome: 'failed' }), 'job_rows_reason_when_not_written');
    await refused(add({ number: 2, outcome: 'skipped' }), 'job_rows_reason_when_not_written');
    await refused(
      add({ number: 2, outcome: 'created', ...reason }),
      'job_rows_reason_when_not_written',
    );
    await refused(
      add({ number: 2, outcome: 'failed', code: 'invalid' }),
      'job_rows_reason_complete',
    );
    await refused(
      add({ number: 2, outcome: 'failed', code: 'Not A Code', detail: 'x' }),
      'job_rows_code_format',
    );
    await refused(
      add({ number: 2, outcome: 'failed', code: 'invalid', detail: '' }),
      'job_rows_detail_length',
    );
    await refused(
      add({ number: 2, outcome: 'failed', code: 'invalid', detail: 'x'.repeat(2001) }),
      'job_rows_detail_length',
    );
    for (const outcome of ['skipped', 'failed'])
      await refused(
        add({ number: 2, outcome, recordId: record, ...reason }),
        'job_rows_record_only_when_written',
      );
    await add({ number: 2, outcome: 'failed', ...reason });
    await add({ number: 3, outcome: 'skipped', code: 'exists', detail: 'Already a contact.' });
    await add({ number: 4, outcome: 'updated', recordId: record });
  });

  it('cannot be changed or deleted by the application', async () => {
    const { context } = await business();
    const job = await database.withTenant(context, (sql) => waiting(sql));
    await database.withTenant(context, (sql) =>
      row(sql, job.id, { number: 2, outcome: 'failed', code: 'invalid', detail: 'x' }),
    );
    for (const statement of [
      "update imports.job_rows set outcome = 'created', code = null, detail = null",
      'delete from imports.job_rows',
      'delete from imports.jobs',
    ])
      await expect(
        database.withTenant(context, (sql) => sql.query(statement)),
      ).rejects.toMatchObject({ code: '42501' });
  });

  it('keep their outcome when the record is purged, and go with their business', async () => {
    const { agency, business: owned, context } = await business();
    const record = await contact(context);
    const job = await database.withTenant(context, (sql) => waiting(sql));
    await database.withTenant(context, (sql) =>
      row(sql, job.id, { number: 2, outcome: 'created', recordId: record }),
    );
    await database.withTenant(context, (sql) =>
      sql.query('delete from crm.records where id = $1', [record]),
    );
    expect(
      await database.withTenant(context, (sql) =>
        sql.query('select row_number, outcome, record_id from imports.job_rows'),
      ),
    ).toEqual([{ row_number: 2, outcome: 'created', record_id: null }]);
    await database.as('crm_owner', (sql) =>
      sql.query('delete from tenancy.businesses where id = $1 and agency_id = $2', [
        owned.id,
        agency.id,
      ]),
    );
    expect(
      await database.as('crm_owner', (sql) =>
        sql.query(
          `select 1 from imports.jobs where business_id = $1
           union all select 1 from imports.job_rows where business_id = $1`,
          [owned.id],
        ),
      ),
    ).toEqual([]);
  });
});

describe('private.stalled_imports', () => {
  const stalled = (staleAfter: string, limit = 100) =>
    database.as('crm_app', (sql) =>
      sql.query<{ agency_id: string; business_id: string; job_id: string }>(
        'select * from private.stalled_imports($1::interval, $2)',
        [staleAfter, limit],
      ),
    );

  it('finds the CSV imports that wait or run without progress, in every business, oldest first', async () => {
    const first = await business();
    const second = await business();
    const fresh = await business();
    const ended = await business();
    const other = await business();
    const quiet = async (
      owner: Awaited<ReturnType<typeof business>>,
      minutesAgo: number,
      then = '',
    ) => {
      const job = await database.withTenant(owner.context, (sql) => waiting(sql));
      await database.withTenant(owner.context, (sql) =>
        change(
          sql,
          job.id,
          `heartbeat_at = now() - make_interval(mins => $2)${then === '' ? '' : `, ${then}`}`,
          [minutesAgo],
        ),
      );
      return job.id;
    };
    const oldest = await quiet(first, 30, "status = 'running', started_at = now()");
    const older = await quiet(second, 20);
    await quiet(fresh, 1);
    await quiet(ended, 40, "status = 'cancelled', finished_at = now()");
    // An import from another product is not this sweep's to restart.
    await database.withTenant(other.context, (sql) =>
      sql.query(
        `insert into imports.jobs (business_id, source, heartbeat_at)
         values (app.business_id(), 'ghl', now() - interval '50 minutes')`,
      ),
    );

    const mine = (rows: Awaited<ReturnType<typeof stalled>>) =>
      rows.filter((each) =>
        [first, second, fresh, ended, other].some((b) => b.business.id === each.business_id),
      );
    expect(mine(await stalled('10 minutes'))).toEqual([
      { agency_id: first.agency.id, business_id: first.business.id, job_id: oldest },
      { agency_id: second.agency.id, business_id: second.business.id, job_id: older },
    ]);
    expect(mine(await stalled('25 minutes'))).toEqual([
      { agency_id: first.agency.id, business_id: first.business.id, job_id: oldest },
    ]);
    expect(await stalled('10 minutes', 0)).toEqual([]);
  });

  it('is run by crm_app alone, with a pinned search path', async () => {
    const [found] = await database.as('crm_owner', (sql) =>
      sql.query<{ definer: boolean; config: string[]; app: boolean; open: boolean }>(
        `select p.prosecdef as definer, p.proconfig as config,
                has_function_privilege('crm_app', p.oid, 'execute') as app,
                has_function_privilege('public', p.oid, 'execute') as open
         from pg_proc p
         where p.oid = 'private.stalled_imports(interval, integer)'::regprocedure`,
      ),
    );
    expect(found).toEqual({ definer: true, config: ['search_path=""'], app: true, open: false });
    for (const role of ['crm_auth', 'crm_worker'] as const)
      await expect(
        database.as(role, (sql) =>
          sql.query("select * from private.stalled_imports(interval '1 minute', 1)"),
        ),
      ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('an install that already had imports', () => {
  let postgres: Postgres;
  let earlier: string;
  beforeAll(async () => {
    postgres = await startPostgres({ bootstrapFile });
    earlier = await mkdtemp(join(tmpdir(), 'crm-before-imports-'));
    for (const name of await readdir(migrationsDirectory))
      if (name < IMPORTS) await cp(join(migrationsDirectory, name), join(earlier, name));
  });
  afterAll(async () => {
    await postgres.stop();
    await rm(earlier, { recursive: true, force: true });
  });

  it('keeps every import, closing those no job will ever run', async () => {
    const connectionString = postgres.url(await postgres.createDatabase());
    const before = await migrate({ connectionString, directory: earlier });
    expect(before.applied).not.toContain(IMPORTS);
    // crm_owner, as a repair would write: no release ever inserted an import.
    const owner = new pg.Client({ connectionString });
    await owner.connect();
    try {
      const {
        rows: [agency],
      } = await owner.query<{ id: string }>(
        "insert into tenancy.agencies (name, slug) values ('Agency', 'agency') returning id",
      );
      const {
        rows: [owned],
      } = await owner.query<{ id: string }>(
        "insert into tenancy.businesses (agency_id, name, slug) values ($1, 'Business', 'business') returning id",
        [agency?.id],
      );
      await owner.query(
        `insert into imports.jobs (business_id, source, status, error, settings, stats, created_by_id)
         values ($1, 'ghl', 'pending', null, '{}', '{}', null),
                ($1, 'csv', 'pending', null, '{"mode": "create"}', '{}', null),
                ($1, 'csv', 'running', null, '{}', '{"contacts": 4}', null),
                ($1, 'ghl', 'completed', null, '{}', '{}', $2),
                ($1, 'ghl', 'failed', $3, '{}', '{}', null),
                ($1, 'csv', 'cancelled', null, '{}', '{}', null)`,
        [owned?.id, randomUUID(), 'x'.repeat(3000)],
      );

      const upgrade = await migrate({ connectionString });
      expect(upgrade.applied).toContain(IMPORTS);

      const jobs = await owner.query(
        `select source, status, started_at is not null as started,
                finished_at is not null as finished, error_code, file_name,
                length(error) as error_length, settings, stats, objects, created_by_kind,
                created_by_id is not null as by_someone, row_count, processed_count
         from imports.jobs order by id`,
      );
      const kept = {
        objects: ['contact'],
        created_by_kind: 'system',
        by_someone: false,
        row_count: 0,
        processed_count: 0,
        error_code: null,
        error_length: null,
        stats: {},
        settings: {},
        file_name: null,
      };
      expect(jobs.rows).toEqual([
        { ...kept, source: 'ghl', status: 'cancelled', started: false, finished: true },
        {
          ...kept,
          source: 'csv',
          status: 'cancelled',
          started: false,
          finished: true,
          settings: { mode: 'create' },
          file_name: 'import.csv',
        },
        {
          ...kept,
          source: 'csv',
          status: 'cancelled',
          started: false,
          finished: true,
          stats: { contacts: 4 },
          file_name: 'import.csv',
        },
        {
          ...kept,
          source: 'ghl',
          status: 'completed',
          started: true,
          finished: true,
          by_someone: true,
        },
        {
          ...kept,
          source: 'ghl',
          status: 'failed',
          started: false,
          finished: true,
          error_code: 'unknown',
          error_length: 2000,
        },
        {
          ...kept,
          source: 'csv',
          status: 'cancelled',
          started: false,
          finished: true,
          file_name: 'import.csv',
        },
      ]);
    } finally {
      await owner.end();
    }
  });
});
