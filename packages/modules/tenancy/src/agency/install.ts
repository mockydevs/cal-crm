// The agency an install serves, created on first start. The migrate container calls
// ensureAgency as crm_owner after the migrations, on every deploy: the first time it
// creates the agency and its built-in roles, and afterwards it only adds built-in roles a
// later version brings.
import type { Database } from '@repo/db';
import { sql } from 'kysely';

export interface BuiltInRole {
  readonly scope: 'agency' | 'business';
  readonly key: string;
  readonly name: string;
}

/**
 * Every agency's built-in roles and their permissions.
 * Agency roles are for the agency's own staff; business roles for the people of each of
 * its businesses.
 */
export const builtInRoles: readonly BuiltInRole[] = [
  { scope: 'agency', key: 'owner', name: 'Owner' },
  { scope: 'agency', key: 'admin', name: 'Admin' },
  { scope: 'agency', key: 'member', name: 'Member' },
  { scope: 'business', key: 'owner', name: 'Owner' },
  { scope: 'business', key: 'admin', name: 'Admin' },
  { scope: 'business', key: 'member', name: 'Member' },
  { scope: 'business', key: 'viewer', name: 'Viewer' },
];

/** A slug for an agency's name (tenancy.agencies' slug format), such as bluebird-digital. */
export function slugFor(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'agency' : slug;
}

/**
 * Creates the install's agency and its built-in roles when there's none, and otherwise
 * adds only the built-in roles it lacks. Roles the agency already has stay as they are.
 * Runs as crm_owner, before any tenant context exists. Two runs at once, as when a deploy
 * starts while another's migrate is still running, take turns, so only one creates it.
 */
export async function ensureAgency(
  owner: Database,
  agency: { readonly name: string },
): Promise<{ created: boolean; agencyId: string }> {
  return owner.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext('crm.ensure-agency'))`.execute(trx);
    const existing = await trx
      .selectFrom('tenancy.agencies')
      .select('id')
      .orderBy('created_at')
      .executeTakeFirst();
    const name = agency.name.trim();
    const agencyId =
      existing?.id ??
      (
        await trx
          .insertInto('tenancy.agencies')
          .values({ name, slug: slugFor(name) })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    await trx
      .insertInto('tenancy.roles')
      .values(
        builtInRoles.map((role) => ({
          agency_id: agencyId,
          scope: role.scope,
          key: role.key,
          name: role.name,
          is_builtin: true,
        })),
      )
      .onConflict((conflict) => conflict.constraint('roles_key_unique').doNothing())
      .execute();
    return { created: existing === undefined, agencyId };
  });
}
