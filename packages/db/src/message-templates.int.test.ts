// Message templates' database side (migration 0039): tenant isolation, one live name per
// business, a subject that can't carry another header, and a plain-text body always, with a
// formatted part beside it since 0092.
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

const insert = (sql: Sql, name: string, subject = 'Your pricing guide') =>
  sql.query(
    `insert into messaging.templates (business_id, name, subject, body, created_by_kind)
     values (app.business_id(), $1, $2, 'Hi {{contact.firstName}}', 'user')`,
    [name, subject],
  );

it("isolates templates, so one business never sees or names another's", async () => {
  const agency = await database.fixtures.agency();
  const first = await database.fixtures.business(agency.id);
  const second = await database.fixtures.business(agency.id);
  await database.withTenant(first.context, (sql) => insert(sql, 'Pricing guide'));
  expect(
    await database.withTenant(second.context, (sql) =>
      sql.query('select name from messaging.templates'),
    ),
  ).toEqual([]);
  // The same name in another business is a different template.
  await database.withTenant(second.context, (sql) => insert(sql, 'Pricing guide'));
});

it('keeps one live template per name, ignoring case, and refuses a subject with a line break', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  await database.withTenant(business.context, (sql) => insert(sql, 'Pricing guide'));
  await expect(
    database.withTenant(business.context, (sql) => insert(sql, ' pricing GUIDE ')),
  ).rejects.toMatchObject({
    code: '23505',
  });
  await database.withTenant(business.context, (sql) =>
    sql.query("update messaging.templates set archived_at = now() where name = 'Pricing guide'"),
  );
  await database.withTenant(business.context, (sql) => insert(sql, 'Pricing guide'));
  await expect(
    database.withTenant(business.context, (sql) =>
      insert(sql, 'Injected', 'Hello\r\nBcc: someone@example.test'),
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

it('holds a plain-text body always, and a formatted part and preview text beside it (0092)', async () => {
  const columns = await database.as('crm_owner', (sql) =>
    sql.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'messaging' and table_name = 'templates' order by column_name`,
    ),
  );
  expect(columns.map((column) => column.column_name)).toEqual([
    'archived_at',
    'body',
    // Formatted text the messaging module cleaned before storing it.
    'body_html',
    'business_id',
    'channel',
    'created_at',
    'created_by_id',
    'created_by_kind',
    'deleted_at',
    'folder_id',
    // Fixed to 'template' (0088): what keeps a template out of a folder of campaigns.
    'folder_kind',
    'id',
    'name',
    'name_normalized',
    'preheader',
    'subject',
    'updated_at',
  ]);
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const formatted = (name: string, html: string | null, preheader: string | null) =>
    database.withTenant(business.context, (sql) =>
      sql.query(
        `insert into messaging.templates (business_id, name, subject, body, body_html, preheader, created_by_kind)
         values (app.business_id(), $1, 'Subject', 'Text', $2, $3, 'user')`,
        [name, html, preheader],
      ),
    );
  await formatted('Formatted', '<p>Text</p>', 'A peek');
  await formatted('Formatted, no preview', '<p>Text</p>', null);
  await formatted('Plain', null, null);
  const refused = { code: '23514' };
  // Preview text is hidden text of the formatted part: plain text has nowhere for it.
  await expect(formatted('Preview alone', null, 'A peek')).rejects.toMatchObject(refused);
  await expect(formatted('Empty html', '', null)).rejects.toMatchObject(refused);
  await expect(formatted('Long html', 'x'.repeat(200_001), null)).rejects.toMatchObject(refused);
  await expect(formatted('Two lines', '<p>Text</p>', 'A\nB')).rejects.toMatchObject(refused);
  await expect(formatted('Long preview', '<p>Text</p>', 'x'.repeat(151))).rejects.toMatchObject(
    refused,
  );
  await expect(formatted('Empty preview', '<p>Text</p>', '')).rejects.toMatchObject(refused);
});

it('has a place for a workflow email’s own From name and Reply-To, and a revision’s formatted part, each with its check (0092)', async () => {
  const columns = await database.as('crm_owner', (sql) =>
    sql.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where (table_schema, table_name) in (('messaging', 'outbound_dispatch'), ('automation', 'email_content_revisions'))
         and column_name in ('from_name', 'reply_to', 'body_html', 'preheader')
       order by table_name, column_name`,
    ),
  );
  expect(columns.map((column) => `${column.table_name}.${column.column_name}`)).toEqual([
    'email_content_revisions.body_html',
    'email_content_revisions.preheader',
    'outbound_dispatch.from_name',
    'outbound_dispatch.reply_to',
  ]);
  const constraints = await database.as('crm_owner', (sql) =>
    sql.query<{ conname: string }>(
      `select conname from pg_constraint
       where conname in ('outbound_dispatch_from_name_valid', 'outbound_dispatch_reply_to_valid',
         'email_content_body_html_length', 'email_content_preheader_valid',
         'templates_body_html_length', 'templates_preheader_valid', 'templates_preheader_needs_html')
       order by conname`,
    ),
  );
  expect(constraints.map((constraint) => constraint.conname)).toEqual([
    'email_content_body_html_length',
    'email_content_preheader_valid',
    'outbound_dispatch_from_name_valid',
    'outbound_dispatch_reply_to_valid',
    'templates_body_html_length',
    'templates_preheader_needs_html',
    'templates_preheader_valid',
  ]);
});
