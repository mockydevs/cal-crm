import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation } from '@repo/commands';
import { fieldDefinition } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { crmRoutes } from '../index.js';
import { readFieldNormalizationContext } from './normalization-context.js';

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

async function fixture(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  return { context: { ...business.context, correlationId: randomUUID() }, permissions: 'all' };
}

async function create(invocation: Invocation, key: string, objectKey = 'contact') {
  const route = crmRoutes.find((each) => each.endpoint.operationId === 'createField');
  if (route === undefined) throw new Error('Missing createField route.');
  return fieldDefinition.parse(
    await route.run(
      {
        invocation,
        params: {},
        query: {},
        body: {
          key,
          objectKey,
          label: key,
          description: 'Sanitized metadata fixture.',
          valueType: 'text',
          currency: null,
          options: [],
          aiFillSources: [],
          aiOverwrite: 'never',
          archived: false,
        },
      },
      { db, authorize: allowEveryone },
    ),
  );
}

it('reads an empty tenant without accepting fields from another business', async () => {
  const outside = await fixture();
  await create(outside, 'private_preference');
  const own = await fixture();
  const context = await withTenant(db, own.context, (trx) =>
    readFieldNormalizationContext(trx, own),
  );
  expect(context.definitions).toEqual([]);
  expect(context.aliases).toEqual([]);
});

it('reads contact fields, their aliases and country while excluding company metadata', async () => {
  const own = await fixture();
  const contact = await create(own, 'preference');
  await create(own, 'company_preference', 'company');
  await withTenant(db, own.context, async (trx) => {
    const stored = await trx
      .selectFrom('crm.field_definitions')
      .select(['id', 'object_type_id'])
      .where('id', '=', parsePublicId('field', contact.id) ?? '')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('crm.field_key_aliases')
      .values({
        business_id: own.context.businessId ?? '',
        object_type_id: stored.object_type_id,
        field_id: stored.id,
        alias_key: 'old_preference',
      })
      .execute();
    await trx
      .updateTable('tenancy.businesses')
      .set({ address: JSON.stringify({ country: 'KE' }) })
      .where('id', '=', own.context.businessId ?? '')
      .execute();
  });
  const context = await withTenant(db, own.context, (trx) =>
    readFieldNormalizationContext(trx, own),
  );
  expect(context.definitions.map((field) => ({ id: field.id, key: field.key }))).toEqual([
    { id: contact.id, key: 'preference' },
  ]);
  expect(context.aliases).toEqual([{ fieldId: contact.id, key: 'old_preference' }]);
  expect(context.country).toBe('KE');
});
