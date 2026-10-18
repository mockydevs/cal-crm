// What uses a field, against real Postgres: templates and automations stored as authoring
// and publishing store them, found by the field's merge paths.
import { randomUUID } from 'node:crypto';

import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { readFieldUses } from './field-uses.js';

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

async function business(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, correlationId: randomUUID() };
}

const template = async (
  context: TenantContext,
  name: string,
  subject: string,
  body: string,
): Promise<string> => {
  const row = await database.withTenant(context, (sql) =>
    sql.one<{ id: string }>(
      `insert into messaging.templates (business_id, name, subject, body, created_by_kind)
       values (app.business_id(), $1, $2, $3, 'user') returning id`,
      [name, subject, body],
    ),
  );
  return toPublicId('template', row.id);
};

/** An automation with this draft and, when given, this published document. */
const automation = async (
  context: TenantContext,
  name: string,
  draft: object,
  published?: object,
  deleted = false,
): Promise<string> => {
  const id = await database.withTenant(context, async (sql) => {
    const made = await sql.one<{ id: string }>(
      `insert into automation.automations (business_id, name, draft, created_by_kind)
       values (app.business_id(), $1, $2::jsonb, 'user') returning id`,
      [name, JSON.stringify(draft)],
    );
    if (published !== undefined) {
      const version = await sql.one<{ id: string }>(
        `insert into automation.versions
           (business_id, automation_id, version, document, published_by_kind)
         values (app.business_id(), $1, 1, $2::jsonb, 'user') returning id`,
        [made.id, JSON.stringify(published)],
      );
      await sql.query(
        `update automation.automations set published_version_id = $2, status = 'active'
         where id = $1`,
        [made.id, version.id],
      );
    }
    if (deleted)
      await sql.query(
        `update automation.automations set status = 'archived', archived_at = now()
         where id = $1`,
        [made.id],
      );
    return made.id;
  });
  return toPublicId('automation', id);
};

const uses = (context: TenantContext, paths: readonly string[]) =>
  withTenant(db, context, (trx) => readFieldUses(trx, paths));
const text = (body: string) => ({ steps: { say: { type: 'sms.send', config: { body } } } });

it('names the templates and the automations that write the field, by name, and no other', async () => {
  const context = await business();
  const paths = ['contact.custom.fence_type', 'contact.fence_type'];
  const inBody = await template(context, 'B quote', 'Your quote', 'A {{contact.fence_type}} fence');
  const inSubject = await template(
    context,
    'A subject',
    'Re {{ contact.custom.fence_type }}',
    'Hi',
  );
  // The same words, but another field's path: longer, or the tail of a longer one.
  await template(
    context,
    'Another field',
    'Hello',
    '{{contact.fence_type_2}} {{other_contact.fence_type}}',
  );
  await template(
    context,
    'No field',
    'Hello',
    'A fence_type with no path, and {{contact.firstName}}',
  );

  const drafted = await automation(context, 'B drafted', text('Your {{contact.fence_type}} fence'));
  const published = await automation(context, 'A published', text('Nothing of it now'), {
    steps: { wait: { type: 'wait.until', config: { field: 'contact.custom.fence_type' } } },
  });
  await automation(context, 'Deleted', text('{{contact.fence_type}}'), undefined, true);
  await automation(
    context,
    'Unrelated',
    text('{{contact.firstName}} and {{contact.fence_type_2}}'),
  );

  expect(await uses(context, paths)).toEqual({
    templates: [
      { id: inSubject, name: 'A subject' },
      { id: inBody, name: 'B quote' },
    ],
    automations: [
      { id: published, name: 'A published' },
      { id: drafted, name: 'B drafted' },
    ],
  });
});

it('finds nothing for a field nothing writes, and nothing in another business', async () => {
  const context = await business();
  const other = await business();
  await template(other, 'Theirs', 'Hello', '{{contact.fence_type}}');
  await automation(other, 'Theirs', text('{{contact.fence_type}}'));
  expect(await uses(context, ['contact.fence_type'])).toEqual({ templates: [], automations: [] });
  expect((await uses(other, ['contact.fence_type'])).templates).toHaveLength(1);
});

it('takes a path as text to find, never as a pattern, and asks nothing for no path', async () => {
  const context = await business();
  await template(context, 'Dotted', 'Hello', '{{contactXfence_type}} and {{contact.anything}}');
  // A dot is a dot: the path is not a pattern in which it would match any character.
  expect(await uses(context, ['contact.fence_type'])).toEqual({ templates: [], automations: [] });
  // What is not a path at all is left out; with nothing left, nothing is asked.
  expect(await uses(context, ['contact.(.*)', '.*'])).toEqual({ templates: [], automations: [] });
  expect(await uses(context, [])).toEqual({ templates: [], automations: [] });
  const found = await template(context, 'Found', 'Hello', '{{opportunity.quote_total}}');
  expect(await uses(context, ['.*', 'opportunity.quote_total'])).toEqual({
    templates: [{ id: found, name: 'Found' }],
    automations: [],
  });
});
