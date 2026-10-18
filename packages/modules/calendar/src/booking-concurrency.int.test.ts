import { randomUUID } from 'node:crypto';
import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { updateContactCommand } from '@repo/module-crm';
import { queueOutboundMessage } from '@repo/module-messaging';
import { lockActiveBusiness } from '@repo/module-tenancy';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

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

it('lets canonical contact updates emit and commit before booking acquires the contact and upgrades the outbound business lock', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context, { email: 'race@example.test' });
  const invocation: Invocation = {
    context: { ...business.context, correlationId: randomUUID() },
    permissions: 'all',
  };
  const account = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      "insert into messaging.channel_accounts(business_id,channel,name) values(app.business_id(),'email','Race sender') returning id",
    ),
  );
  await database.withTenant(business.context, async (sql) => {
    await sql.query(
      "insert into messaging.consents(business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values(app.business_id(),$1,'email','transactional','granted','booking','contact')",
      [contact.id],
    );
    await sql.query(
      'insert into messaging.settings(business_id,quiet_hours_enabled) values(app.business_id(),false)',
    );
  });
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const ordinary = defineCommand({
    ...updateContactCommand,
    name: 'test.contact.update_before_booking',
    async handle(trx, input, command) {
      return updateContactCommand.handle(trx, input, {
        ...command,
        async emit(event) {
          ready.resolve(undefined);
          await proceed.promise;
          return command.emit(event);
        },
      });
    },
  });
  const updating = runCommand(
    services,
    ordinary,
    { id: toPublicId('contact', contact.id), firstName: 'Updated' },
    invocation,
  ).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await ready.promise;
  const booking = withTenant(db, invocation.context, async (trx) => {
    await lockActiveBusiness(trx, invocation.context);
    await trx
      .selectFrom('crm.contacts')
      .select('id')
      .where('id', '=', contact.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const identity = await trx
      .selectFrom('crm.contact_identities')
      .select('id')
      .where('contact_id', '=', contact.id)
      .where('kind', '=', 'email')
      .executeTakeFirstOrThrow();
    return queueOutboundMessage(trx, invocation.context, {
      identityId: identity.id,
      accountId: account.id,
      channel: 'email',
      purpose: 'transactional',
      lane: 'transactional',
      idempotencyKey: `race:${randomUUID()}`,
      text: 'Booking lock regression',
    });
  }).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  try {
    await expect
      .poll(
        async () =>
          database.as(
            'crm_app',
            async (sql) =>
              (
                await sql.one<{ waiting: boolean }>(
                  "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%crm%contacts%for update%') as waiting",
                )
              ).waiting,
          ),
        { timeout: 5000 },
      )
      .toBe(true);
  } finally {
    proceed.resolve(undefined);
  }
  const [updated, queued] = await Promise.all([updating, booking]);
  if (!updated.ok) throw updated.error;
  if (!queued.ok) throw queued.error;
  expect(updated).toMatchObject({ ok: true, result: { firstName: 'Updated' } });
  expect(queued).toMatchObject({ ok: true });
  expect(
    await database.withTenant(business.context, (sql) =>
      sql.query("select type from events.events where type='contact.updated'"),
    ),
  ).toEqual([{ type: 'contact.updated' }]);
  expect(
    await database.withTenant(business.context, (sql) =>
      sql.query("select status from messaging.messages where body_text='Booking lock regression'"),
    ),
  ).toEqual([{ status: 'queued' }]);
});
