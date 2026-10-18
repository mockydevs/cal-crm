// What the notifications module's Postgres tests share: a business with people of each
// built-in role, the things an event is about (a conversation, a task, a form, an
// appointment), events written as a command writes them, and what each person was told.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import type { ActorKind, TenantContext } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, inject } from 'vitest';

export interface Suite {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly services: Services;
}

/** A database of the test file's own, and the crm_app pool the module works through. */
export function suite(): Suite {
  const shared: { database?: TestDatabase; db?: Database } = {};
  beforeAll(async () => {
    shared.database = await testDatabase(inject('databaseServer'));
    shared.db = connectDatabase({
      connectionString: shared.database.url('crm_app'),
      // A race test holds two transactions open while a third looks on.
      maxConnections: 4,
      onConnectionError: () => undefined,
    });
  });
  afterAll(async () => {
    await shared.db?.destroy();
    await shared.database?.close();
  });
  const need = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('The suite has not started yet.');
    return value;
  };
  return {
    get database() {
      return need(shared.database);
    },
    get db() {
      return need(shared.db);
    },
    get services() {
      return { db: need(shared.db), authorize: allowEveryone };
    },
  };
}

export interface Person {
  readonly id: string;
  /** The person acting themselves in the business. */
  readonly context: TenantContext;
  readonly invocation: Invocation;
}

export interface Place {
  readonly agencyId: string;
  readonly businessId: string;
  /** The worker, in the business. */
  readonly system: TenantContext;
  /** The business's owner. */
  readonly owner: Person;
  /** Someone with the built-in role, added to the business (or the agency's staff). */
  readonly join: (role: Role) => Promise<Person>;
}

export type Role =
  | 'owner'
  | 'admin'
  | 'member'
  | 'viewer'
  | { readonly agency: 'owner' | 'admin' | 'member' }
  | { readonly custom: readonly string[] };

let roles = 0;

export async function place(suite: Suite): Promise<Place> {
  const { database } = suite;
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const system: TenantContext = { ...business.context, correlationId: randomUUID() };
  const acting = (userId: string): Person => {
    const context: TenantContext = { ...system, userId, actorKind: 'user', actorId: userId };
    return { id: userId, context, invocation: { context, permissions: 'all' } };
  };
  const join = async (role: Role): Promise<Person> => {
    const { id } = await database.fixtures.user();
    await database.as('crm_owner', async (sql) => {
      const atAgency = typeof role === 'object' && 'agency' in role;
      const scope = atAgency ? 'agency' : 'business';
      const custom = typeof role === 'object' && 'custom' in role ? role.custom : undefined;
      const key = atAgency
        ? role.agency
        : custom === undefined
          ? role
          : `custom_${String(++roles)}`;
      const stored = await sql.one<{ id: string }>(
        `insert into tenancy.roles (agency_id, scope, key, name, is_builtin, permissions)
         values ($1, $2, $3, $3, $4, $5)
         on conflict (agency_id, scope, key) do update set name = excluded.name returning id`,
        [agency.id, scope, key, custom === undefined, custom ?? []],
      );
      await sql.query(
        `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
         values ($1, $2, $3, $4)`,
        [id, agency.id, atAgency ? null : business.id, stored.id],
      );
    });
    return acting(id);
  };
  return { agencyId: agency.id, businessId: business.id, system, owner: await join('owner'), join };
}

/** The worker with no business selected: the agency as a whole. */
export function atAgency(at: Place): TenantContext {
  const { businessId: _business, ...agency } = at.system;
  return agency;
}

/** An event as a command writes it, and its id. */
export async function event(
  suite: Suite,
  at: Place,
  type: string,
  values: {
    subject: { kind: string; id: string };
    payload?: Readonly<Record<string, unknown>>;
    actor?: { kind: ActorKind; id: string | null };
  },
): Promise<string> {
  const { id } = await suite.database.withTenant(at.system, (sql) =>
    sql.one<{ id: string }>(
      `insert into events.events
         (agency_id, business_id, type, actor_kind, actor_id, correlation_id, subject_kind,
          subject_id, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        at.agencyId,
        at.businessId,
        type,
        values.actor?.kind ?? 'system',
        values.actor?.id ?? null,
        at.system.correlationId,
        values.subject.kind,
        values.subject.id,
        JSON.stringify(values.payload ?? {}),
      ],
    ),
  );
  return id;
}

export interface ToldRow {
  readonly id: string;
  readonly user_id: string;
  readonly kind: string;
  readonly source_key: string;
  readonly collapse_key: string | null;
  readonly event_id: string | null;
  readonly actor_kind: string;
  readonly actor_id: string | null;
  readonly subject_kind: string;
  readonly subject_id: string | null;
  readonly record_id: string | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly read_at: Date | null;
}

/** Everything written for a business, oldest first, read as the owner of the schema. */
export function toldIn(suite: Suite, at: Place): Promise<ToldRow[]> {
  return suite.database.as('crm_owner', (sql) =>
    sql.query<ToldRow>(
      `select id, user_id, kind, source_key, collapse_key, event_id, actor_kind, actor_id,
              subject_kind, subject_id, record_id, title, body, read_at
       from notifications.notifications where business_id = $1 order by id`,
      [at.businessId],
    ),
  );
}

/** Who was told what, in a business: [kind, person] pairs, sorted. */
export async function whoWasTold(suite: Suite, at: Place): Promise<[string, string][]> {
  return (await toldIn(suite, at))
    .map((row): [string, string] => [row.kind, row.user_id])
    .sort(([kindA, userA], [kindB, userB]) =>
      `${kindA}:${userA}`.localeCompare(`${kindB}:${userB}`),
    );
}

export interface Things {
  readonly contactId: string;
  readonly conversation: (assignee?: string | null) => Promise<string>;
  readonly task: (values?: {
    assignee?: string | null;
    dueIn?: string | null;
    title?: string;
    recordId?: string | null;
    completed?: boolean;
  }) => Promise<string>;
  readonly form: (name?: string) => Promise<string>;
  readonly appointment: (assignee?: string | null) => Promise<string>;
}

let keys = 0;

/** The things events are about, in a business, with one contact they concern. */
export async function things(suite: Suite, at: Place): Promise<Things> {
  const { database } = suite;
  const contact = await database.fixtures.contact(at.system, {
    firstName: 'Jordan',
    lastName: 'Lee',
  });
  const one = (text: string, values: readonly unknown[]) =>
    database
      .withTenant(at.system, (sql) => sql.one<{ id: string }>(text, values))
      .then(({ id }) => id);
  let calendar: string | undefined;
  let slot = 0;
  let conversations = 0;
  return {
    contactId: contact.id,
    conversation: async (assignee = null) => {
      // A contact has one conversation: the first is the shared contact's, and each one
      // after it is with a contact of its own.
      conversations += 1;
      const withContact =
        conversations === 1 ? contact.id : (await database.fixtures.contact(at.system)).id;
      return one(
        `insert into messaging.conversations (business_id, contact_id, assignee_user_id)
         values ($1, $2, $3) returning id`,
        [at.businessId, withContact, assignee],
      );
    },
    task: (values = {}) =>
      one(
        `insert into crm.tasks (business_id, record_id, title, due_at, assignee_user_id,
                                created_by_kind, completed_at, completed_by_kind)
         values ($1, $2, $3, now() + $4::interval, $5, 'system',
                 case when $6 then now() end, case when $6 then 'system' end)
         returning id`,
        [
          at.businessId,
          values.recordId === undefined ? contact.id : values.recordId,
          values.title ?? 'Call the venue back',
          values.dueIn ?? null,
          values.assignee ?? null,
          values.completed === true,
        ],
      ),
    form: (name = 'Enquiry') =>
      one(
        `insert into forms.forms (business_id, name, definition, public_key)
         values ($1, $2, '{"fields": []}', $3) returning id`,
        [at.businessId, name, `pk_test_notify_${String(++keys).padStart(6, '0')}`],
      ),
    appointment: async (assignee = null) => {
      calendar ??= await one(
        `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
         values ($1, 'Consultations', 'round_robin', 'UTC', $2) returning id`,
        [at.businessId, `consult-${randomUUID().slice(0, 8)}`],
      );
      slot += 1;
      // Each appointment a day after the last, so no two of one person's ever overlap.
      return one(
        `insert into calendar.appointments
           (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at, source)
         values ($1, $2, $3, $4, 'Consultations', now() + make_interval(days => $5),
                 now() + make_interval(days => $5, hours => 1), 'booking_page')
         returning id`,
        [at.businessId, calendar, contact.id, assignee, slot],
      );
    },
  };
}
