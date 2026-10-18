// The webhook signing secret (migration 0043): made or replaced by someone allowed to,
// shown once, kept only in the vault, and never in an event or the audit log. Real
// Postgres, with a stand-in vault that writes real vault rows.
import { randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database, type DatabaseTransaction } from '@repo/db';
import { ForbiddenError, type TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import {
  createRotateWebhookSecretCommand,
  openWebhookSecret,
  readWebhookSigningStatus,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNING_PURPOSE,
  type LockBusiness,
  type SecretOpener,
  type SecretSealer,
} from './webhook-signing.js';

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

// Stands in for the vault: real rows in vault.secrets, as crm_app writes them, with the
// plaintext kept here in place of real sealing. What it was asked to do is recorded.
function standInVault(): SecretSealer & SecretOpener & { readonly calls: string[] } {
  const plaintexts = new Map<string, string>();
  const calls: string[] = [];
  const sealed = () => sql<Buffer>`decode(repeat('ab', 32), 'hex')`;
  return {
    calls,
    async store(trx: DatabaseTransaction, owner, plaintext) {
      calls.push(`store:${owner.purpose}`);
      const { id } = await trx
        .insertInto('vault.secrets')
        .values({
          agency_id: owner.agencyId,
          business_id: owner.businessId,
          purpose: owner.purpose,
          key_version: 1,
          enc: sealed(),
          ciphertext: sealed(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      plaintexts.set(id, plaintext);
      return id;
    },
    async replace(trx: DatabaseTransaction, secretId, plaintext) {
      calls.push('replace');
      await trx
        .updateTable('vault.secrets')
        .set({ rotated_at: sql<Date>`now()` })
        .where('id', '=', secretId)
        .executeTakeFirstOrThrow();
      plaintexts.set(secretId, plaintext);
    },
    async read(trx: DatabaseTransaction, secretId, purpose) {
      calls.push(`read:${purpose}`);
      // Under the tenant context, so another business's secret is simply not there.
      await trx
        .selectFrom('vault.secrets')
        .select('id')
        .where('id', '=', secretId)
        .where('purpose', '=', purpose)
        .executeTakeFirstOrThrow();
      const plaintext = plaintexts.get(secretId);
      if (plaintext === undefined) throw new Error('No such secret.');
      return plaintext;
    },
  };
}

// Stands in for tenancy's port: the same row lock, in the caller's own transaction.
const lockBusiness: LockBusiness = async (trx, context) => {
  await sql`select id from tenancy.businesses where id = ${context.businessId ?? null} for update`.execute(
    trx,
  );
};

async function business(): Promise<TenantContext> {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  return { ...created.context, correlationId: randomUUID() };
}
const as = (context: TenantContext) => ({
  context: { ...context, correlationId: randomUUID() },
  permissions: 'all' as const,
});
const tenant = <T>(context: TenantContext, work: (trx: DatabaseTransaction) => Promise<T>) =>
  withTenant(db, context, work);

it('makes the secret once, shows it once, and lets only the vault keep it', async () => {
  const vault = standInVault();
  const rotate = createRotateWebhookSecretCommand({ vault, lockBusiness });
  const context = await business();
  expect(await tenant(context, readWebhookSigningStatus)).toEqual({
    configured: false,
    rotatedAt: null,
  });
  expect(await tenant(context, (trx) => openWebhookSecret(trx, vault))).toBeUndefined();

  const made = await runCommand(services, rotate, {}, as(context));
  expect(made.secret.startsWith(WEBHOOK_SECRET_PREFIX)).toBe(true);
  // 32 random bytes, so it can't be guessed.
  expect(Buffer.from(made.secret.slice(WEBHOOK_SECRET_PREFIX.length), 'base64url')).toHaveLength(
    32,
  );
  expect(await tenant(context, readWebhookSigningStatus)).toEqual({
    configured: true,
    rotatedAt: made.rotatedAt,
  });
  expect(await tenant(context, (trx) => openWebhookSecret(trx, vault))).toBe(made.secret);
  expect(vault.calls).toEqual([
    `store:${WEBHOOK_SIGNING_PURPOSE}`,
    `read:${WEBHOOK_SIGNING_PURPOSE}`,
  ]);

  // Nothing the database keeps outside the vault holds the secret.
  const kept = await database.as('postgres', (client) =>
    client.query<{ found: string }>(
      `select 'event' as found from events.events where payload::text like '%' || $1 || '%'
       union all
       select 'audit' from audit.commands c where to_jsonb(c)::text like '%' || $1 || '%'
       union all
       select 'signing' from automation.webhook_signing s where to_jsonb(s)::text like '%' || $1 || '%'`,
      [made.secret.slice(WEBHOOK_SECRET_PREFIX.length)],
    ),
  );
  expect(kept).toEqual([]);
  const events = await database.withTenant(context, (client) =>
    client.query<{ payload: unknown }>(
      "select payload from events.events where type = 'automation.webhook_secret_rotated'",
    ),
  );
  expect(events).toEqual([{ payload: { first: true } }]);
});

it('replaces the secret in place: one row, one vault secret, and the old value is gone', async () => {
  const vault = standInVault();
  const rotate = createRotateWebhookSecretCommand({ vault, lockBusiness });
  const context = await business();
  const first = await runCommand(services, rotate, {}, as(context));
  const second = await runCommand(services, rotate, {}, as(context));
  expect(second.secret).not.toBe(first.secret);
  expect(await tenant(context, (trx) => openWebhookSecret(trx, vault))).toBe(second.secret);
  const counts = await database.withTenant(context, (client) =>
    client.query<{ signing: number; secrets: number }>(
      `select (select count(*)::int from automation.webhook_signing) as signing,
              (select count(*)::int from vault.secrets) as secrets`,
    ),
  );
  expect(counts).toEqual([{ signing: 1, secrets: 1 }]);
});

it('leaves one secret when two rotations overlap', async () => {
  const inner = standInVault();
  // The first rotation stops while storing its secret, inside its transaction. The second
  // starts meanwhile, and the first goes on only once the second is waiting on the
  // database, or has (wrongly) finished without waiting.
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = (): void => undefined;
  const storing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let stores = 0;
  const vault: typeof inner = {
    ...inner,
    store: async (trx, owner, plaintext) => {
      stores += 1;
      if (stores === 1) {
        reached();
        await held;
      }
      return inner.store(trx, owner, plaintext);
    },
  };
  const rotate = createRotateWebhookSecretCommand({ vault, lockBusiness });
  const context = await business();
  const first = runCommand(services, rotate, {}, as(context));
  await storing;
  let secondSettled = false;
  const second = runCommand(services, rotate, {}, as(context)).finally(() => {
    secondSettled = true;
  });
  await expect
    .poll(
      async () =>
        secondSettled ||
        (await database.as('postgres', async (client) => {
          const [row] = await client.query<{ waiting: number }>(
            `select count(*)::int as waiting from pg_stat_activity
             where datname = current_database() and wait_event_type = 'Lock'`,
          );
          return (row?.waiting ?? 0) > 0;
        })),
      { timeout: 10_000, interval: 50 },
    )
    .toBe(true);
  release();
  const results = await Promise.all([first, second]);
  const counts = await database.withTenant(context, (client) =>
    client.query<{ signing: number; secrets: number }>(
      `select (select count(*)::int from automation.webhook_signing) as signing,
              (select count(*)::int from vault.secrets) as secrets`,
    ),
  );
  expect(counts).toEqual([{ signing: 1, secrets: 1 }]);
  // The second rotation ran after the first, so its secret is the one in force.
  expect(await tenant(context, (trx) => openWebhookSecret(trx, vault))).toBe(results[1].secret);
});

it('needs the publish permission, and keeps each business to its own secret', async () => {
  const vault = standInVault();
  const rotate = createRotateWebhookSecretCommand({ vault, lockBusiness });
  const context = await business();
  await expect(
    runCommand(
      services,
      rotate,
      {},
      {
        context: { ...context, correlationId: randomUUID() },
        permissions: new Set(['automations.manage'] as const),
      },
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(await tenant(context, readWebhookSigningStatus)).toMatchObject({ configured: false });

  await runCommand(services, rotate, {}, as(context));
  const other = await business();
  expect(await tenant(other, readWebhookSigningStatus)).toEqual({
    configured: false,
    rotatedAt: null,
  });
  expect(await tenant(other, (trx) => openWebhookSecret(trx, vault))).toBeUndefined();
  // A row can't name another business's vault secret.
  const [theirs] = await database.as('postgres', (client) =>
    client.query<{ id: string }>('select id from vault.secrets where business_id = $1', [
      context.businessId,
    ]),
  );
  await expect(
    database.as('postgres', (client) =>
      client.query(
        `insert into automation.webhook_signing (business_id, secret_id, rotated_by_kind)
         values ($1, $2, 'user')`,
        [other.businessId, theirs?.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23503' });
});
