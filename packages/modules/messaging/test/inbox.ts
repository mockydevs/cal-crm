// The Inbox tests' world: a database, the routes as the server composes them, and rows
// written the way the product writes them.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type ApiRoute, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import {
  ForbiddenError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { testDatabase, type DatabaseServer, type TestDatabase } from '@repo/testing';

import type { InboxOptions } from '../src/inbox-list.js';
import { createInboxRoutes } from '../src/inbox-routes.js';
import { createDispatchOutboundTask, type OutboundSender } from '../src/outbound.js';

export interface InboxWorld {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly services: Services;
  /** What the routes were composed with, to compose others that differ in one thing. */
  readonly options: InboxOptions;
  readonly routes: readonly ApiRoute[];
  /** Calls a route as the server does, and checks the answer against its documented schema. */
  call(
    operationId: string,
    invocation: Invocation,
    request?: { params?: unknown; query?: unknown; body?: unknown },
    among?: readonly ApiRoute[],
  ): Promise<unknown>;
  /**
   * Waits until `count` sessions of this database are seen waiting on a lock, at least one
   * of them directly on the transaction of this backend. Two sessions that want the same row
   * FOR UPDATE queue: the second waits behind the first, not behind the holder.
   */
  blockedBy(pid: number, count?: number): Promise<void>;
  /**
   * Adds a member of the business, with a real membership: crm_app sees a person's name
   * only when they share a membership it can see (auth.users' visible_people policy).
   */
  member(businessId: string, name: string): Promise<{ userId: string; membershipId: string }>;
  close(): Promise<void>;
}

export async function startInbox(
  connection: DatabaseServer,
  settings: { readonly smsAvailable?: boolean } = {},
): Promise<InboxWorld> {
  const database = await testDatabase(connection);
  const db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const services: Services = { db, authorize: allowEveryone };
  // Tenancy's assignee rules are its own to test; here the port knows the people the
  // fixture added, by business.
  const members = new Map<string, { userId: string; membershipId: string }[]>();
  const teamOf = (context: TenantContext) => members.get(context.businessId ?? '') ?? [];
  const options: InboxOptions = {
    actorNames: {
      user: async (trx, ids) => {
        const rows = await trx
          .selectFrom('auth.users')
          .select(['id', 'name'])
          .where('id', 'in', [...ids])
          .execute();
        return new Map(rows.map((row) => [row.id, row.name]));
      },
    },
    assignees: {
      resolve: (_trx, context, selection) => {
        if (selection === null) return Promise.resolve(null);
        if (selection === 'me') {
          if (context.actorKind !== 'user' || context.userId === undefined)
            throw new ForbiddenError('Assign to me requires a signed-in person.');
          return Promise.resolve(context.userId);
        }
        const id = parsePublicId('membership', selection);
        const found = teamOf(context).find((member) => member.membershipId === id);
        if (found === undefined)
          throw new ValidationError([
            {
              path: '/assignee',
              code: 'unavailable_assignee',
              message: 'Choose someone on this business or agency team.',
            },
          ]);
        return Promise.resolve(found.userId);
      },
      read: (_trx, context) =>
        Promise.resolve({
          items: teamOf(context).map((member) => ({
            id: toPublicId('membership', member.membershipId),
            userId: member.userId,
          })),
          nextCursor: null,
        }),
      memberships: (_trx, context, userIds) =>
        Promise.resolve(
          new Map(
            teamOf(context)
              .filter((member) => userIds.includes(member.userId))
              .map((member) => [member.userId, toPublicId('membership', member.membershipId)]),
          ),
        ),
    },
    smsAvailable: settings.smsAvailable ?? false,
  };
  const routes = createInboxRoutes(options);
  return {
    database,
    db,
    services,
    options,
    routes,
    async call(operationId, invocation, request = {}, among = routes) {
      const route = among.find((each) => each.endpoint.operationId === operationId);
      if (route === undefined) throw new Error(`No route for ${operationId}.`);
      const answer = await route.run(
        {
          invocation: {
            context: { ...invocation.context, correlationId: randomUUID() },
            permissions: invocation.permissions,
          },
          params: request.params ?? {},
          query: request.query ?? {},
          body: request.body,
        },
        services,
      );
      const schema = route.endpoint.response.schema;
      if (schema === undefined) throw new Error(`${operationId} documents no response.`);
      return schema.parse(answer);
    },
    async blockedBy(pid, count = 1) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        // Another role's wait events are hidden from crm_app, so the superuser watches.
        const [row] = await database.as('postgres', (sql) =>
          sql.query<{ waiting: number; behind: number }>(
            `select count(*) filter (where wait_event_type = 'Lock')::int as waiting,
               count(*) filter (where $1 = any(pg_blocking_pids(pid)))::int as behind
             from pg_stat_activity where datname = current_database()`,
            [pid],
          ),
        );
        if ((row?.waiting ?? 0) >= count && (row?.behind ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Fixture timeout: ${String(count)} session(s) never waited on the lock.`);
    },
    async member(businessId, name) {
      const user = await database.fixtures.user({ name });
      // The role is made once per agency; the membership is this business's.
      const { id } = await database.as('crm_owner', (sql) =>
        sql.one<{ id: string }>(
          `with business as (
             select agency_id from tenancy.businesses where id = $1
           ), existing as (
             select r.id from tenancy.roles r, business b
             where r.agency_id = b.agency_id and r.scope = 'business' and r.key = 'member'
           ), made as (
             insert into tenancy.roles (agency_id, scope, key, name)
             select b.agency_id, 'business', 'member', 'Member' from business b
             where not exists (select 1 from existing)
             returning id
           )
           insert into tenancy.memberships (agency_id, business_id, user_id, role_id)
           select b.agency_id, $1, $2, r.id
           from business b, (select id from existing union all select id from made) r
           returning id`,
          [businessId, user.id],
        ),
      );
      const member = { userId: user.id, membershipId: id };
      members.set(businessId, [...(members.get(businessId) ?? []), member]);
      return { userId: user.id, membershipId: toPublicId('membership', id) };
    },
    async close() {
      await db.destroy();
      await database.close();
    },
  };
}

export type Delivery = Awaited<ReturnType<OutboundSender['deliver']>>['outcome'] | 'throws';

/** A business with one signed-in person, quiet hours off, and helpers to fill its inbox. */
export function inboxBusiness(world: InboxWorld): Promise<InboxBusiness> {
  return businessIn(world);
}

export type InboxBusiness = Awaited<ReturnType<typeof businessIn>>;

async function businessIn(world: InboxWorld) {
  const { database } = world;
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user({ name: 'Dana Brooks' });
  const context: TenantContext = {
    ...business.context,
    actorKind: 'user',
    userId: user.id,
    actorId: user.id,
    correlationId: randomUUID(),
  };
  const query = <Row extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(context, (sql) => sql.query<Row>(text, values));
  await query(
    `insert into messaging.settings (business_id, quiet_hours_enabled, contact_daily_limit)
     values (app.business_id(), false, 1000)`,
  );

  /** The caller, with every permission or only the ones given. */
  const as = (permissions: Invocation['permissions'] = 'all'): Invocation => ({
    context: { ...context, correlationId: randomUUID() },
    permissions,
  });

  /** A contact with an email address, and consent to transactional email unless refused. */
  const contact = async (
    values: {
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      consent?: boolean;
    } = {},
  ) => {
    const email = values.email ?? `contact-${randomUUID().slice(0, 8)}@example.test`;
    const created = await database.fixtures.contact(context, { ...values, email });
    if (values.phone !== undefined)
      await query(
        `insert into crm.contact_identities
           (business_id, contact_id, kind, value, value_normalized, is_primary)
         values (app.business_id(), $1, 'phone', $2, $2, true)`,
        [created.id, values.phone],
      );
    if (values.consent !== false)
      for (const channel of ['email', 'sms'])
        await query(
          `insert into messaging.consents
             (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
           values (app.business_id(), $1, $2, 'transactional', 'granted', 'user', 'system')`,
          [created.id, channel],
        );
    const identities = await query<{ id: string; kind: string }>(
      'select id, kind from crm.contact_identities where contact_id = $1',
      [created.id],
    );
    const identity = (kind: string) => {
      const found = identities.find((each) => each.kind === kind);
      return found === undefined ? undefined : toPublicId('contact_identity', found.id);
    };
    return {
      id: created.id,
      publicId: toPublicId('contact', created.id),
      email,
      emailIdentity: identity('email') ?? '',
      phoneIdentity: identity('phone'),
    };
  };

  /** A connected mailbox: a channel account and its mailbox row, as the verifier saves them. */
  const mailbox = async (
    values: { address?: string; forConversations?: boolean; status?: string } = {},
  ) => {
    const address = values.address ?? `team-${randomUUID().slice(0, 8)}@example.test`;
    const [secret] = await query<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values (app.agency_id(), app.business_id(), 'mailbox.credentials', 1,
               decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'))
       returning id`,
    );
    const [account] = await query<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name, status)
       values (app.business_id(), 'email', $1, $2) returning id`,
      [address, values.status ?? 'active'],
    );
    if (secret === undefined || account === undefined) throw new Error('Fixture rows missing.');
    await query(
      `insert into messaging.mailboxes
         (business_id, id, email_address, auth_method, smtp_host, smtp_port, smtp_security,
          smtp_username, secret_id, use_for_conversations)
       values (app.business_id(), $1, $2, 'password', 'localhost', 1025, 'none', 'fixture', $3, $4)`,
      [account.id, address, secret.id, values.forConversations ?? true],
    );
    return { id: account.id, publicId: toPublicId('channel_account', account.id), address };
  };

  /**
   * A text message account: a number registered on a connected Twilio connection, as the
   * SMS settings save one. `registered: false` leaves the bare account, with no number.
   */
  const smsAccount = async (values: { registered?: boolean; connection?: string } = {}) => {
    const [account] = await query<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name)
       values (app.business_id(), 'sms', 'Front desk line') returning id`,
    );
    if (account === undefined) throw new Error('Fixture rows missing.');
    const hex = () => randomUUID().replaceAll('-', '');
    // Unique in the install, as a real number is.
    const e164 = `+1555${String(Number.parseInt(hex().slice(0, 9), 16) % 10_000_000).padStart(7, '0')}`;
    if (values.registered !== false) {
      const [secret] = await query<{ id: string }>(
        `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
         values (app.agency_id(), app.business_id(), 'sms.credentials', 1,
                 decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'))
         returning id`,
      );
      const [connection] = await query<{ id: string }>(
        `insert into messaging.provider_connections
           (agency_id, business_id, provider, label, account_ref, secret_id, status)
         values (app.agency_id(), app.business_id(), 'twilio', 'Twilio', $1, $2, $3)
         returning id`,
        [`AC${hex()}`, secret?.id, values.connection ?? 'connected'],
      );
      await query(
        `insert into messaging.phone_numbers
           (business_id, id, e164, provider_connection_id, provider_number_ref)
         values (app.business_id(), $1, $2, $3, $4)`,
        [account.id, e164, connection?.id, `PN${hex()}`],
      );
    }
    return { id: account.id, publicId: toPublicId('channel_account', account.id), e164 };
  };

  /**
   * Stores a message from the contact with the statements inbound.ts runs for a stored
   * email: the conversation upsert, the message, then the conversation's counters.
   */
  const receive = async (
    from: { id: string; email: string },
    mailboxId: string,
    text: string,
    values: { subject?: string; at?: Date; automated?: boolean } = {},
  ) =>
    database.withTenant({ ...context, actorKind: 'system', correlationId: randomUUID() }, (sql) =>
      receiveWith(sql, from, mailboxId, text, values),
    );

  return {
    agency,
    business,
    user,
    context,
    query,
    as,
    contact,
    mailbox,
    smsAccount,
    receive,
    /** What the commands recorded for this business: events in order, with their payloads. */
    events: () =>
      database.as('crm_owner', (sql) =>
        sql.query<{ type: string; subject_kind: string; payload: unknown }>(
          `select type, subject_kind, payload from events.events
           where business_id = $1 order by recorded_at, id`,
          [business.id],
        ),
      ),
    /** The audit log's rows for this business, with the input each kept. */
    audit: () =>
      database.as('crm_owner', (sql) =>
        sql.query<{ command: string; outcome: string; input: unknown }>(
          `select command, outcome, input from audit.commands
           where business_id = $1 order by recorded_at, id`,
          [business.id],
        ),
      ),
    /** How many delivery jobs wait in the queue for this business's messages. */
    async queuedDeliveries(): Promise<number> {
      const messages = await query<{ id: string }>('select id from messaging.messages');
      const [row] = await database.as('crm_owner', (sql) =>
        sql.query<{ n: number }>(
          'select count(*)::int as n from graphile_worker.jobs where key = any($1::text[])',
          [messages.map((message) => `outbound:${message.id}`)],
        ),
      );
      return row?.n ?? 0;
    },
    /** Takes a queued message through dispatch with the given provider answer. */
    async dispatch(messageId: string, delivery: Delivery = 'accepted'): Promise<number> {
      let deliveries = 0;
      const task = createDispatchOutboundTask({
        deliver: () => {
          deliveries += 1;
          return delivery === 'throws'
            ? Promise.reject(new Error('Provider failure'))
            : Promise.resolve(
                delivery === 'accepted'
                  ? { outcome: delivery, providerId: randomUUID() }
                  : { outcome: delivery },
              );
        },
      });
      await task.run(
        { messageId },
        {
          invocation: {
            context: { ...context, actorKind: 'system', correlationId: randomUUID() },
            permissions: 'all',
          },
          services: world.services,
        },
      );
      return deliveries;
    },
  };
}

interface Sql {
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Row[]>;
}

/** The inbound statements, inside a transaction the caller controls. */
export async function receiveWith(
  sql: Sql,
  from: { id: string; email: string },
  mailboxId: string,
  text: string,
  values: { subject?: string; at?: Date; automated?: boolean } = {},
): Promise<{ conversationId: string; messageId: string }> {
  const [conversation] = await sql.query<{ id: string }>(
    `insert into messaging.conversations (business_id, contact_id)
     values (app.business_id(), $1)
     on conflict (business_id, contact_id) do update set contact_id = excluded.contact_id
     returning id`,
    [from.id],
  );
  if (conversation === undefined) throw new Error('No conversation.');
  const [message] = await sql.query<{ id: string }>(
    `insert into messaging.messages
       (business_id, conversation_id, channel, channel_account_id, direction, status, subject,
        body_text, from_address, automated, author_kind, author_id, created_at)
     values (app.business_id(), $1, 'email', $2, 'inbound', 'received', $3, $4, $5, $6,
             'contact', $7, coalesce($8, now()))
     returning id`,
    [
      conversation.id,
      mailboxId,
      values.subject ?? null,
      text,
      from.email,
      values.automated ?? false,
      from.id,
      values.at ?? null,
    ],
  );
  if (message === undefined) throw new Error('No message.');
  await sql.query(
    `update messaging.conversations
     set status = 'open', snoozed_until = null, needs_reply = true,
         unread_count = unread_count + 1,
         last_message_at = greatest(last_message_at, coalesce($2, now())),
         last_inbound_at = greatest(last_inbound_at, coalesce($2, now()))
     where id = $1`,
    [conversation.id, values.at ?? null],
  );
  return { conversationId: conversation.id, messageId: message.id };
}
