import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const binding = await database.withTenant(business.context, async (sql) => {
    const automation = await sql.one<{ id: string }>(
      `insert into automation.automations (business_id,name,draft,created_by_kind)
       values ($1,'Email content','{}','system') returning id`,
      [business.id],
    );
    const row = await sql.one<{ id: string }>(
      `insert into automation.email_bindings (business_id,automation_id,step)
       values ($1,$2,'welcome') returning id`,
      [business.id, automation.id],
    );
    await sql.query(
      `insert into automation.email_content_revisions
       (business_id,binding_id,revision,mode,subject,body,created_by_kind)
       values ($1,$2,1,'copy','Your guide','Independent body','system')`,
      [business.id, row.id],
    );
    return row;
  });
  return { agency, business, binding };
}

it('isolates bindings and their content revisions by business', async () => {
  const f = await fixture();
  const other = await database.fixtures.business(f.agency.id);
  expect(
    await database.withTenant(other.context, (sql) =>
      sql.query('select id from automation.email_bindings where id=$1', [f.binding.id]),
    ),
  ).toEqual([]);
  expect(
    await database.withTenant(other.context, (sql) =>
      sql.query('select subject from automation.email_content_revisions where binding_id=$1', [
        f.binding.id,
      ]),
    ),
  ).toEqual([]);
});

it('keeps revisions append-only for the application and requires a real current revision', async () => {
  const f = await fixture();
  await expect(
    database.withTenant(f.business.context, (sql) =>
      sql.query(
        `update automation.email_content_revisions set subject='Overwrite' where binding_id=$1`,
        [f.binding.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.withTenant(f.business.context, (sql) =>
      sql.query('update automation.email_bindings set current_revision=2 where id=$1', [
        f.binding.id,
      ]),
    ),
  ).rejects.toMatchObject({ code: '23503' });
});

it('requires a same-business binding even for owner inserts', async () => {
  const f = await fixture();
  const other = await database.fixtures.business(f.agency.id);
  await expect(
    database.as('crm_owner', (sql) =>
      sql.query(
        `insert into automation.email_content_revisions
     (business_id,binding_id,revision,mode,subject,body,created_by_kind)
     values ($1,$2,2,'copy','Foreign','Foreign','system')`,
        [other.id, f.binding.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23503' });
});

it('advances content atomically while preserving the previous revision', async () => {
  const f = await fixture();
  await database.withTenant(f.business.context, async (sql) => {
    await sql.query(
      `insert into automation.email_content_revisions
       (business_id,binding_id,revision,mode,subject,body,created_by_kind)
       values ($1,$2,2,'copy','Revised guide','Revised independent body','system')`,
      [f.business.id, f.binding.id],
    );
    await sql.query('update automation.email_bindings set current_revision=2 where id=$1', [
      f.binding.id,
    ]);
  });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        `select revision, subject, body from automation.email_content_revisions
         where binding_id=$1 order by revision`,
        [f.binding.id],
      ),
    ),
  ).toEqual([
    { revision: 1, subject: 'Your guide', body: 'Independent body' },
    { revision: 2, subject: 'Revised guide', body: 'Revised independent body' },
  ]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select current_revision from automation.email_bindings where id=$1', [
        f.binding.id,
      ]),
    ),
  ).toEqual([{ current_revision: 2 }]);
});

it('denies changing binding identity or deleting its revision history', async () => {
  const f = await fixture();
  await expect(
    database.withTenant(f.business.context, (sql) =>
      sql.query("update automation.email_bindings set step='different' where id=$1", [
        f.binding.id,
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.withTenant(f.business.context, (sql) =>
      sql.query('delete from automation.email_content_revisions where binding_id=$1', [
        f.binding.id,
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

it('rejects continuous sync without a source template', async () => {
  const f = await fixture();
  await expect(
    database.withTenant(f.business.context, (sql) =>
      sql.query(
        `insert into automation.email_content_revisions
         (business_id,binding_id,revision,mode,subject,body,created_by_kind)
         values ($1,$2,2,'sync','Guide','Body','system')`,
        [f.business.id, f.binding.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23514', constraint: 'email_content_sync_source_required' });
});

it('allows only one draft binding for a workflow action', async () => {
  const f = await fixture();
  await expect(
    database.withTenant(f.business.context, (sql) =>
      sql.query(
        `insert into automation.email_bindings (business_id,automation_id,step)
         select business_id,automation_id,step from automation.email_bindings where id=$1`,
        [f.binding.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23505', constraint: 'email_bindings_action_unique' });
});

it('rejects a published version belonging to another workflow in the same business', async () => {
  const f = await fixture();
  await expect(
    database.withTenant(f.business.context, async (sql) => {
      const other = await sql.one<{ id: string }>(
        `insert into automation.automations (business_id,name,draft,created_by_kind)
         values ($1,'Other workflow','{}','system') returning id`,
        [f.business.id],
      );
      const version = await sql.one<{ id: string }>(
        `insert into automation.versions
         (business_id,automation_id,version,document,published_by_kind)
         values ($1,$2,1,'{}','system') returning id`,
        [f.business.id, other.id],
      );
      await sql.query(
        `insert into automation.email_bindings (business_id,automation_id,version_id,step)
         select business_id,automation_id,$2,'published_welcome'
         from automation.email_bindings where id=$1`,
        [f.binding.id, version.id],
      );
    }),
  ).rejects.toMatchObject({ code: '23503', constraint: 'email_bindings_version_owner' });
});
