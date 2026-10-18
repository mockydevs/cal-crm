// What a person's role allows in the business a job runs in, read when the job runs. A
// request's grants are worked out when it arrives; work that runs later on a person's
// behalf, such as a turn of the in-app assistant, reads them again here, so a role taken
// away between the request and the job is taken away from the job too.
//
// The rule is the request's own (the auth module's `workplace`): agency staff work in every
// business of their agency by their agency role; anyone else by their membership of this
// business, and only while the business is active. Someone who may no longer sign in, or
// who has no membership left, is allowed nothing.
import { requireBusiness } from '@repo/commands';
import { permissionsOf, type Permission } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';

/** The actual agency staff role, evaluated at both scopes for key delegation. */
export async function readAgencyKeyGrants(
  trx: DatabaseTransaction,
  context: TenantContext,
  userId: string,
): Promise<ReadonlySet<Permission> | undefined> {
  const row = await trx
    .selectFrom('tenancy.memberships as m')
    .innerJoin('tenancy.roles as r', 'r.id', 'm.role_id')
    .innerJoin('auth.users as u', 'u.id', 'm.user_id')
    .select(['r.scope', 'r.key', 'r.is_builtin', 'r.permissions'])
    .where('m.agency_id', '=', context.agencyId)
    .where('m.business_id', 'is', null)
    .where('m.user_id', '=', userId)
    .where('r.scope', '=', 'agency')
    .where('u.disabled_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const role = {
    scope: 'agency' as const,
    key: row.key,
    isBuiltin: row.is_builtin,
    permissions: row.permissions,
  };
  return new Set([...permissionsOf(role, 'agency'), ...permissionsOf(role, 'business')]);
}

/**
 * The permissions the person has in the context's business now, or undefined when they no
 * longer work there at all. Read in the caller's transaction, in the caller's business.
 */
export async function readPersonGrants(
  trx: DatabaseTransaction,
  context: TenantContext,
  userId: string,
): Promise<ReadonlySet<Permission> | undefined> {
  const businessId = requireBusiness(context);
  const person = await trx
    .selectFrom('auth.users')
    .select('disabled_at')
    .where('id', '=', userId)
    .executeTakeFirst();
  // Someone who is not there, and someone who may no longer sign in.
  if (person?.disabled_at !== null) return undefined;
  const memberships = await trx
    .selectFrom('tenancy.memberships as m')
    .innerJoin('tenancy.roles as r', 'r.id', 'm.role_id')
    .select(['m.business_id', 'r.scope', 'r.key', 'r.is_builtin', 'r.permissions'])
    .where('m.agency_id', '=', context.agencyId)
    .where('m.user_id', '=', userId)
    .where((eb) => eb.or([eb('m.business_id', '=', businessId), eb('m.business_id', 'is', null)]))
    .execute();
  // Staff first: an agency membership decides, as it does for a request.
  const staff = memberships.find((each) => each.business_id === null);
  const membership = staff ?? memberships.find((each) => each.business_id === businessId);
  if (membership === undefined) return undefined;
  if (staff === undefined) {
    const business = await trx
      .selectFrom('tenancy.businesses')
      .select('status')
      .where('id', '=', businessId)
      .executeTakeFirst();
    if (business?.status !== 'active') return undefined;
  }
  return permissionsOf(
    {
      scope: membership.scope === 'agency' ? 'agency' : 'business',
      key: membership.key,
      isBuiltin: membership.is_builtin,
      permissions: membership.permissions,
    },
    'business',
  );
}
