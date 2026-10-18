import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { twoFactorRequirement } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { tenancyRoutes } from '../index.js';

let database: TestDatabase;
let db: Database;
let services: Services;

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

function route(operationId: string) {
  const found = tenancyRoutes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`No route for ${operationId}.`);
  return found;
}

/** Agency staff of a new agency, outside any business. */
async function atTheAgency(): Promise<Invocation> {
  const agency = await database.fixtures.agency();
  const user = await database.fixtures.user();
  return {
    context: {
      agencyId: agency.id,
      userId: user.id,
      actorKind: 'user',
      actorId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
}

const read = async (invocation: Invocation) =>
  twoFactorRequirement.parse(
    await route('getTwoFactorRequirement').run(
      { invocation, params: {}, query: {}, body: undefined },
      services,
    ),
  );

const set = async (invocation: Invocation, body: unknown) =>
  route('setTwoFactorRequirement').run({ invocation, params: {}, query: {}, body }, services);

describe('the agency’s two-factor requirement', () => {
  it('is off for a new agency; agency staff turn it on and off, and each change is recorded', async () => {
    const invocation = await atTheAgency();

    expect(await read(invocation)).toEqual({ required: false });
    expect(await set(invocation, { required: true })).toEqual({ required: true });
    expect(await read(invocation)).toEqual({ required: true });
    expect(await set(invocation, { required: false })).toEqual({ required: false });

    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ type: string; payload: unknown; business_id: string | null }>(
        `select type, payload, business_id from events.events
         where agency_id = $1 order by occurred_at, recorded_at`,
        [invocation.context.agencyId],
      ),
    );
    expect(events).toEqual([
      {
        type: 'agency.two_factor_requirement_changed',
        payload: { required: true },
        business_id: null,
      },
      {
        type: 'agency.two_factor_requirement_changed',
        payload: { required: false },
        business_id: null,
      },
    ]);
  });

  it('is changed only from the agency, not from inside one of its businesses', async () => {
    const invocation = await atTheAgency();
    const business = await database.fixtures.business(invocation.context.agencyId);
    const inBusiness: Invocation = {
      context: { ...invocation.context, businessId: business.id },
      permissions: 'all',
    };

    await expect(set(inBusiness, { required: true })).rejects.toThrow(ForbiddenError);
    await expect(read(inBusiness)).rejects.toThrow(ForbiddenError);
    expect(await read(invocation)).toEqual({ required: false });
  });

  it("leaves other agencies' requirements alone", async () => {
    const ours = await atTheAgency();
    const theirs = await atTheAgency();

    await set(ours, { required: true });

    expect(await read(theirs)).toEqual({ required: false });
  });
});
