// Signing in with an API key: the key's hash finds it through crm_auth, before any tenant
// context exists. The tenancy module makes and revokes keys.
import { createHash } from 'node:crypto';

import {
  agencyApiKeyScopes,
  apiKeyFormat,
  apiKeyReadGroups,
  apiKeyScopes,
  SLUG,
  type ApiKeyReadGroup,
  type Permission,
} from '@repo/contracts';
import type { Database } from '@repo/db';
import { sql } from 'kysely';

/** A request-local business selector, resolved before establishing tenant context. */
export interface ApiKeyTarget {
  readonly businessId?: string;
  readonly businessSlug?: string;
}

/** What a working key gives a request: its workplace and access policy. */
export interface ApiKeyAccess {
  readonly keyId: string;
  readonly agencyId: string;
  readonly businessId?: string;
  readonly scope?: 'agency' | 'business';
  readonly readOnly?: boolean;
  readonly readGroups?: readonly ApiKeyReadGroup[] | null;
  readonly permissions: ReadonlySet<Permission>;
}

const hashOf = (key: string) => createHash('sha256').update(key).digest();

const isReadGroup = (group: string): group is ApiKeyReadGroup =>
  (apiKeyReadGroups as readonly string[]).includes(group);

/**
 * The key's access, or undefined when it isn't one that works: unknown, revoked, expired,
 * or of a business that isn't active. Agency keys stay at the agency without a selector.
 * Business keys never leave their original business. Read on every request, so a
 * revoked key fails on its next. Notes when the key was used, at most once a minute.
 */
export async function findApiKey(
  db: Database,
  key: string,
  target?: ApiKeyTarget,
): Promise<ApiKeyAccess | undefined> {
  if (
    !apiKeyFormat.test(key) ||
    (target?.businessId !== undefined && target.businessSlug !== undefined) ||
    (target?.businessSlug !== undefined && !SLUG.test(target.businessSlug))
  ) {
    return undefined;
  }
  const row = await db
    .selectFrom('tenancy.api_keys as k')
    .leftJoin('tenancy.businesses as b', 'b.id', 'k.business_id')
    .select(['k.id', 'k.agency_id', 'k.business_id', 'k.scopes', 'k.read_only', 'k.read_groups'])
    .where('k.key_hash', '=', hashOf(key))
    .where('k.revoked_at', 'is', null)
    .where((eb) =>
      eb.or([eb('k.expires_at', 'is', null), eb('k.expires_at', '>', sql<Date>`now()`)]),
    )
    .where((eb) =>
      eb.or([
        eb('k.business_id', 'is', null),
        eb.and([eb('b.status', '=', 'active'), eb('b.agency_id', '=', eb.ref('k.agency_id'))]),
      ]),
    )
    .executeTakeFirst();
  if (row === undefined || (row.read_groups !== null && !row.read_groups.every(isReadGroup))) {
    return undefined;
  }
  let businessId = row.business_id ?? undefined;
  if (target?.businessId !== undefined || target?.businessSlug !== undefined) {
    let query = db
      .selectFrom('tenancy.businesses')
      .select('id')
      .where('agency_id', '=', row.agency_id)
      .where('status', '=', 'active');
    if (row.business_id !== null) query = query.where('id', '=', row.business_id);
    if (target.businessId !== undefined) query = query.where('id', '=', target.businessId);
    if (target.businessSlug !== undefined) query = query.where('slug', '=', target.businessSlug);
    const selected = await query.executeTakeFirst();
    if (selected === undefined) return undefined;
    businessId = selected.id;
  }
  await db
    .updateTable('tenancy.api_keys')
    .set({ last_used_at: sql<Date>`now()` })
    .where('id', '=', row.id)
    .where((eb) =>
      eb.or([
        eb('last_used_at', 'is', null),
        eb('last_used_at', '<', sql<Date>`now() - interval '1 minute'`),
      ]),
    )
    .execute();
  return {
    keyId: row.id,
    agencyId: row.agency_id,
    ...(businessId === undefined ? {} : { businessId }),
    ...(row.business_id === null ? { scope: 'agency' as const } : {}),
    ...(row.read_only ? { readOnly: true } : {}),
    ...(row.read_groups === null ? {} : { readGroups: row.read_groups.filter(isReadGroup) }),
    permissions: new Set(
      row.scopes.filter((scope): scope is Permission =>
        (
          (row.business_id === null ? agencyApiKeyScopes : apiKeyScopes) as readonly string[]
        ).includes(scope),
      ),
    ),
  };
}
