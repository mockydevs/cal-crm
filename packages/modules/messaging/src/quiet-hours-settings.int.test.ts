import { randomUUID } from 'node:crypto';
import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ConflictError, ForbiddenError, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { createDispatchOutboundTask, queueOutboundMessage } from './outbound.js';
import { readMessagingSettings, updateMessagingSettingsCommand } from './quiet-hours-settings.js';
import { quietHoursDefaults, quietHoursRevision } from './quiet-hours-values.js';

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

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const as = (permissions: readonly Permission[] | 'all' = ['mailboxes.manage']): Invocation => ({
    context: {
      ...business.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: permissions === 'all' ? 'all' : new Set(permissions),
  });
  const read = (invocation: Invocation = as()) =>
    withTenant(db, invocation.context, (trx) => readMessagingSettings(trx, invocation));
  return {
    business,
    as,
    read,
    save: async (
      patch: Record<string, unknown> = {},
      invocation: Invocation = as(),
    ): Promise<Awaited<ReturnType<typeof read>>> => {
      const current = await read();
      return runCommand(
        services,
        updateMessagingSettingsCommand,
        {
          quietHoursEnabled: current.quietHoursEnabled,
          quietHoursStart: current.quietHoursStart,
          quietHoursEnd: current.quietHoursEnd,
          contactDailyLimit: current.contactDailyLimit,
          revision: current.revision,
          ...patch,
        },
        invocation,
      );
    },
    stored: () =>
      database.withTenant(business.context, (sql) =>
        sql.query(
          `select quiet_hours_enabled,quiet_hours_start::text,quiet_hours_end::text,contact_daily_limit
           from messaging.settings`,
        ),
      ),
  };
}

it('answers the defaults sending uses before anything is saved, and writes nothing to read them', async () => {
  const f = await fixture();
  expect(await f.read()).toEqual({
    ...quietHoursDefaults,
    revision: quietHoursRevision(quietHoursDefaults),
    canManage: true,
    heldMessages: 0,
    contactsWithoutTimeZone: 0,
  });
  expect(await f.stored()).toEqual([]);
});

it('saves quiet hours and the daily limit, with an event and an audit row', async () => {
  const f = await fixture();
  const saved = await f.save({
    quietHoursStart: '22:30',
    quietHoursEnd: '07:15',
    contactDailyLimit: 3,
  });
  expect(saved).toMatchObject({
    quietHoursEnabled: true,
    quietHoursStart: '22:30',
    quietHoursEnd: '07:15',
    contactDailyLimit: 3,
  });
  expect(saved.revision).not.toBe(quietHoursRevision(quietHoursDefaults));
  expect(await f.stored()).toEqual([
    {
      quiet_hours_enabled: true,
      quiet_hours_start: '22:30:00',
      quiet_hours_end: '07:15:00',
      contact_daily_limit: 3,
    },
  ]);
  // A second save updates the one row.
  await f.save({ quietHoursEnabled: false });
  expect(await f.stored()).toMatchObject([{ quiet_hours_enabled: false, contact_daily_limit: 3 }]);
  expect(await f.read()).toMatchObject({ quietHoursEnabled: false, quietHoursStart: '22:30' });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        "select subject_kind,subject_id,payload from events.events where type='messaging_settings.updated' order by recorded_at,id",
      ),
    ),
  ).toEqual([
    {
      subject_kind: 'business',
      subject_id: f.business.id,
      payload: {
        quietHoursEnabled: true,
        quietHoursStart: '22:30',
        quietHoursEnd: '07:15',
        contactDailyLimit: 3,
      },
    },
    {
      subject_kind: 'business',
      subject_id: f.business.id,
      payload: {
        quietHoursEnabled: false,
        quietHoursStart: '22:30',
        quietHoursEnd: '07:15',
        contactDailyLimit: 3,
      },
    },
  ]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        "select outcome from audit.commands where command='messaging.update_settings' order by recorded_at",
      ),
    ),
  ).toEqual([{ outcome: 'ok' }, { outcome: 'ok' }]);
});

it.each([
  { quietHoursStart: '24:00' },
  { quietHoursEnd: '7:00' },
  { quietHoursStart: '21:00:00' },
  { quietHoursStart: '09:00', quietHoursEnd: '09:00' },
  { contactDailyLimit: 0 },
  { contactDailyLimit: 10_001 },
  { contactDailyLimit: 2.5 },
  { quietHoursEnabled: 'yes' },
  { businessId: randomUUID() },
])('refuses %j and saves nothing', async (patch) => {
  const f = await fixture();
  await expect(f.save(patch)).rejects.toBeInstanceOf(ValidationError);
  expect(await f.stored()).toEqual([]);
});

it('refuses a save based on settings someone else has changed since', async () => {
  const f = await fixture();
  const opened = await f.read();
  await f.save({ contactDailyLimit: 4 });
  await expect(
    runCommand(
      services,
      updateMessagingSettingsCommand,
      {
        quietHoursEnabled: false,
        quietHoursStart: opened.quietHoursStart,
        quietHoursEnd: opened.quietHoursEnd,
        contactDailyLimit: opened.contactDailyLimit,
        revision: opened.revision,
      },
      f.as(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(await f.stored()).toMatchObject([{ quiet_hours_enabled: true, contact_daily_limit: 4 }]);
  // Two saves from the same reading at once: one wins, the other is told.
  const current = await f.read();
  const attempt = (contactDailyLimit: number) =>
    runCommand(
      services,
      updateMessagingSettingsCommand,
      {
        quietHoursEnabled: current.quietHoursEnabled,
        quietHoursStart: current.quietHoursStart,
        quietHoursEnd: current.quietHoursEnd,
        contactDailyLimit,
        revision: current.revision,
      },
      f.as(),
    );
  const outcomes = await Promise.allSettled([attempt(7), attempt(8)]);
  expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
    reason: expect.any(ConflictError) as unknown,
  });
});

it('needs mailboxes.manage to save, and shows the settings read-only without it', async () => {
  const f = await fixture();
  for (const permissions of [[], ['contacts.manage', 'tasks.manage']] as const) {
    await expect(f.save({ contactDailyLimit: 2 }, f.as(permissions))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await f.read(f.as(permissions))).toMatchObject({
      canManage: false,
      quietHoursEnabled: true,
    });
  }
  expect(await f.stored()).toEqual([]);
  // Settings belong to a business: the agency's staff choose one first.
  await expect(
    runCommand(
      services,
      updateMessagingSettingsCommand,
      { ...quietHoursDefaults, revision: quietHoursRevision(quietHoursDefaults) },
      {
        context: {
          agencyId: f.business.agencyId,
          actorKind: 'user',
          correlationId: randomUUID(),
        },
        permissions: 'all',
      },
    ),
  ).rejects.toBeInstanceOf(ValidationError);
});

it("never reads or changes another business's settings", async () => {
  const mine = await fixture();
  const theirs = await fixture();
  await theirs.save({ quietHoursEnabled: false, contactDailyLimit: 99 });
  expect(await mine.read()).toMatchObject({ quietHoursEnabled: true, contactDailyLimit: 10 });
  await mine.save({ contactDailyLimit: 5 });
  expect(await theirs.read()).toMatchObject({ quietHoursEnabled: false, contactDailyLimit: 99 });
  expect(await mine.stored()).toMatchObject([{ contact_daily_limit: 5 }]);
  expect(await theirs.stored()).toMatchObject([{ contact_daily_limit: 99 }]);
});

it('counts what quiet hours hold now, and lets them go at the next check once turned off', async () => {
  const f = await fixture();
  const system = { ...f.business.context, correlationId: randomUUID() };
  const contact = await database.fixtures.contact(f.business.context, {
    email: 'recipient@example.test',
  });
  const untimed = await database.fixtures.contact(f.business.context);
  const sender = await database.withTenant(f.business.context, async (sql) => {
    await sql.query("update crm.contacts set timezone='Africa/Nairobi' where id=$1", [contact.id]);
    await sql.query("update crm.contacts set timezone='Not/AZone' where id=$1", [untimed.id]);
    await sql.query(
      `insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,proof,recorded_by_kind)
       values (app.business_id(),$1,'email','marketing','granted','user','{"note":"Fixture consent."}','system')`,
      [contact.id],
    );
    const identity = await sql.one<{ id: string }>(
      'select id from crm.contact_identities where contact_id=$1',
      [contact.id],
    );
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id,channel,name) values (app.business_id(),'email','Fixture sender') returning id",
    );
    return { identityId: identity.id, accountId: account.id };
  });
  // A window around the contact's current local time, saved through the command.
  const local = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ start: string; finish: string }>(
      `select to_char((now() at time zone 'Africa/Nairobi')-interval '2 hours','HH24:MI') as start,
              to_char((now() at time zone 'Africa/Nairobi')+interval '2 hours','HH24:MI') as finish`,
    ),
  );
  await f.save({ quietHoursStart: local.start, quietHoursEnd: local.finish });
  const messageId = await withTenant(db, system, (trx) =>
    queueOutboundMessage(trx, system, {
      ...sender,
      channel: 'email',
      purpose: 'marketing',
      lane: 'campaign',
      idempotencyKey: randomUUID(),
      subject: 'Fixture',
      text: 'Body',
    }),
  );
  // One message held; one contact whose zone PostgreSQL doesn't know (the other has one).
  expect(await f.read()).toMatchObject({ heldMessages: 1, contactsWithoutTimeZone: 1 });

  await f.save({ quietHoursEnabled: false });
  let deliveries = 0;
  const task = createDispatchOutboundTask({
    deliver() {
      deliveries++;
      return Promise.resolve({ outcome: 'accepted' as const, providerId: randomUUID() });
    },
  });
  const job = { invocation: { context: system, permissions: 'all' as const }, services };
  // Before its recheck is due the message stays where it is.
  await task.run({ messageId }, job);
  expect(deliveries).toBe(0);
  // The five minutes pass.
  await database.withTenant(system, (sql) =>
    sql.query("update messaging.messages set scheduled_for=now()-interval '1 second' where id=$1", [
      messageId,
    ]),
  );
  await task.run({ messageId }, job);
  expect(deliveries).toBe(1);
  expect(await f.read()).toMatchObject({ heldMessages: 0 });
});
