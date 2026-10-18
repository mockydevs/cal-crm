import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { business } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ForbiddenError, parsePublicId, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { businessRoutes, slugFrom, type BusinessSeeder } from '../index.js';

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

/**
 * A seeder that writes a row only the new business may hold: crm.settings, under row-level
 * security, so it succeeds only with the transaction acting in that business.
 */
const settingsSeeder: BusinessSeeder = async (trx, businessId) => {
  await trx.insertInto('crm.settings').values({ business_id: businessId }).execute();
};

function create(invocation: Invocation, body: unknown, seeders: readonly BusinessSeeder[] = []) {
  const [route] = businessRoutes({ seeders });
  if (route === undefined) throw new Error('No route.');
  return route.run({ invocation, params: {}, query: {}, body }, services);
}

const owner = <Row extends object>(text: string, values: unknown[]) =>
  database.as('crm_owner', (each) => each.query<Row>(text, values));

const harbor = { name: 'Harbor Lights Events', timezone: 'America/New_York', currency: 'USD' };

describe('POST /businesses (business.create)', () => {
  it('creates a business in the agency, and answers with it', async () => {
    const invocation = await atTheAgency();

    const created = business.parse(await create(invocation, harbor));

    expect(created).toMatchObject({
      name: 'Harbor Lights Events',
      slug: 'harbor-lights-events',
      status: 'active',
      timezone: 'America/New_York',
      currency: 'USD',
      locale: 'en',
    });
    const [row] = await owner<{ agency_id: string }>(
      'select agency_id from tenancy.businesses where id = $1',
      [parsePublicId('business', created.id)],
    );
    expect(row?.agency_id).toBe(invocation.context.agencyId);
  });

  it('runs the seeders acting in the new business, then goes back to the agency', async () => {
    const invocation = await atTheAgency();
    const seen: string[] = [];
    const contextOf: BusinessSeeder = async (trx, businessId) => {
      const { rows } = await sql<{
        business: string;
      }>`select app.business_id()::text as business`.execute(trx);
      seen.push(rows[0]?.business ?? '', businessId);
    };

    const created = business.parse(await create(invocation, harbor, [settingsSeeder, contextOf]));

    const id = parsePublicId('business', created.id);
    expect(seen).toEqual([id, id]);
    expect(
      await owner('select business_id from crm.settings where business_id = $1', [id]),
    ).toHaveLength(1);
    const [event] = await owner<{ business_id: string | null; type: string }>(
      'select business_id, type from events.events where subject_id = $1',
      [id],
    );
    expect(event).toEqual({ business_id: null, type: 'business.created' });
  });

  it('keeps nothing when a seeder fails', async () => {
    const invocation = await atTheAgency();
    const failing: BusinessSeeder = () => Promise.reject(new Error('the seeder broke'));

    await expect(create(invocation, harbor, [failing])).rejects.toThrow('the seeder broke');

    expect(
      await owner('select id from tenancy.businesses where agency_id = $1', [
        invocation.context.agencyId,
      ]),
    ).toEqual([]);
  });

  it('gives each business of the agency an address of its own', async () => {
    const invocation = await atTheAgency();

    const first = business.parse(await create(invocation, harbor));
    const second = business.parse(await create(invocation, harbor));

    expect([first.slug, second.slug]).toEqual(['harbor-lights-events', 'harbor-lights-events-2']);
  });

  it('gives businesses made at the same moment, with one name, an address each', async () => {
    const invocation = await atTheAgency();

    const made = await Promise.all([1, 2, 3, 4].map(() => create(invocation, harbor)));

    expect(made.map((each) => business.parse(each).slug).sort()).toEqual([
      'harbor-lights-events',
      'harbor-lights-events-2',
      'harbor-lights-events-3',
      'harbor-lights-events-4',
    ]);
  });

  it('refuses an address another business of the agency has', async () => {
    const invocation = await atTheAgency();
    await create(invocation, { ...harbor, slug: 'harbor' });

    await expect(create(invocation, { ...harbor, slug: 'harbor' })).rejects.toMatchObject({
      issues: [{ path: '/slug', code: 'taken' }],
    });
  });

  it('refuses a time zone or currency that does not exist, naming each field', async () => {
    const invocation = await atTheAgency();

    const refused = create(invocation, { name: 'X', timezone: 'Mars/Olympus', currency: 'XYZ' });

    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toMatchObject({
      issues: [{ path: '/timezone' }, { path: '/currency' }],
    });
  });

  it('is for agency staff at the agency, not inside a business', async () => {
    const invocation = await atTheAgency();
    const inside = await database.fixtures.business(invocation.context.agencyId);

    await expect(
      create(
        { context: { ...invocation.context, businessId: inside.id }, permissions: 'all' },
        harbor,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('slugFrom', () => {
  it.each([
    ['Harbor Lights Events', 'harbor-lights-events'],
    ['  Café  Olé!  ', 'cafe-ole'],
    ['Smith & Sons, Ltd.', 'smith-sons-ltd'],
    ['🙂', 'business'],
    ['a'.repeat(80), 'a'.repeat(63)],
  ])('makes %j into %j', (name, slug) => {
    expect(slugFrom(name)).toBe(slug);
  });
});
