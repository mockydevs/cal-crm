import { randomUUID } from 'node:crypto';
import { runCommand } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, ForbiddenError, NotFoundError, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { readContactDetails } from '@repo/module-crm';
import { readContactAddressBlocks } from './address-blocks.js';
import {
  emailAddressCommands,
  readContactEmailVerifications,
  readEmailVerification,
} from './email-verification.js';
import { createEmailVerificationRoutes } from './email-verification-routes.js';
import {
  createTestEmailVerificationProviderTask,
  createVerifyEmailAddressTask,
} from './email-verification-task.js';
import { fixtureResolver } from '@repo/mail-checks/testing';
import { createVault, newSecretsKey, parseSecretsKeys } from '@repo/module-vault';

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

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context, {
    email: 'person@example.com',
  });
  const identity = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>('select id from crm.contact_identities where contact_id=$1', [
      contact.id,
    ]),
  );
  const input = {
    contactId: toPublicId('contact', contact.id),
    addressId: toPublicId('contact_identity', identity.id),
  };
  const invocation = {
    context: { ...business.context, correlationId: randomUUID() },
    permissions: 'all' as const,
  };
  const services = { db, authorize: () => true };
  return { business, contact, identity, input, invocation, services };
}

it('queues a private verification job and refuses an excluded or foreign address', async () => {
  const f = await fixture();
  expect(
    await runCommand(f.services, emailAddressCommands.verify, f.input, f.invocation),
  ).toMatchObject({ pending: true, status: 'unchecked' });
  const jobs = await database.runJobs(['messaging.verify_address']);
  expect(jobs).toHaveLength(1);
  expect(JSON.stringify(jobs)).not.toContain('person@example.com');
  await runCommand(f.services, emailAddressCommands.exclude, f.input, f.invocation);
  await expect(
    runCommand(f.services, emailAddressCommands.verify, f.input, f.invocation),
  ).rejects.toBeInstanceOf(ValidationError);
  const other = await fixture();
  await expect(
    runCommand(f.services, emailAddressCommands.verify, other.input, f.invocation),
  ).rejects.toBeInstanceOf(NotFoundError);
});

it('never lifts complaint or unsubscribe; hard bounce needs permission and confirmation', async () => {
  for (const reason of ['manual', 'invalid', 'hard_bounce', 'complaint', 'unsubscribe']) {
    const f = await fixture();
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        "insert into messaging.suppressions (business_id,channel,address_normalized,reason) values (app.business_id(),'email','person@example.com',$1)",
        [reason],
      ),
    );
    const command = () =>
      runCommand(f.services, emailAddressCommands.unblock, f.input, f.invocation);
    const live = async () =>
      (
        await database.withTenant(f.business.context, (sql) =>
          sql.one<{ live: boolean }>(
            'select expires_at is null or expires_at>now() as live from messaging.suppressions',
          ),
        )
      ).live;
    if (reason === 'complaint' || reason === 'unsubscribe')
      await expect(command()).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: 'consent_required' })],
      });
    else if (reason === 'hard_bounce') {
      await expect(command()).rejects.toBeInstanceOf(ValidationError);
      await expect(
        runCommand(
          f.services,
          emailAddressCommands.unblock,
          { ...f.input, confirm: 'unblock' },
          { ...f.invocation, permissions: new Set(['contacts.manage'] as const) },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await runCommand(
        f.services,
        emailAddressCommands.unblock,
        { ...f.input, confirm: 'unblock' },
        f.invocation,
      );
    } else await command();
    expect(await live()).toBe(reason === 'complaint' || reason === 'unsubscribe');
  }
});

it('a manual block replaces a verification suppression and survives a later valid result', async () => {
  const f = await fixture();
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      "insert into messaging.suppressions (business_id,channel,address_normalized,reason,detail) values (app.business_id(),'email','person@example.com','invalid','verification:mailbox_not_found')",
    ),
  );
  await runCommand(
    f.services,
    emailAddressCommands.block,
    { ...f.input, reason: 'Asked us to stop' },
    f.invocation,
  );
  const row = () =>
    database.withTenant(f.business.context, (sql) =>
      sql.one<{ reason: string; detail: string | null; live: boolean }>(
        'select reason,detail,expires_at is null or expires_at>now() as live from messaging.suppressions',
      ),
    );
  expect(await row()).toEqual({ reason: 'manual', detail: 'Asked us to stop', live: true });
  await runCommand(f.services, emailAddressCommands.verify, f.input, f.invocation);
  const { id, current_check_id: checkId } = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string; current_check_id: string }>(
      'select id,current_check_id from messaging.email_verifications',
    ),
  );
  await createVerifyEmailAddressTask({
    resolve: fixtureResolver({
      'example.com': { MX: [{ exchange: 'mail.example.com', priority: 10 }] },
    }),
  }).run({ verificationId: id, checkId }, { invocation: f.invocation, services: f.services });
  expect(await row()).toEqual({ reason: 'manual', detail: 'Asked us to stop', live: true });
});

it('refuses a key the provider does not confirm and stores nothing', async () => {
  const f = await fixture();
  const vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  const routes = createEmailVerificationRoutes({
    vault,
    provider: () => ({
      name: 'emailable',
      verify: () =>
        Promise.resolve({
          kind: 'failed' as const,
          problem: 'unauthorized' as const,
          connectionFailing: true,
        }),
      account: () =>
        Promise.resolve({
          kind: 'failed' as const,
          problem: 'unauthorized' as const,
          connectionFailing: true,
        }),
    }),
  });
  const route = routes.find(
    (each) => each.endpoint.operationId === 'connectEmailVerificationProvider',
  );
  await expect(
    route?.run(
      { invocation: f.invocation, params: {}, query: {}, body: { apiKey: 'test_refused_key' } },
      f.services,
    ),
  ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'connection_failed' })] });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query<{ n: number }>(
        "select count(*)::integer as n from messaging.provider_connections where provider='emailable'",
      ),
    ),
  ).toEqual([{ n: 0 }]);
});

it('shows verification beside delivery on contact details, and null for a phone', async () => {
  const f = await fixture();
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      "insert into crm.contact_identities (business_id,contact_id,kind,value,value_normalized,is_primary) values (app.business_id(),$1,'phone','+12025550123','+12025550123',true)",
      [f.contact.id],
    ),
  );
  await runCommand(f.services, emailAddressCommands.exclude, f.input, f.invocation);
  const details = await withTenant(db, f.business.context, (trx) =>
    readContactDetails(trx, f.invocation, toPublicId('contact', f.contact.id), {
      actorNames: {},
      assignees: {
        resolve: () => Promise.resolve(null),
        memberships: () => Promise.resolve(new Map()),
      },
      blockedAddresses: readContactAddressBlocks,
      addressVerifications: readContactEmailVerifications,
    }),
  );
  const byKind = (kind: string) => details.addresses.find((address) => address.kind === kind);
  expect(byKind('email')).toMatchObject({
    delivery: { status: 'unchecked' },
    verification: { status: 'unchecked', excluded: true, depth: null, checkedAt: null },
  });
  expect(byKind('phone')).toHaveProperty('verification', null);
});

it('blocking never replaces a consent suppression and excluding preserves the result', async () => {
  const f = await fixture();
  await runCommand(
    f.services,
    emailAddressCommands.block,
    { ...f.input, reason: 'Requested' },
    f.invocation,
  );
  const rows = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ reason: string }>(
      "select reason from messaging.suppressions where address_normalized='person@example.com'",
    ),
  );
  expect(rows).toEqual([{ reason: 'manual' }]);
  await runCommand(f.services, emailAddressCommands.exclude, f.input, f.invocation);
  expect(
    await withTenant(db, f.business.context, (trx) =>
      readEmailVerification(trx, 'person@example.com'),
    ),
  ).toMatchObject({ excluded: true, status: 'unchecked' });
  await runCommand(f.services, emailAddressCommands.include, f.input, f.invocation);
  expect(
    await withTenant(db, f.business.context, (trx) =>
      readEmailVerification(trx, 'person@example.com'),
    ),
  ).toHaveProperty('excluded', false);
});

it('connects, tests and disconnects a provider through the vault without echoing its key', async () => {
  const f = await fixture();
  const vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  let credits = 21;
  const provider = {
    name: 'emailable',
    verify: () =>
      Promise.resolve({
        kind: 'failed' as const,
        problem: 'unavailable' as const,
        connectionFailing: false,
      }),
    account: () =>
      Promise.resolve({ kind: 'ok' as const, availableCredits: credits, testMode: true }),
  };
  const routes = createEmailVerificationRoutes({ vault, provider: () => provider });
  const invoke = async (operationId: string, body: unknown = {}) => {
    const route = routes.find((route) => route.endpoint.operationId === operationId);
    if (route === undefined) throw new Error('Missing provider route.');
    return route.run({ invocation: f.invocation, params: {}, query: {}, body }, f.services);
  };
  const connected = await invoke('connectEmailVerificationProvider', {
    apiKey: 'test_only_ephemeral_key',
  });
  expect(connected).toMatchObject({ provider: 'connected', availableCredits: 21, testMode: true });
  expect(JSON.stringify(connected)).not.toContain('test_only_ephemeral_key');
  expect(
    JSON.stringify(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select input from audit.commands'),
      ),
    ),
  ).not.toContain('test_only_ephemeral_key');
  credits = 19;
  await invoke('testEmailVerificationProvider');
  await createTestEmailVerificationProviderTask(vault, () => provider).run(
    {},
    { invocation: f.invocation, services: f.services },
  );
  expect(await invoke('getEmailVerificationSettings')).toMatchObject({
    provider: 'connected',
    availableCredits: 19,
    testMode: true,
  });
  expect(await invoke('disconnectEmailVerificationProvider')).toMatchObject({
    provider: 'disconnected',
    availableCredits: null,
  });
});
