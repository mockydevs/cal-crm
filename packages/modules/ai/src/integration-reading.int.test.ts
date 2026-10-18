// How Settings → Integrations reads the AI model connections a business may use, against
// real Postgres as the app's role. The rows are written as crm_owner, so each case can put
// a key in exactly the state it needs without calling a provider.
import { randomBytes } from 'node:crypto';

import { noIntegrationReading } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { AI_KEY_PURPOSE } from './gateway.js';
import { readAiModelsIntegration } from './index.js';

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
  withTenant(db, place.context, (trx) => readAiModelsIntegration(trx, place.id));

interface Key {
  readonly provider?: 'anthropic' | 'openai' | 'gemini';
  readonly status?: 'untested' | 'working' | 'failing';
  readonly label?: string;
  /** The agency's shared key, which every business of the agency may use. */
  readonly shared?: boolean;
}

/** A provider key, sealed as connecting stores it, with the result of its last test. */
const addKey = (place: Business, key: Key = {}) =>
  database.as('crm_owner', async (sql) => {
    const businessId = key.shared === true ? null : place.id;
    const status = key.status ?? 'working';
    const sealed = await sql.one<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, $3, 1, $4, $5) returning id`,
      [place.agencyId, businessId, AI_KEY_PURPOSE, randomBytes(32), randomBytes(48)],
    );
    await sql.query(
      `insert into ai.provider_keys
         (agency_id, business_id, provider, label, secret_id, key_last4, status, last_tested_at,
          last_test_outcome)
       values ($1, $2, $3, $4, $5, 'abcd', $6, $7, $8)`,
      [
        place.agencyId,
        businessId,
        key.provider ?? 'anthropic',
        key.label ?? '',
        sealed.id,
        status,
        status === 'untested' ? null : new Date(),
        status === 'untested' ? null : status === 'working' ? 'ok' : 'authentication',
      ],
    );
  });

it('reads nothing when no key is connected', async () => {
  expect(await read(await business())).toEqual(noIntegrationReading);
});

it('names the one working key by its label', async () => {
  const place = await business();
  await addKey(place, { label: 'Main Claude key' });
  expect(await read(place)).toEqual({ connected: 1, attention: 0, label: 'Main Claude key' });
});

it('counts a key that has not been tested yet as usable, with no name when it has none', async () => {
  const place = await business();
  await addKey(place, { status: 'untested' });
  expect(await read(place)).toEqual({ connected: 1, attention: 0, label: null });
});

it('counts a key whose last test failed as needing attention', async () => {
  const place = await business();
  await addKey(place, { status: 'failing', label: 'Old key' });
  expect(await read(place)).toEqual({ connected: 0, attention: 1, label: 'Old key' });
});

it('counts the agency’s shared keys with the business’s own, naming none of several', async () => {
  const place = await business();
  await addKey(place, { label: 'Ours' });
  await addKey(place, { provider: 'openai', shared: true, label: 'Agency OpenAI' });
  await addKey(place, { provider: 'anthropic', shared: true, status: 'failing', label: 'Agency' });
  expect(await read(place)).toEqual({ connected: 2, attention: 1, label: null });
});

it('leaves out providers the AI models page does not offer', async () => {
  const place = await business();
  await addKey(place, { provider: 'gemini', label: 'Gemini' });
  expect(await read(place)).toEqual(noIntegrationReading);
});

it('never counts another business’s keys, or another agency’s shared ones', async () => {
  const ours = await business();
  const sibling = await business(ours.agencyId);
  const elsewhere = await business();
  await addKey(sibling, { label: 'Sibling' });
  await addKey(sibling, { status: 'failing', provider: 'openai' });
  await addKey(elsewhere, { shared: true, label: 'Other agency' });
  expect(await read(ours)).toEqual(noIntegrationReading);
});
