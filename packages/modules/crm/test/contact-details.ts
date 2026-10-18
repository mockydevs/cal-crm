// What the contact page's tests share: a business with team members, and stand-ins for the
// lookups the server passes in from the tenancy and auth modules, which this module can't
// import. They read the same tables the real ones do, and can be gated to hold a command
// inside its transaction.
import { randomUUID } from 'node:crypto';

import type { Invocation } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError, type TenantContext } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';

import type { ContactDetailOptions } from '../src/contacts/details.js';

export interface Member {
  readonly userId: string;
  readonly membershipId: string;
  readonly name: string;
  /** Acts as this person, with every permission unless some are named. */
  as(permissions?: Invocation['permissions']): Invocation;
}

export interface Team {
  readonly businessId: string;
  readonly context: TenantContext;
  /** The system, with every permission. */
  system(): Invocation;
  member(name?: string): Promise<Member>;
  /** Takes someone off the team: their membership is deleted, as team.remove_member does. */
  remove(member: Member): Promise<void>;
}

export async function team(database: TestDatabase): Promise<Team> {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const role = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       values ($1, 'business', 'member', 'Member', true) returning id`,
      [agency.id],
    ),
  );
  const context = (): TenantContext => ({ ...business.context, correlationId: randomUUID() });
  return {
    businessId: business.id,
    context: business.context,
    system: () => ({ context: { ...context(), actorKind: 'system' }, permissions: 'all' }),
    async member(name = `Member ${randomUUID().slice(0, 8)}`) {
      const user = await database.fixtures.user({ name });
      const membership = await database.as('crm_owner', (sql) =>
        sql.one<{ id: string }>(
          `insert into tenancy.memberships (agency_id, business_id, role_id, user_id)
           values ($1, $2, $3, $4) returning id`,
          [agency.id, business.id, role.id, user.id],
        ),
      );
      return {
        userId: user.id,
        membershipId: toPublicId('membership', membership.id),
        name,
        as: (permissions = 'all') => ({
          context: { ...context(), actorKind: 'user', userId: user.id, actorId: user.id },
          permissions,
        }),
      };
    },
    remove: async (member) => {
      await database.as('crm_owner', (sql) =>
        sql.query('delete from tenancy.memberships where id = $1', [
          parsePublicId('membership', member.membershipId),
        ]),
      );
    },
  };
}

/** Called each time a member is resolved, inside the command's transaction. */
export interface Gate {
  whenResolving: () => Promise<void>;
}

/** The lookups, as tenancy's task-assignees.ts and auth's names.ts answer them. */
export function detailOptions(
  gate: Gate = { whenResolving: () => Promise.resolve() },
): ContactDetailOptions {
  const unavailable = () =>
    new ValidationError([
      { path: '/assignee', code: 'unavailable_assignee', message: 'Not on this team.' },
    ]);
  const eligible = (trx: DatabaseTransaction, context: TenantContext) => {
    const { businessId } = context;
    if (businessId === undefined) throw new Error('These lookups work inside a business.');
    return trx
      .selectFrom('tenancy.memberships')
      .select(['id', 'user_id'])
      .where('agency_id', '=', context.agencyId)
      .where((eb) => eb.or([eb('business_id', '=', businessId), eb('business_id', 'is', null)]));
  };
  const options: ContactDetailOptions = {
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
      async resolve(trx, context, selection) {
        if (selection === null) return null;
        await gate.whenResolving();
        const named = selection === 'me' ? context.userId : parsePublicId('membership', selection);
        if (named === undefined) throw unavailable();
        const row = await eligible(trx, context)
          .where(selection === 'me' ? 'user_id' : 'id', '=', named)
          .forShare()
          .executeTakeFirst();
        if (row === undefined) throw unavailable();
        return row.user_id;
      },
      async memberships(trx, context, userIds) {
        if (userIds.length === 0) return new Map();
        const rows = await eligible(trx, context)
          .where('user_id', 'in', [...userIds])
          .execute();
        return new Map(rows.map((row) => [row.user_id, toPublicId('membership', row.id)]));
      },
    },
  };
  return options;
}

/** Resolves once `count` sessions of this database wait for a lock: the superuser watches. */
export async function waitingForLock(database: TestDatabase, count = 1): Promise<void> {
  // A real signal, not a pause: it ends as soon as the sessions wait. The deadline is only
  // for a run in which they never do, so that the test fails and doesn't hang.
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('No session waited for a lock.');
    const [row] = await database.as('postgres', (sql) =>
      sql.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      ),
    );
    if ((row?.waiting ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
