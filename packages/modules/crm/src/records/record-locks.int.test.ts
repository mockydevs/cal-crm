import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation } from '@repo/commands';
import { fieldDefinition, recordFields } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { crmRoutes } from '../index.js';

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
async function call(
  operationId: string,
  invocation: Invocation,
  params: Record<string, string> = {},
  body?: unknown,
) {
  const route = crmRoutes.find((route) => route.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`Missing ${operationId} route.`);
  return route.run({ invocation, params, body, query: {} }, { db, authorize: allowEveryone });
}

it('lets an in-flight entity change finish writing record references before a field save', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const invocation: Invocation = {
    context: { ...business.context, correlationId: randomUUID() },
    permissions: 'all',
  };
  const record = await database.fixtures.contact(invocation.context, {
    firstName: 'Maya',
  });
  const id = toPublicId('contact', record.id);
  const definition = fieldDefinition.parse(
    await call(
      'createField',
      invocation,
      {},
      {
        objectKey: 'contact',
        key: 'venue',
        label: 'Venue',
        description: 'The location chosen for the event.',
        valueType: 'text',
        currency: null,
        options: [],
        aiFillSources: [],
        aiOverwrite: 'ask',
        archived: false,
      },
    ),
  );
  const field = recordFields.parse(await call('getRecordFields', invocation, { id })).items[0];
  if (field === undefined) throw new Error('The field must be readable before the race.');
  const locked = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  // Existing identity/trash commands take the entity lock before emitting activity.
  // This fixture holds that lock, then performs a real child-record FK insert.
  const changing = database
    .withTenant(invocation.context, async (sql) => {
      await sql.query('update crm.contacts set first_name=$1 where id=$2', [
        'Maya Updated',
        record.id,
      ]);
      locked.resolve(undefined);
      await release.promise;
      await sql.query(
        `insert into crm.notes (business_id, record_id, body, body_text, author_kind)
      values (app.business_id(), $1, $2::jsonb, 'Other record work', 'system')`,
        [
          record.id,
          JSON.stringify({
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Other record work' }],
              },
            ],
          }),
        ],
      );
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await locked.promise;
  const saving = call(
    'setRecordField',
    invocation,
    { id, fieldId: definition.id },
    { value: 'Garden', revision: field.revision },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await expect
      .poll(
        async () =>
          database.as('crm_app', async (sql) => {
            const row = await sql.one<{ waiting: boolean }>(
              "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%contacts%') as waiting",
            );
            return row.waiting;
          }),
        { timeout: 2000 },
      )
      .toBe(true);
  } finally {
    release.resolve(undefined);
  }
  expect(await changing).toBeUndefined();
  expect(await saving).toBeUndefined();
  expect(await call('getContact', invocation, { id })).toMatchObject({
    firstName: 'Maya Updated',
  });
  expect(recordFields.parse(await call('getRecordFields', invocation, { id })).items).toEqual([
    expect.objectContaining({ value: 'Garden' }),
  ]);
});
