import { randomUUID } from 'node:crypto';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { NotFoundError } from '@repo/kernel';
import { sql } from 'kysely';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import {
  createUnsubscribeLink,
  unsubscribeFromLink,
  queueOutboundMessage,
  createDispatchOutboundTask,
  type OutboundInput,
} from './index.js';
import { addressConsentStatus } from './consent-state.js';

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
  const context = { ...business.context, correlationId: randomUUID() };
  const contact = await database.fixtures.contact(context, { email: 'recipient@example.test' });
  const other = await database.fixtures.contact(context, { email: 'other@example.test' });
  const queued = await withTenant(db, context, async (trx) => {
    const account = await trx
      .insertInto('messaging.channel_accounts')
      .values({ business_id: business.id, channel: 'email', name: 'Unsubscribe fixture' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('messaging.settings')
      .values({ business_id: business.id, quiet_hours_enabled: false })
      .execute();
    for (const contactId of [contact.id, other.id])
      for (const purpose of ['marketing', 'transactional'] as const)
        await trx
          .insertInto('messaging.consents')
          .values({
            business_id: business.id,
            contact_id: contactId,
            channel: 'email',
            purpose,
            status: 'granted',
            source: 'user',
            recorded_by_kind: 'system',
          })
          .execute();
    const identity = await trx
      .selectFrom('crm.contact_identities')
      .select('id')
      .where('contact_id', '=', contact.id)
      .executeTakeFirstOrThrow();
    const input: OutboundInput = {
      identityId: identity.id,
      accountId: account.id,
      channel: 'email',
      purpose: 'marketing',
      lane: 'campaign',
      idempotencyKey: randomUUID(),
      subject: 'Fixture',
      text: 'Only fixture content',
    };
    return { messageId: await queueOutboundMessage(trx, context, input), input };
  });
  const link = () =>
    withTenant(db, context, (trx) =>
      createUnsubscribeLink(trx, context, queued.messageId, 'https://crm.example.test'),
    );
  const queue = (patch: Partial<OutboundInput> = {}) =>
    withTenant(db, context, (trx) =>
      queueOutboundMessage(trx, context, {
        ...queued.input,
        idempotencyKey: randomUUID(),
        ...patch,
      }),
    );
  return { agency, business, context, contact, other, ...queued, link, queue };
}

const tokenOf = (link: string) => new URL(link).pathname.split('/').at(-1) ?? '';

it('refuses unsafe origins, nonmarketing messages and repeat issuance without invalidating the issued link', async () => {
  const f = await fixture();
  for (const origin of ['http://crm.example.test', 'https://user:password@crm.example.test']) {
    await expect(
      withTenant(db, f.context, (trx) =>
        createUnsubscribeLink(trx, f.context, f.messageId, origin),
      ),
    ).rejects.toThrow('One-click unsubscribe requires a public HTTPS address.');
  }
  const transactionalId = await f.queue({ purpose: 'transactional', lane: 'transactional' });
  await expect(
    withTenant(db, f.context, (trx) =>
      createUnsubscribeLink(trx, f.context, transactionalId, 'https://crm.example.test'),
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  const link = await f.link();
  await expect(f.link()).rejects.toBeInstanceOf(NotFoundError);
  expect(await unsubscribeFromLink(db, tokenOf(link), randomUUID())).toBe(true);
});

it.each(['crm_auth', 'crm_worker'] as const)(
  'does not grant capability scope lookup to %s',
  async (role) => {
    await expect(
      database.as(role, (connection) =>
        connection.query('select * from private.unsubscribe_scope($1)', ['a'.repeat(64)]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  },
);

it('withdraws only the original recipient email marketing consent from an opaque link', async () => {
  const { context, contact, messageId } = await fixture();
  const link = await withTenant(db, context, (trx) =>
    createUnsubscribeLink(trx, context, messageId, 'https://crm.example.test'),
  );
  expect(link).toMatch(/^https:\/\/crm\.example\.test\/unsubscribe\/[A-Za-z0-9_-]{43}$/);
  const token = new URL(link).pathname.split('/').at(-1);
  expect(token).toBeDefined();
  expect(link).not.toContain(contact.id);
  expect(link).not.toContain('recipient');
  expect(await unsubscribeFromLink(db, token ?? '', randomUUID())).toBe(true);
  const ledger = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('messaging.consents')
      .select(['contact_id', 'channel', 'purpose', 'status', 'source', 'proof'])
      .where('source', '=', 'unsubscribe_link')
      .execute(),
  );
  expect(ledger).toEqual([
    {
      contact_id: contact.id,
      channel: 'email',
      purpose: 'marketing',
      status: 'withdrawn',
      source: 'unsubscribe_link',
      proof: { messageId },
    },
  ]);
  const suppressions = await withTenant(db, context, (trx) =>
    trx.selectFrom('messaging.suppressions').select('id').execute(),
  );
  expect(suppressions).toEqual([]);
  const audit = await database.withTenant(context, (sql) =>
    sql.query<{ input: unknown }>(
      "select input from audit.commands where command='consents.unsubscribe'",
    ),
  );
  expect(audit).toEqual([
    { input: { channel: 'email', purpose: 'marketing', source: 'unsubscribe_link' } },
  ]);
  expect(JSON.stringify(audit)).not.toContain(token);
  const events = await withTenant(db, context, (trx) =>
    trx
      .selectFrom('events.events')
      .select(['payload', 'actor_kind'])
      .where('type', '=', 'consent.withdrawn')
      .execute(),
  );
  expect(events).toEqual([
    {
      actor_kind: 'contact',
      payload: { channel: 'email', purpose: 'marketing', source: 'unsubscribe_link' },
    },
  ]);
});

it('rejects altered, guessed and malformed capabilities and refuses foreign issuance', async () => {
  const f = await fixture();
  const foreign = await fixture();
  const token = tokenOf(await f.link());
  await expect(
    withTenant(db, foreign.context, (trx) =>
      createUnsubscribeLink(trx, foreign.context, f.messageId, 'https://crm.example.test'),
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  const altered = (token.startsWith('A') ? 'B' : 'A') + token.slice(1);
  for (const attempted of ['', token.slice(1), `${token}x`, 'A'.repeat(43), altered])
    expect(await unsubscribeFromLink(db, attempted, randomUUID())).toBe(false);
  for (const owner of [f, foreign])
    expect(
      await withTenant(db, owner.context, (trx) =>
        trx
          .selectFrom('messaging.consents')
          .select('id')
          .where('status', '=', 'withdrawn')
          .execute(),
      ),
    ).toEqual([]);
  expect(await unsubscribeFromLink(db, token, randomUUID())).toBe(true);
  expect(
    await withTenant(db, foreign.context, (trx) =>
      trx.selectFrom('messaging.consents').select('id').where('status', '=', 'withdrawn').execute(),
    ),
  ).toEqual([]);
});

it('records one withdrawal and event for simultaneous and repeated requests', async () => {
  const f = await fixture();
  const token = tokenOf(await f.link());
  expect(
    await Promise.all([
      unsubscribeFromLink(db, token, randomUUID()),
      unsubscribeFromLink(db, token, randomUUID()),
    ]),
  ).toEqual([true, true]);
  expect(await unsubscribeFromLink(db, token, randomUUID())).toBe(true);
  const result = await withTenant(db, f.context, async (trx) => ({
    ledger: await trx
      .selectFrom('messaging.consents')
      .select('id')
      .where('source', '=', 'unsubscribe_link')
      .execute(),
    events: await trx
      .selectFrom('events.events')
      .select('id')
      .where('type', '=', 'consent.withdrawn')
      .execute(),
    capability: await trx
      .selectFrom('messaging.unsubscribe_links')
      .select(['digest', 'address_normalized', 'last_used_at'])
      .where('message_id', '=', f.messageId)
      .executeTakeFirstOrThrow(),
    dispatch: await trx
      .selectFrom('messaging.outbound_dispatch')
      .select('unsubscribe_used_at')
      .where('id', '=', f.messageId)
      .executeTakeFirstOrThrow(),
  }));
  expect(result.ledger).toHaveLength(1);
  expect(result.events).toHaveLength(1);
  expect(result.dispatch.unsubscribe_used_at).toBeInstanceOf(Date);
  expect(result.capability.last_used_at).toBeInstanceOf(Date);
  expect(result.capability.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(result.capability.address_normalized).toBe('recipient@example.test');
  expect(JSON.stringify(result)).not.toContain(token);
});

it('blocks already queued marketing while separately granted transactional mail remains eligible', async () => {
  const f = await fixture();
  const token = tokenOf(await f.link());
  expect(await unsubscribeFromLink(db, token, randomUUID())).toBe(true);
  const delivered: string[] = [];
  const task = createDispatchOutboundTask({
    deliver(message) {
      delivered.push(message.messageId);
      return Promise.resolve({ outcome: 'accepted', providerId: 'fixture-receipt' });
    },
  });
  const job = {
    invocation: { context: f.context, permissions: 'all' as const },
    services: { db, authorize: () => true },
  };
  await task.run({ messageId: f.messageId }, job);
  const transactional = await f.queue({ purpose: 'transactional', lane: 'transactional' });
  await task.run({ messageId: transactional }, job);
  expect(delivered).toEqual([transactional]);
  const states = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.messages')
      .select(['id', 'status', 'error_code'])
      .orderBy('created_at')
      .execute(),
  );
  expect(states).toEqual([
    { id: f.messageId, status: 'failed', error_code: 'consent_withdrawn' },
    { id: transactional, status: 'sent', error_code: null },
  ]);
});

/** The address's marketing status as a send to it would read it, by the contact holding it now. */
async function statusOf(context: Parameters<typeof withTenant>[1], address: string) {
  return withTenant(db, context, async (trx) => {
    const { rows } = await sql<{ status: string }>`
      select ${addressConsentStatus(
        sql`app.business_id()`,
        sql`(select contact_id from crm.contact_identities where value_normalized=${address})`,
        sql`${address}::text`,
        'email',
        'marketing',
      )} as status`.execute(trx);
    return rows[0]?.status;
  });
}

it.each(['edited', 'moved', 'deleted'] as const)(
  'a link still opts its address out after the identity is %s',
  async (change) => {
    const f = await fixture();
    const token = tokenOf(await f.link());
    await withTenant(db, f.context, async (trx) => {
      if (change === 'deleted')
        await trx
          .deleteFrom('crm.contact_identities')
          .where('id', '=', f.input.identityId)
          .execute();
      else
        await trx
          .updateTable('crm.contact_identities')
          .set(
            change === 'edited'
              ? { value: 'replacement@example.test', value_normalized: 'replacement@example.test' }
              : { contact_id: f.other.id, is_primary: false },
          )
          .where('id', '=', f.input.identityId)
          .execute();
    });
    expect(await unsubscribeFromLink(db, token, randomUUID())).toBe(true);
    const ledger = await withTenant(db, f.context, (trx) =>
      trx
        .selectFrom('messaging.consents')
        .select(['contact_id', 'address_normalized', 'status'])
        .where('status', '=', 'withdrawn')
        .execute(),
    );
    // The address the email went to, under the contact it was sent to.
    expect(ledger).toEqual([
      {
        contact_id: f.contact.id,
        address_normalized: 'recipient@example.test',
        status: 'withdrawn',
      },
    ]);
    if (change === 'moved')
      // Whoever holds the address now is not sent marketing to it.
      expect(await statusOf(f.context, 'recipient@example.test')).toBe('withdrawn');
    // The contact's other addresses follow its withdrawal; another contact's do not.
    expect(await statusOf(f.context, 'other@example.test')).toBe('granted');
  },
);

it('keeps the opt-out after the contact is purged and the address imported again', async () => {
  const f = await fixture();
  const token = tokenOf(await f.link());
  expect(await unsubscribeFromLink(db, token, randomUUID())).toBe(true);
  // The trash purge deletes the record, and with it the contact.
  await database.withTenant(f.context, (connection) =>
    connection.query('delete from crm.records where id=$1', [f.contact.id]),
  );
  const kept = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.consents')
      .select(['contact_id', 'address_normalized', 'status', 'purpose'])
      .execute(),
  );
  // The other contact's grants stay; of the purged contact only the address's withdrawal.
  expect(kept.filter((row) => row.contact_id === null)).toEqual([
    {
      contact_id: null,
      address_normalized: 'recipient@example.test',
      status: 'withdrawn',
      purpose: 'marketing',
    },
  ]);
  expect(kept.filter((row) => row.contact_id !== null && row.contact_id !== f.other.id)).toEqual(
    [],
  );
  const again = await database.fixtures.contact(f.context, { email: 'recipient@example.test' });
  await withTenant(db, f.context, (trx) =>
    trx
      .insertInto('messaging.consents')
      .values({
        business_id: f.business.id,
        contact_id: again.id,
        channel: 'email',
        purpose: 'marketing',
        status: 'granted',
        source: 'import',
        proof: sql`'{"note":"old list"}'::jsonb`,
        recorded_by_kind: 'system',
        // As an import written before the purge would sort.
        recorded_at: sql`now() - interval '1 day'`,
      })
      .execute(),
  );
  expect(await statusOf(f.context, 'recipient@example.test')).toBe('withdrawn');
  // The link still works, and still says so.
  expect(await unsubscribeFromLink(db, token, randomUUID())).toBe(true);
  // The new contact really asks again; the old link, used after that, opts the address out
  // again, though its message and contact are long gone.
  await withTenant(db, f.context, (trx) =>
    trx
      .insertInto('messaging.consents')
      .values({
        business_id: f.business.id,
        contact_id: again.id,
        channel: 'email',
        purpose: 'marketing',
        status: 'granted',
        address_normalized: 'recipient@example.test',
        source: 'form',
        recorded_by_kind: 'contact',
        recorded_at: sql`clock_timestamp()`,
      })
      .execute(),
  );
  expect(await statusOf(f.context, 'recipient@example.test')).toBe('granted');
  expect(await unsubscribeFromLink(db, token, randomUUID())).toBe(true);
  expect(await statusOf(f.context, 'recipient@example.test')).toBe('withdrawn');
  const latest = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.consents')
      .select(['contact_id', 'proof', 'recorded_by_id'])
      .where('source', '=', 'unsubscribe_link')
      .orderBy('recorded_at', 'desc')
      .executeTakeFirstOrThrow(),
  );
  expect(latest).toEqual({ contact_id: null, proof: {}, recorded_by_id: null });
});

it('opts out again when an old link is used after a later re-subscribe: the latest act wins', async () => {
  const f = await fixture();
  const token = tokenOf(await f.link());
  expect(await unsubscribeFromLink(db, token, randomUUID())).toBe(true);
  await withTenant(db, f.context, (trx) =>
    trx
      .insertInto('messaging.consents')
      .values({
        business_id: f.business.id,
        contact_id: f.contact.id,
        channel: 'email',
        purpose: 'marketing',
        status: 'granted',
        address_normalized: 'recipient@example.test',
        source: 'form',
        recorded_by_kind: 'contact',
        recorded_at: sql`clock_timestamp()`,
      })
      .execute(),
  );
  expect(await statusOf(f.context, 'recipient@example.test')).toBe('granted');
  expect(await unsubscribeFromLink(db, token, randomUUID())).toBe(true);
  expect(await statusOf(f.context, 'recipient@example.test')).toBe('withdrawn');
  const withdrawals = await withTenant(db, f.context, (trx) =>
    trx
      .selectFrom('messaging.consents')
      .select('id')
      .where('source', '=', 'unsubscribe_link')
      .execute(),
  );
  expect(withdrawals).toHaveLength(2);
});
