// How Settings → Integrations reads a business's Google Calendar connections, against real
// Postgres as the app's role. The rows are written as crm_owner, so each case can put a
// connection in exactly the state it needs without going through Google.
import { randomBytes } from 'node:crypto';

import { noIntegrationReading } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { readGoogleCalendarIntegration } from '../index.js';

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

async function business(): Promise<Business> {
  const agency = await database.fixtures.agency();
  return database.fixtures.business(agency.id);
}

const read = (place: Business) =>
  withTenant(db, place.context, (trx) => readGoogleCalendarIntegration(trx, place.id));

interface Connection {
  readonly status: 'connecting' | 'connected' | 'disconnected';
  readonly reason?: 'member' | 'expired_or_revoked' | 'membership_ended';
  readonly checkedAt?: Date;
  readonly failedAt?: Date;
  readonly email?: string;
}

/** A member's connection in the business, with a sealed token unless it is disconnected. */
async function connect(place: Business, connection: Connection): Promise<void> {
  const user = await database.fixtures.user();
  await database.as('crm_owner', async (sql) => {
    const secret =
      connection.status === 'disconnected'
        ? null
        : await sql.one<{ id: string }>(
            `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
             values ($1, $2, 'calendar.google.refresh_token', 1, $3, $4) returning id`,
            [place.agencyId, place.id, randomBytes(32), randomBytes(48)],
          );
    await sql.query(
      `insert into calendar.google_connections
         (business_id, user_id, status, disconnected_reason, google_sub, google_email, secret_id,
          busy_checked_at, busy_failed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        place.id,
        user.id,
        connection.status,
        connection.reason ?? null,
        `sub-${user.id}`,
        connection.email ?? user.email,
        secret?.id ?? null,
        connection.checkedAt ?? null,
        connection.failedAt ?? null,
      ],
    );
  });
}

const earlier = new Date('2026-10-18T08:00:00.000Z');
const later = new Date('2026-10-18T09:00:00.000Z');

it('reads nothing when no member has connected Google', async () => {
  expect(await read(await business())).toEqual(noIntegrationReading);
});

it('names the one account that works', async () => {
  const place = await business();
  await connect(place, { status: 'connected', checkedAt: later, email: 'host@example.com' });
  expect(await read(place)).toEqual({ connected: 1, attention: 0, label: 'host@example.com' });
});

it('counts a connection whose busy time has failed since it last worked as needing attention', async () => {
  const place = await business();
  await connect(place, {
    status: 'connected',
    checkedAt: earlier,
    failedAt: later,
    email: 'failing@example.com',
  });
  expect(await read(place)).toEqual({ connected: 0, attention: 1, label: 'failing@example.com' });
});

it('counts a connection that has never read busy time but has failed as needing attention', async () => {
  const place = await business();
  await connect(place, { status: 'connected', failedAt: later });
  expect(await read(place)).toMatchObject({ connected: 0, attention: 1 });
});

it('counts a connection that worked again after failing as working', async () => {
  const place = await business();
  await connect(place, { status: 'connected', checkedAt: later, failedAt: earlier });
  expect(await read(place)).toMatchObject({ connected: 1, attention: 0 });
});

it('counts a token Google refused as needing attention, without naming it', async () => {
  const place = await business();
  await connect(place, { status: 'disconnected', reason: 'expired_or_revoked' });
  expect(await read(place)).toEqual({ connected: 0, attention: 1, label: null });
});

it('leaves out connections a member ended, and ones still being set up', async () => {
  const place = await business();
  await connect(place, { status: 'disconnected', reason: 'member' });
  await connect(place, { status: 'disconnected', reason: 'membership_ended' });
  await connect(place, { status: 'connecting', email: 'new@example.com' });
  expect(await read(place)).toEqual({ connected: 0, attention: 0, label: 'new@example.com' });
});

it('names no account when there are several', async () => {
  const place = await business();
  await connect(place, { status: 'connected', checkedAt: later });
  await connect(place, { status: 'connected', checkedAt: later });
  await connect(place, { status: 'connected', failedAt: later });
  await connect(place, { status: 'disconnected', reason: 'expired_or_revoked' });
  expect(await read(place)).toEqual({ connected: 2, attention: 2, label: null });
});

it('never counts another business’s connections', async () => {
  const ours = await business();
  const theirs = await business();
  await connect(theirs, { status: 'connected', checkedAt: later });
  await connect(theirs, { status: 'disconnected', reason: 'expired_or_revoked' });
  expect(await read(ours)).toEqual(noIntegrationReading);
  await connect(ours, { status: 'connected', checkedAt: later, email: 'ours@example.com' });
  expect(await read(ours)).toEqual({ connected: 1, attention: 0, label: 'ours@example.com' });
});
