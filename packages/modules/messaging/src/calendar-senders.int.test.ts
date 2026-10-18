import { connectDatabase, withTenant, type Database } from '@repo/db';
import { NotFoundError, toPublicId, type TenantContext } from '@repo/kernel';
import {
  createSealingVault,
  newSecretsKey,
  parseSecretsPublicKey,
  type SealingVault,
} from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import {
  resolveCalendarSender,
  readCalendarSenderChoices,
  readEligibleCalendarSenders,
} from './calendar-senders.js';

it('pages eligible sender metadata and bulk eligibility strictly within the current business', async () => {
  const ours = await fixture();
  const other = await fixture();
  const extra = await database.withTenant(ours.business.context, async (sql) => {
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts(business_id,channel,name) values(app.business_id(),'email','Second sender') returning id",
    );
    await sql.query(
      `insert into messaging.mailboxes(business_id,id,email_address,auth_method,smtp_host,smtp_port,smtp_security,smtp_username,secret_id,use_for_conversations)
      select business_id,$1,'second@example.test',auth_method,smtp_host,smtp_port,smtp_security,smtp_username,secret_id,true from messaging.mailboxes where id=$2`,
      [account.id, ours.accountId],
    );
    return account.id;
  });
  const first = await withTenant(db, ours.business.context, (trx) =>
    readCalendarSenderChoices(trx, ours.business.context, { limit: 1 }),
  );
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toEqual({
    id: ours.publicId,
    name: 'Bookings',
    email: 'bookings@example.test',
  });
  expect(first.nextCursor).toBe(ours.publicId);
  const last = await withTenant(db, ours.business.context, (trx) =>
    readCalendarSenderChoices(trx, ours.business.context, {
      limit: 1,
      after: first.nextCursor ?? undefined,
    }),
  );
  expect(last).toEqual({
    items: [
      { id: toPublicId('mailbox', extra), name: 'Second sender', email: 'second@example.test' },
    ],
    nextCursor: null,
  });
  expect(
    await withTenant(db, ours.business.context, (trx) =>
      readEligibleCalendarSenders(trx, ours.business.context, [
        ours.accountId,
        other.accountId,
        extra,
      ]),
    ),
  ).toEqual(new Set([ours.accountId, extra]));
  await database.withTenant(ours.business.context, (sql) =>
    sql.query('update messaging.mailboxes set use_for_conversations=false where id=$1', [extra]),
  );
  expect(
    await withTenant(db, ours.business.context, (trx) =>
      readEligibleCalendarSenders(trx, ours.business.context, [ours.accountId, extra]),
    ),
  ).toEqual(new Set([ours.accountId]));
  expect(
    await withTenant(db, ours.business.context, (trx) =>
      readEligibleCalendarSenders(trx, ours.business.context, []),
    ),
  ).toEqual(new Set());
});

let database: TestDatabase;
let db: Database;
let vault: SealingVault;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const keys = await newSecretsKey(1);
  vault = await createSealingVault(parseSecretsPublicKey(keys.publicKey));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const accountId = await withTenant(db, business.context, async (trx) => {
    const secretId = await vault.store(
      trx,
      {
        agencyId: agency.id,
        businessId: business.id,
        purpose: 'mailbox.credentials',
      },
      'metadata-only calendar fixture',
    );
    const account = await trx
      .insertInto('messaging.channel_accounts')
      .values({
        business_id: business.id,
        channel: 'email',
        name: 'Bookings',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('messaging.mailboxes')
      .values({
        business_id: business.id,
        id: account.id,
        email_address: 'bookings@example.test',
        auth_method: 'password',
        smtp_host: 'localhost',
        smtp_port: 1025,
        smtp_security: 'none',
        smtp_username: 'fixture',
        secret_id: secretId,
        use_for_conversations: true,
      })
      .execute();
    return account.id;
  });
  return { business, accountId, publicId: toPublicId('mailbox', accountId) };
}

function resolve(context: TenantContext, mailboxId: string) {
  return withTenant(db, context, (trx) => resolveCalendarSender(trx, context, mailboxId));
}

it('resolves only this business’s active email mailbox permitted for conversations', async () => {
  const ours = await fixture();
  const other = await fixture();
  expect(await resolve(ours.business.context, ours.publicId)).toBe(ours.accountId);
  await expect(resolve(ours.business.context, other.publicId)).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await expect(resolve(ours.business.context, 'invalid')).rejects.toBeInstanceOf(NotFoundError);
  await database.withTenant(ours.business.context, (sql) =>
    sql.query('update messaging.mailboxes set use_for_conversations=false where id=$1', [
      ours.accountId,
    ]),
  );
  await expect(resolve(ours.business.context, ours.publicId)).rejects.toBeInstanceOf(NotFoundError);
  await database.withTenant(ours.business.context, (sql) =>
    sql.query('update messaging.mailboxes set use_for_conversations=true where id=$1', [
      ours.accountId,
    ]),
  );
  await database.withTenant(ours.business.context, (sql) =>
    sql.query("update messaging.channel_accounts set status='paused' where id=$1", [
      ours.accountId,
    ]),
  );
  await expect(resolve(ours.business.context, ours.publicId)).rejects.toBeInstanceOf(NotFoundError);
});

it.each(['account', 'mailbox'] as const)(
  'holds the eligible %s until the booking transaction commits',
  async (kind) => {
    const ours = await fixture();
    const acquired = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const holding = withTenant(db, ours.business.context, async (trx) => {
      await resolveCalendarSender(trx, ours.business.context, ours.publicId);
      acquired.resolve(undefined);
      await release.promise;
    });
    await acquired.promise;
    const change =
      kind === 'account'
        ? "update messaging.channel_accounts set status='paused' where id=$1"
        : 'update messaging.mailboxes set use_for_conversations=false where id=$1';
    const changed = database.withTenant(ours.business.context, (sql) =>
      sql.query(change, [ours.accountId]),
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
                    "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query=$1) as waiting",
                    [change],
                  )
                ).waiting,
            ),
          { timeout: 5000 },
        )
        .toBe(true);
    } finally {
      release.resolve(undefined);
      await Promise.all([holding, changed]);
    }
    await expect(resolve(ours.business.context, ours.publicId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  },
);
