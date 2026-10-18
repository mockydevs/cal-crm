// Who is on a business's team, for the notifications that go to whoever does a kind of
// work rather than to one named person. Read under row-level security, as the job's
// business or the agency.
import type { Permission } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';

import { holdersOf, type MemberRole } from './rules.js';

/**
 * The people whose role allows any of these permissions where the context works: in a
 * business, its members and the agency's staff; at the agency, its staff. A built-in role's
 * permissions come from this release's code and a custom role's from its row, which is why
 * this is worked out here and not in SQL.
 */
export async function membersHolding(
  trx: DatabaseTransaction,
  context: TenantContext,
  anyOf: readonly Permission[],
): Promise<string[]> {
  const { businessId } = context;
  const rows = await trx
    .selectFrom('tenancy.memberships as member')
    .innerJoin('tenancy.roles as role', (join) =>
      join.onRef('role.agency_id', '=', 'member.agency_id').onRef('role.id', '=', 'member.role_id'),
    )
    .select(['member.user_id', 'role.scope', 'role.key', 'role.is_builtin', 'role.permissions'])
    .where('member.agency_id', '=', context.agencyId)
    .where((eb) =>
      businessId === undefined
        ? eb('member.business_id', 'is', null)
        : eb.or([eb('member.business_id', '=', businessId), eb('member.business_id', 'is', null)]),
    )
    // The same order every time, so the same people are told in the same order.
    .orderBy('member.user_id')
    .execute();
  const members: MemberRole[] = rows.map((row) => ({
    userId: row.user_id,
    scope: row.scope === 'agency' ? 'agency' : 'business',
    key: row.key,
    isBuiltin: row.is_builtin,
    permissions: row.permissions,
  }));
  return holdersOf(members, anyOf, businessId === undefined ? 'agency' : 'business');
}

/**
 * Everyone with a membership of the business itself. The agency's staff can work in every
 * business of the agency, and are not "everyone in this business": an automation that
 * tells everyone would otherwise tell them for each business it runs in.
 */
export async function everyoneIn(trx: DatabaseTransaction, businessId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom('tenancy.memberships')
    .select('user_id')
    .where('business_id', '=', businessId)
    .orderBy('user_id')
    .execute();
  return rows.map((row) => row.user_id);
}

/** The team a business's work can be told to: its own members and the agency's staff. */
function teamOf(trx: DatabaseTransaction, context: TenantContext) {
  const { businessId } = context;
  return trx
    .selectFrom('tenancy.memberships')
    .select('user_id')
    .where('agency_id', '=', context.agencyId)
    .where((eb) =>
      businessId === undefined
        ? eb('business_id', 'is', null)
        : eb.or([eb('business_id', '=', businessId), eb('business_id', 'is', null)]),
    );
}

const distinct = (rows: readonly { readonly user_id: string }[]): string[] => [
  ...new Set(rows.map((row) => row.user_id)),
];

/**
 * The people these memberships are of, as long as each is still on the team where the
 * context works. A membership that was removed names nobody.
 */
export async function peopleOfMemberships(
  trx: DatabaseTransaction,
  context: TenantContext,
  membershipIds: readonly string[],
): Promise<string[]> {
  if (membershipIds.length === 0) return [];
  return distinct(
    await teamOf(trx, context)
      .where('id', 'in', [...new Set(membershipIds)])
      .orderBy('user_id')
      .execute(),
  );
}

/** Whether this person is on the team where the context works. */
export async function isOnTeam(
  trx: DatabaseTransaction,
  context: TenantContext,
  userId: string,
): Promise<boolean> {
  const rows = await teamOf(trx, context).where('user_id', '=', userId).limit(1).execute();
  return rows.length > 0;
}
