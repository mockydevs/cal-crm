// How Settings → Integrations reads a business's mailboxes, Twilio accounts and Emailable
// key, against real Postgres as the app's role. The rows are written as crm_owner, so each
// case can put a connection in exactly the state it needs without reaching a provider.
import { randomBytes, randomUUID } from 'node:crypto';

import { noIntegrationReading } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  readEmailableIntegration,
  readMailboxIntegration,
  readTwilioIntegration,
} from './index.js';

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
type Status = 'connected' | 'failing' | 'disconnected';

async function business(): Promise<Business> {
  const agency = await database.fixtures.agency();
  return database.fixtures.business(agency.id);
}

/** A sealed secret of the business, as connecting stores one. */
const secret = (sql: Sql, place: Business, purpose: string) =>
  sql.one<{ id: string }>(
    `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
     values ($1, $2, $3, 1, $4, $5) returning id`,
    [place.agencyId, place.id, purpose, randomBytes(32), randomBytes(48)],
  );

describe('mailboxes', () => {
  const read = (place: Business) =>
    withTenant(db, place.context, (trx) => readMailboxIntegration(trx, place.id));

  /** A mailbox in the business, its channel account in the given state. */
  const mailbox = (
    place: Business,
    status: 'active' | 'paused' | 'failing' | 'disconnected',
    email = `box-${randomUUID().slice(0, 8)}@example.com`,
  ) =>
    database.as('crm_owner', async (sql) => {
      const sealed = await secret(sql, place, 'email.mailbox.password');
      const account = await sql.one<{ id: string }>(
        `insert into messaging.channel_accounts (business_id, channel, name, status)
         values ($1, 'email', 'Mailbox', $2) returning id`,
        [place.id, status],
      );
      await sql.query(
        `insert into messaging.mailboxes
           (business_id, id, email_address, auth_method, smtp_host, smtp_port, smtp_security,
            smtp_username, secret_id)
         values ($1, $2, $3, 'password', 'localhost', 1025, 'none', 'fixture', $4)`,
        [place.id, account.id, email, sealed.id],
      );
    });

  it('reads nothing when the business has no mailbox', async () => {
    expect(await read(await business())).toEqual(noIntegrationReading);
  });

  it('names the one mailbox that works', async () => {
    const place = await business();
    await mailbox(place, 'active', 'hello@example.com');
    expect(await read(place)).toEqual({ connected: 1, attention: 0, label: 'hello@example.com' });
  });

  it('counts a failing mailbox as needing attention', async () => {
    const place = await business();
    await mailbox(place, 'failing', 'broken@example.com');
    expect(await read(place)).toEqual({ connected: 0, attention: 1, label: 'broken@example.com' });
  });

  it('leaves out paused and disconnected mailboxes', async () => {
    const place = await business();
    await mailbox(place, 'paused');
    await mailbox(place, 'disconnected');
    expect(await read(place)).toEqual(noIntegrationReading);
  });

  it('names no mailbox when there are several', async () => {
    const place = await business();
    await mailbox(place, 'active');
    await mailbox(place, 'active');
    await mailbox(place, 'failing');
    expect(await read(place)).toEqual({ connected: 2, attention: 1, label: null });
  });

  it('never counts another business’s mailboxes', async () => {
    const ours = await business();
    const theirs = await business();
    await mailbox(theirs, 'active');
    await mailbox(theirs, 'failing');
    expect(await read(ours)).toEqual(noIntegrationReading);
  });
});

/** A provider account connected by the business (or, with `shared`, by its agency). */
const providerConnection = (
  place: Business,
  provider: 'twilio' | 'emailable',
  status: Status,
  label: string,
  options: { shared?: boolean } = {},
) =>
  database.as('crm_owner', async (sql) => {
    const businessId = options.shared === true ? null : place.id;
    const sealed = await sql.one<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'messaging.provider.credentials', 1, $3, $4) returning id`,
      [place.agencyId, businessId, randomBytes(32), randomBytes(48)],
    );
    const accountRef =
      provider === 'twilio' ? `AC${randomBytes(16).toString('hex')}` : 'verification';
    await sql.query(
      `insert into messaging.provider_connections
         (agency_id, business_id, provider, label, account_ref, secret_id, status)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [place.agencyId, businessId, provider, label, accountRef, sealed.id, status],
    );
  });

describe('Twilio', () => {
  const read = (place: Business) =>
    withTenant(db, place.context, (trx) => readTwilioIntegration(trx, place.id));

  it('reads nothing when the business has not connected Twilio', async () => {
    expect(await read(await business())).toEqual(noIntegrationReading);
  });

  it('names the one account that works', async () => {
    const place = await business();
    await providerConnection(place, 'twilio', 'connected', 'Front desk');
    expect(await read(place)).toEqual({ connected: 1, attention: 0, label: 'Front desk' });
  });

  it('counts a failing account as needing attention, and leaves out disconnected ones', async () => {
    const place = await business();
    await providerConnection(place, 'twilio', 'failing', 'Sales line');
    await providerConnection(place, 'twilio', 'disconnected', 'Old line');
    expect(await read(place)).toEqual({ connected: 0, attention: 1, label: 'Sales line' });
  });

  it('names no account when there are several', async () => {
    const place = await business();
    await providerConnection(place, 'twilio', 'connected', 'Front desk');
    await providerConnection(place, 'twilio', 'connected', 'Sales line');
    await providerConnection(place, 'twilio', 'failing', 'Support line');
    expect(await read(place)).toEqual({ connected: 2, attention: 1, label: null });
  });

  it('never counts another business’s accounts, the agency’s, or Emailable', async () => {
    const ours = await business();
    const theirs = await business();
    await providerConnection(theirs, 'twilio', 'connected', 'Their line');
    await providerConnection(theirs, 'twilio', 'failing', 'Their other line');
    await providerConnection(ours, 'twilio', 'connected', 'Agency line', { shared: true });
    await providerConnection(ours, 'emailable', 'connected', 'Checks');
    expect(await read(ours)).toEqual(noIntegrationReading);
  });
});

describe('Emailable', () => {
  const read = (place: Business) =>
    withTenant(db, place.context, (trx) => readEmailableIntegration(trx, place.id));

  it('reads nothing when the business has no Emailable key', async () => {
    expect(await read(await business())).toEqual(noIntegrationReading);
  });

  it('names the key that works', async () => {
    const place = await business();
    await providerConnection(place, 'emailable', 'connected', 'Checks');
    expect(await read(place)).toEqual({ connected: 1, attention: 0, label: 'Checks' });
  });

  it('counts a refused key as needing attention', async () => {
    const place = await business();
    await providerConnection(place, 'emailable', 'failing', 'Checks');
    expect(await read(place)).toEqual({ connected: 0, attention: 1, label: 'Checks' });
  });

  it('leaves out a disconnected key', async () => {
    const place = await business();
    await providerConnection(place, 'emailable', 'disconnected', 'Checks');
    expect(await read(place)).toEqual(noIntegrationReading);
  });

  it('never counts another business’s key, or Twilio', async () => {
    const ours = await business();
    const theirs = await business();
    await providerConnection(theirs, 'emailable', 'connected', 'Their checks');
    await providerConnection(ours, 'twilio', 'connected', 'Front desk');
    expect(await read(ours)).toEqual(noIntegrationReading);
  });
});
