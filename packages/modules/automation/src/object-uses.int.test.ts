// What uses a custom object, against real Postgres: only workflows whose published version
// names it stop it being deleted. A draft, or a deleted workflow, does not.
import { randomUUID } from 'node:crypto';

import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { readObjectUses } from './object-uses.js';

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

/** A workflow with this draft and, when given, this published document, in this state. */
const workflow = async (
  context: TenantContext,
  name: string,
  draft: object,
  published?: object,
  status: 'active' | 'paused' | 'archived' = 'active',
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
        `update automation.automations
         set published_version_id = $2, status = $3,
             archived_at = case when $3 = 'archived' then now() end
         where id = $1`,
        [made.id, version.id, status],
      );
    }
    return made.id;
  });
  return toPublicId('automation', id);
};

const uses = (context: TenantContext, key: string) =>
  withTenant(db, context, (trx) => readObjectUses(trx, key));
const text = (body: string) => ({ steps: { say: { type: 'sms.send', config: { body } } } });

it('names the published workflows that run on the object or write its fields, and no other', async () => {
  const context = await business();
  const runsOnIt = await workflow(context, 'B pet created', {}, { object: 'pet', steps: {} });
  const writesIt = await workflow(
    context,
    'A reminder',
    {},
    text('{{custom_objects.pet.pet_name}} is due'),
    'paused',
  );
  // A draft names it, but nothing published does; another object; a longer key; deleted.
  await workflow(context, 'Draft', { object: 'pet' }, text('Hello'));
  await workflow(context, 'Boats', {}, { object: 'boat', steps: {} });
  await workflow(context, 'Petrol', {}, text('{{custom_objects.petrol.level}}'));
  await workflow(context, 'Gone', {}, { object: 'pet', steps: {} }, 'archived');
  await workflow(context, 'Unpublished', { object: 'pet' });

  expect(await uses(context, 'pet')).toEqual([
    { id: writesIt, name: 'A reminder' },
    { id: runsOnIt, name: 'B pet created' },
  ]);
  expect(await uses(await business(), 'pet')).toEqual([]);
});
