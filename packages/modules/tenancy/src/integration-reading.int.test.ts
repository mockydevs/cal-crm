// How Settings → Integrations reads a business's API keys and installed apps, against real
// Postgres as the app's role. The rows are written as crm_owner, so each case can put a key
// or an install in exactly the state it needs.
import { randomBytes } from 'node:crypto';

import { noIntegrationReading } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { readAppsIntegration } from './index.js';

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

type Business = Awaited<ReturnType<TestDatabase['fixtures']['business']>>;

async function business(agencyId?: string): Promise<Business> {
  const agency = agencyId ?? (await database.fixtures.agency()).id;
  return database.fixtures.business(agency);
}

const read = (place: Business) =>
  withTenant(db, place.context, (trx) => readAppsIntegration(trx, place.id));

interface Key {
  readonly revoked?: boolean;
  readonly expiresAt?: Date;
  /** The agency's own key, made at agency level. */
  readonly agency?: boolean;
}

/** An API key someone made in Settings, as making one stores it. */
const apiKey = (place: Business, key: Key = {}) =>
  database.as('crm_owner', (sql) =>
    sql.query(
      `insert into tenancy.api_keys
         (agency_id, business_id, name, key_prefix, key_hash, scopes, expires_at, revoked_at)
       values ($1, $2, 'Zapier', $3, $4, '{contacts.read}', $5, $6)`,
      [
        place.agencyId,
        key.agency === true ? null : place.id,
        `crm_${randomBytes(6).toString('hex')}`,
        randomBytes(32),
        key.expiresAt ?? null,
        key.revoked === true ? new Date() : null,
      ],
    ),
  );

/** An app of the agency installed in the business, with the key installing it makes. */
const install = (place: Business, options: { uninstalled?: boolean } = {}) =>
  database.as('crm_owner', async (sql) => {
    const person = await sql.one<{ id: string }>('select uuidv7() as id');
    const app = await sql.one<{ id: string }>(
      `insert into tenancy.marketplace_apps (agency_id, name, developer, status, created_by)
       values ($1, 'Booking sync', 'Acme', 'listed', $2) returning id`,
      [place.agencyId, person.id],
    );
    const installed = await sql.one<{ id: string }>(
      `insert into tenancy.marketplace_installs
         (business_id, agency_id, app_id, granted_scopes, installed_by, uninstalled_by, uninstalled_at)
       values ($1, $2, $3, '{}', $4, $5, $6) returning id`,
      [
        place.id,
        place.agencyId,
        app.id,
        person.id,
        options.uninstalled === true ? person.id : null,
        options.uninstalled === true ? new Date(Date.now() + 1000) : null,
      ],
    );
    await sql.query(
      `insert into tenancy.api_keys
         (agency_id, business_id, name, scopes, read_groups, marketplace_install_id, revoked_at)
       values ($1, $2, 'Booking sync', '{}', '{}', $3, $4)`,
      [
        place.agencyId,
        place.id,
        installed.id,
        options.uninstalled === true ? new Date(Date.now() + 1000) : null,
      ],
    );
  });

it('reads nothing when the business has no key or app', async () => {
  expect(await read(await business())).toEqual(noIntegrationReading);
});

it('counts one key that works, naming nothing', async () => {
  const place = await business();
  await apiKey(place, { expiresAt: new Date(Date.now() + 86_400_000) });
  expect(await read(place)).toEqual({ connected: 1, attention: 0, label: null });
});

it('counts an installed app once, not again for the key installing it made', async () => {
  const place = await business();
  await install(place);
  expect(await read(place)).toEqual({ connected: 1, attention: 0, label: null });
});

it('leaves out revoked and expired keys, and uninstalled apps', async () => {
  const place = await business();
  await apiKey(place, { revoked: true });
  await apiKey(place, { expiresAt: new Date(Date.now() - 1000) });
  await install(place, { uninstalled: true });
  expect(await read(place)).toEqual(noIntegrationReading);
});

it('counts several keys and apps together', async () => {
  const place = await business();
  await apiKey(place);
  await apiKey(place);
  await install(place);
  expect(await read(place)).toEqual({ connected: 3, attention: 0, label: null });
});

it('never counts another business’s keys and apps, or the agency’s own keys', async () => {
  const ours = await business();
  const sibling = await business(ours.agencyId);
  await apiKey(sibling);
  await install(sibling);
  await apiKey(ours, { agency: true });
  expect(await read(ours)).toEqual(noIntegrationReading);
});
