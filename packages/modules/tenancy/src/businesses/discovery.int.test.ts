import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { listBusinesses } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { businessRoutes } from './routes.js';

let database: TestDatabase;
let db: Database;
let services: Services;
const route = businessRoutes({ seeders: [] }).find(
  (item) => item.endpoint.operationId === 'listBusinesses',
);
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function discover(context: TenantContext, query: unknown = {}) {
  if (route === undefined) throw new Error('The native business discovery route is missing.');
  const invocation: Invocation = { context, permissions: new Set() };
  return listBusinesses.response.schema.parse(
    await route.run({ invocation, params: {}, query, body: undefined }, services),
  );
}

async function accounts() {
  const agency = await database.fixtures.agency();
  const first = await database.fixtures.business(agency.id);
  const second = await database.fixtures.business(agency.id);
  const closed = await database.fixtures.business(agency.id);
  await database.as('crm_owner', (sql) =>
    sql.query("update tenancy.businesses set status='suspended' where id=$1", [closed.id]),
  );
  const foreign = await database.fixtures.business((await database.fixtures.agency()).id);
  const context: TenantContext = {
    agencyId: agency.id,
    actorKind: 'api_key',
    actorId: randomUUID(),
    correlationId: randomUUID(),
  };
  return { first, second, closed, foreign, context };
}

it('discovers only active businesses in the key agency, with bounded stable pagination', async () => {
  const world = await accounts();
  const page = await discover(world.context, { limit: 1 });
  expect(page.items).toHaveLength(1);
  expect(page.next).toBe(page.items[0]?.id);
  const next = await discover(world.context, { limit: 1, after: page.next });
  expect(next.items).toHaveLength(1);
  expect(next.next).toBeNull();
  expect([...page.items, ...next.items].map((item) => item.id).sort()).toEqual(
    [world.first.id, world.second.id].map((id) => toPublicId('business', id)).sort(),
  );
});

it('a business-bound key discovers its own business only, and never expands scope from a cursor', async () => {
  const world = await accounts();
  const own = { ...world.context, businessId: world.first.id };
  expect((await discover(own)).items.map((item) => item.id)).toEqual([
    toPublicId('business', world.first.id),
  ]);
  const afterForeign = await discover(own, { after: toPublicId('business', world.foreign.id) });
  expect(
    afterForeign.items.every((item) => item.id === toPublicId('business', world.first.id)),
  ).toBe(true);
  await expect(discover(world.context, { limit: 101 })).rejects.toThrow();
});
