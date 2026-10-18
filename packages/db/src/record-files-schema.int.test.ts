// The record files migration at the database's own level: a text box list's value is some
// text by box, a file upload field has its formats and limit and its value is file ids,
// and a record's files are its business's alone, go with the record, and outlive a deleted
// field as documents. What the CRM module does with these is its own to prove.
import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

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

/** Whether a file is marked deleted, and how many jobs wait to remove its bytes. */
const removal = (fileId: string) =>
  database.as('crm_owner', async (sql) => {
    const file = await sql.one<{ deleted: boolean }>(
      'select deleted_at is not null as deleted from files.files where id = $1',
      [fileId],
    );
    const jobs = await sql.query<{ id: string }>(
      `select j.id from graphile_worker.jobs j
       where j.task_identifier = 'files.remove_bytes' and j.key = 'files.remove_bytes:' || $1::text`,
      [fileId],
    );
    return { deleted: file.deleted, queued: jobs.length };
  });

/** What the database refuses a statement with, or undefined when it takes it. */
const refusal = async (run: Promise<unknown>): Promise<string | undefined> =>
  run.then(
    () => undefined,
    (reason: unknown) => (reason instanceof Error ? reason.message : String(reason)),
  );

/** A contact field of the type, with the columns given, written as the business. */
const field = (context: TenantContext, type: string, columns = '', values = '') =>
  database.withTenant(context, (sql) =>
    sql.one<{ id: string }>(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, value_type, created_by_kind${columns})
       select app.business_id(), id, $1, $1, $2, 'system'${values}
       from crm.object_types where kind = 'contact'
       returning id`,
      [`f_${randomUUID().slice(0, 8)}`, type],
    ),
  );

/** A record's file as the files service keeps one: for the record alone. */
const file = (context: TenantContext, library = false) =>
  database.withTenant(context, (sql) =>
    sql.one<{ id: string }>(
      `insert into files.files (agency_id, business_id, storage, storage_key, filename, content_type, size_bytes, sha256, uploaded_by_kind, purpose, library)
       values (app.agency_id(), app.business_id(), 'local', $1, 'a.pdf', 'application/pdf', 1, sha256(convert_to($1, 'UTF8')), 'system', 'record_file', $2)
       returning id`,
      [randomUUID(), library],
    ),
  );

describe('a text box list', () => {
  it('needs a box, and keeps some text by box, nothing but text', async () => {
    const context = await business();
    expect(await refusal(field(context, 'text_list'))).toContain(
      'field_definitions_choices_have_options',
    );
    const list = await field(
      context,
      'text_list',
      ', options',
      `, '[{"key": "first", "label": "First", "description": "", "archived": false}]'::jsonb`,
    );
    const contact = await database.fixtures.contact(context);
    const write = (json: string) =>
      database.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.field_values (business_id, record_id, field_id, value_type, value_json, source_kind)
           values (app.business_id(), $1, $2, 'text_list', $3::jsonb, 'user')
           on conflict (business_id, record_id, field_id) do update set value_json = excluded.value_json`,
          [contact.id, list.id, json],
        ),
      );
    // Text only: not a number, a list of texts or an empty list in a box, and not so much
    // that a page of values could not be read.
    for (const wrong of [
      '{}',
      '[]',
      '{"first": 7}',
      '"text"',
      '{"first": ["x"]}',
      '{"first": []}',
      JSON.stringify({ first: 'x'.repeat(600_000) }),
    ])
      expect(await refusal(write(wrong)), wrong.slice(0, 30)).toContain(
        'field_values_value_matches_type',
      );
    expect(await refusal(write('{"first": "Ann"}'))).toBeUndefined();
  });
});

describe('a file upload field', () => {
  it('has formats from the list and a limit of 1 to 10, which no other type has', async () => {
    const context = await business();
    expect(await refusal(field(context, 'file'))).toContain(
      'field_definitions_file_options_for_files',
    );
    expect(
      await refusal(field(context, 'file', ', file_formats, file_limit', `, '{exe}', 1`)),
    ).toContain('field_definitions_file_formats_valid');
    expect(
      await refusal(field(context, 'file', ', file_formats, file_limit', `, '{pdf}', 11`)),
    ).toContain('field_definitions_file_limit_range');
    expect(
      await refusal(field(context, 'text', ', file_formats, file_limit', `, '{pdf}', 1`)),
    ).toContain('field_definitions_file_options_for_files');
    expect(
      await refusal(field(context, 'file', ', file_formats, file_limit', `, '{pdf,png}', 3`)),
    ).toBeUndefined();
  });
});

describe("a record's files", () => {
  it("are one business's, go with their record, and stay as documents when their field goes", async () => {
    const context = await business();
    const other = await business();
    const contact = await database.fixtures.contact(context);
    const scans = await field(context, 'file', ', file_formats, file_limit', `, '{pdf}', 2`);
    const kept = await file(context);
    // Kept for its record alone: never in the media library.
    expect(await refusal(file(context, true))).toContain('files_purpose_private');
    const link = (as: TenantContext, fileId: string, fieldId: string | null) =>
      database.withTenant(as, (sql) =>
        sql.query(
          `insert into crm.record_files (business_id, file_id, record_id, field_id, created_by_kind)
           values (app.business_id(), $1, $2, $3, 'user')`,
          [fileId, contact.id, fieldId],
        ),
      );
    // Another business can't tie its own file to this contact.
    expect(await refusal(link(other, (await file(other)).id, null))).toBeDefined();
    await link(context, kept.id, scans.id);
    // A file belongs to one record.
    expect(await refusal(link(context, kept.id, null))).toContain('record_files_pkey');
    const seen = (as: TenantContext) =>
      database.withTenant(as, (sql) =>
        sql.query<{ field_id: string | null }>('select field_id from crm.record_files'),
      );
    expect(await seen(other)).toEqual([]);
    expect(await seen(context)).toEqual([{ field_id: scans.id }]);
    // Used, so the media library never deletes it.
    expect(
      await database.withTenant(context, (sql) =>
        sql.query<{ place: string }>('select place from files.file_usage($1)', [kept.id]),
      ),
    ).toEqual([{ place: 'record_file' }]);
    await database.as('crm_owner', (sql) =>
      sql.query('delete from crm.field_definitions where id = $1', [scans.id]),
    );
    expect(await seen(context)).toEqual([{ field_id: null }]);
    // The record's purge takes its files with it: each is marked deleted in the same
    // transaction, and its bytes are queued for removal once that commits.
    await database.withTenant(context, (sql) =>
      sql.query('delete from crm.records where id = $1', [contact.id]),
    );
    expect(await seen(context)).toEqual([]);
    expect(await removal(kept.id)).toEqual({ deleted: true, queued: 1 });
  });

  it('marks a file deleted when it is taken off its record, and queues its bytes once', async () => {
    const context = await business();
    const contact = await database.fixtures.contact(context);
    const kept = await file(context);
    await database.withTenant(context, async (sql) => {
      await sql.query(
        `insert into crm.record_files (business_id, file_id, record_id, created_by_kind)
         values (app.business_id(), $1, $2, 'user')`,
        [kept.id, contact.id],
      );
      await sql.query('delete from crm.record_files where file_id = $1', [kept.id]);
    });
    expect(await removal(kept.id)).toEqual({ deleted: true, queued: 1 });
    // Marking it again queues nothing more.
    await database.as('crm_owner', (sql) =>
      sql.query('update files.files set deleted_at = now() where id = $1', [kept.id]),
    );
    expect(await removal(kept.id)).toEqual({ deleted: true, queued: 1 });
  });

  it('are added and deleted by the application, never changed', async () => {
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ privilege_type: string }>(
        `select privilege_type from information_schema.role_table_grants
         where grantee = 'crm_app' and table_schema = 'crm' and table_name = 'record_files'
         order by privilege_type`,
      ),
    );
    expect(grants.map((grant) => grant.privilege_type)).toEqual(['DELETE', 'INSERT', 'SELECT']);
  });
});
