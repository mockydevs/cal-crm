import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

it('isolates folders and refuses foreign parents even for the database owner', async () => {
  const agency = await database.fixtures.agency();
  const first = await database.fixtures.business(agency.id);
  const second = await database.fixtures.business(agency.id);
  const folder = await database.withTenant(first.context, (sql) =>
    sql.one<{ id: string }>(
      `insert into messaging.template_folders (business_id, name, created_by_kind)
     values ($1, 'Welcome', 'system') returning id`,
      [first.id],
    ),
  );
  expect(
    await database.withTenant(second.context, (sql) =>
      sql.query(`select id from messaging.template_folders where id = $1`, [folder.id]),
    ),
  ).toEqual([]);
  await expect(
    database.as('crm_owner', (sql) =>
      sql.query(
        `insert into messaging.template_folders (business_id, parent_id, name, created_by_kind)
     values ($1, $2, 'Foreign child', 'system')`,
        [second.id, folder.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23503' });
});

it('enforces sibling names including root, while permitting the same name in separate branches', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const parent = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      `insert into messaging.template_folders (business_id, name, created_by_kind)
     values ($1, 'Welcome', 'system') returning id`,
      [business.id],
    ),
  );
  await expect(
    database.withTenant(business.context, (sql) =>
      sql.query(
        `insert into messaging.template_folders (business_id, name, created_by_kind)
     values ($1, ' welcome ', 'system')`,
        [business.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23505' });
  await database.withTenant(business.context, (sql) =>
    sql.query(
      `insert into messaging.template_folders (business_id, parent_id, name, created_by_kind)
     values ($1, $2, 'Welcome', 'system')`,
      [business.id, parent.id],
    ),
  );
  expect(
    await database.withTenant(business.context, (sql) =>
      sql.query<{ name: string; revision: number }>(
        `select name, revision from messaging.template_folders order by parent_id nulls first`,
      ),
    ),
  ).toEqual([
    { name: 'Welcome', revision: 1 },
    { name: 'Welcome', revision: 1 },
  ]);
});

it('refuses invalid persisted names, revisions and a self parent', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  for (const name of ['', '  ', 'x'.repeat(121)]) {
    await expect(
      database.withTenant(business.context, (sql) =>
        sql.query(
          `insert into messaging.template_folders (business_id, name, created_by_kind)
       values ($1, $2, 'system')`,
          [business.id, name],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  }
  const folder = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      `insert into messaging.template_folders (business_id, name, created_by_kind)
     values ($1, 'Welcome', 'system') returning id`,
      [business.id],
    ),
  );
  await expect(
    database.withTenant(business.context, (sql) =>
      sql.query(`update messaging.template_folders set revision = 0 where id = $1`, [folder.id]),
    ),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    database.withTenant(business.context, (sql) =>
      sql.query(`update messaging.template_folders set parent_id = id where id = $1`, [folder.id]),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});
