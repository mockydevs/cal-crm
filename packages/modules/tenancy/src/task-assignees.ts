import { requireBusiness } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import {
  ForbiddenError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';

function eligible(trx: DatabaseTransaction, context: TenantContext) {
  const businessId = requireBusiness(context);
  return trx
    .selectFrom('tenancy.memberships')
    .select(['id', 'user_id', 'business_id'])
    .where('agency_id', '=', context.agencyId)
    .where((eb) => eb.or([eb('business_id', '=', businessId), eb('business_id', 'is', null)]));
}

/** Resolve and hold an eligible membership until the task transaction commits. */
export async function resolveTaskAssignee(
  trx: DatabaseTransaction,
  context: TenantContext,
  selection: string | null,
): Promise<string | null> {
  let query = eligible(trx, context);
  if (selection === null) return null;
  if (selection === 'me') {
    if (
      context.actorKind !== 'user' ||
      context.userId === undefined ||
      context.actorId !== context.userId
    )
      throw new ForbiddenError('Assign to me requires a signed-in person.');
    query = query.where('user_id', '=', context.userId);
  } else {
    const id = parsePublicId('membership', selection);
    if (id === undefined) throw unavailable();
    query = query.where('id', '=', id);
  }
  const row = await query.orderBy('business_id', 'asc').forShare().executeTakeFirst();
  if (row === undefined) throw unavailable();
  return row.user_id;
}

function unavailable(): ValidationError {
  return new ValidationError([
    {
      path: '/assignee',
      code: 'unavailable_assignee',
      message: 'Choose someone on this business or agency team, or leave the task unassigned.',
    },
  ]);
}

/**
 * The membership each stored assignee would be assigned through now, by user id, as a
 * public id: their membership of this business, or else of its agency. Someone with
 * neither, such as a person removed since, or in a sibling business or another agency, has
 * no entry. One batched read; it holds nothing, unlike resolveTaskAssignee.
 */
export async function readTaskAssigneeMemberships(
  trx: DatabaseTransaction,
  context: TenantContext,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  // Built first, so no business is refused even when there's nobody to look up.
  const members = eligible(trx, context);
  const wanted = [...new Set(userIds)];
  if (wanted.length === 0) return new Map();
  const rows = await members
    .where('user_id', 'in', wanted)
    .distinctOn('user_id')
    .orderBy('user_id')
    // Nulls sort last: the business membership comes before the agency one.
    .orderBy('business_id', 'asc')
    .execute();
  return new Map(rows.map((row) => [row.user_id, toPublicId('membership', row.id)]));
}

/**
 * Which of these memberships (mem_…) are on this business's team now: its own members
 * and the agency's staff. Each one that is, with the person it is of; one that was removed,
 * or is of another business, has no entry. One batched read; it holds nothing.
 */
export async function readTeamMemberships(
  trx: DatabaseTransaction,
  context: TenantContext,
  membershipIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  // Built first, so no business is refused even when there's nobody to look up.
  const members = eligible(trx, context);
  const wanted = [
    ...new Set(
      membershipIds.flatMap((id) => {
        const parsed = parsePublicId('membership', id);
        return parsed === undefined ? [] : [parsed];
      }),
    ),
  ];
  if (wanted.length === 0) return new Map();
  const rows = await members.where('id', 'in', wanted).execute();
  return new Map(rows.map((row) => [toPublicId('membership', row.id), row.user_id]));
}

export interface EligibleTaskMember {
  readonly id: string;
  readonly userId: string;
}
export interface EligibleTaskMembersPage {
  readonly items: readonly EligibleTaskMember[];
  readonly nextCursor: string | null;
}

/** One entry per person, preferring their business membership over their agency one. */
export async function readTaskAssignees(
  trx: DatabaseTransaction,
  context: TenantContext,
  after?: string,
): Promise<EligibleTaskMembersPage> {
  const members = trx
    .with('task_members', () =>
      eligible(trx, context).distinctOn('user_id').orderBy('user_id').orderBy('business_id', 'asc'),
    )
    .selectFrom('task_members')
    .select(['id', 'user_id']);
  const afterId = after === undefined ? undefined : parsePublicId('membership', after);
  if (after !== undefined) {
    const anchor =
      afterId === undefined
        ? undefined
        : await members.where('id', '=', afterId).executeTakeFirst();
    if (anchor === undefined)
      throw new ValidationError([
        {
          path: '/after',
          code: 'unknown_member',
          message: 'Start after someone in this business or agency team.',
        },
      ]);
  }
  let page = members.orderBy('id', 'asc').limit(51);
  if (afterId !== undefined) page = page.where('id', '>', afterId);
  const rows = await page.execute();
  const items = rows.slice(0, 50).map((row) => ({
    id: toPublicId('membership', row.id),
    userId: row.user_id,
  }));
  const last = items.at(-1);
  return { items, nextCursor: rows.length > 50 && last !== undefined ? last.id : null };
}
