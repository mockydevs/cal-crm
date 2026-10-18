import { requireBusiness } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError, type TenantContext } from '@repo/kernel';

function membersIn(trx: DatabaseTransaction, context: TenantContext) {
  return trx
    .selectFrom('tenancy.memberships as m')
    .innerJoin('auth.users as u', 'u.id', 'm.user_id')
    .select(['m.id', 'm.user_id'])
    .where('m.agency_id', '=', context.agencyId)
    .where('m.business_id', '=', requireBusiness(context))
    .where('u.disabled_at', 'is', null);
}

/** Calendar membership is explicit: agency access alone does not make a person bookable. */
export async function resolveCalendarMember(
  trx: DatabaseTransaction,
  context: TenantContext,
  membershipId: string,
): Promise<string> {
  const query = membersIn(trx, context);
  const id = parsePublicId('membership', membershipId);
  const row =
    id === undefined
      ? undefined
      : await query.where('m.id', '=', id).forShare('m').executeTakeFirst();
  if (row === undefined)
    throw new ValidationError([
      {
        path: '/members',
        code: 'unavailable_member',
        message: 'Choose someone on this business team.',
      },
    ]);
  return row.user_id;
}

/** Current business memberships of the calendar's stored users; removed people are absent. */
export async function readCalendarMemberMemberships(
  trx: DatabaseTransaction,
  context: TenantContext,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const query = membersIn(trx, context);
  if (userIds.length === 0) return new Map();
  const rows = await query.where('m.user_id', 'in', [...new Set(userIds)]).execute();
  return new Map(rows.map((row) => [row.user_id, toPublicId('membership', row.id)]));
}
