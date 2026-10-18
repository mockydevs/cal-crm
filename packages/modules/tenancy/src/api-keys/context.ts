import {
  apiKeyScopes,
  agencyApiKeyScopes,
  apiKeyReadGroups,
  type ApiKeyContext,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ForbiddenError, type TenantContext, toPublicId } from '@repo/kernel';

/** Minimal self-discovery; the actor must be the actual key, never a person impersonated. */
export async function readApiKeyContext(
  trx: DatabaseTransaction,
  context: TenantContext,
): Promise<ApiKeyContext> {
  if (context.actorKind !== 'api_key' || context.actorId === undefined)
    throw new ForbiddenError('Use an API key to read its account context.');
  const row = await trx
    .selectFrom('tenancy.api_keys')
    .select(['business_id', 'scopes', 'read_only', 'read_groups', 'expires_at', 'revoked_at'])
    .where('id', '=', context.actorId)
    .executeTakeFirst();
  if (
    row?.revoked_at !== null ||
    (row.expires_at !== null && row.expires_at.getTime() <= Date.now())
  )
    throw new ForbiddenError('This API key no longer has access.');
  if (row.business_id !== null && row.business_id !== context.businessId)
    throw new ForbiddenError('The key does not belong to this account.');
  const agency = await trx
    .selectFrom('tenancy.agencies')
    .select(['name', 'slug'])
    .where('id', '=', context.agencyId)
    .executeTakeFirstOrThrow();
  const selected =
    context.businessId === undefined
      ? undefined
      : await trx
          .selectFrom('tenancy.businesses')
          .select(['id', 'name', 'slug'])
          .where('id', '=', context.businessId)
          .where('status', '=', 'active')
          .executeTakeFirst();
  if (context.businessId !== undefined && selected === undefined)
    throw new ForbiddenError('This business is not active.');
  const allowed = row.business_id === null ? agencyApiKeyScopes : apiKeyScopes;
  return {
    scope: row.business_id === null ? 'agency' : 'business',
    agency,
    business:
      selected === undefined
        ? null
        : { ...selected, id: toPublicId('business', selected.id), status: 'active' },
    scopes: allowed.filter((permission) => row.scopes.includes(permission)),
    readOnly: row.read_only,
    readGroups:
      row.read_groups === null
        ? null
        : apiKeyReadGroups.filter((group) => row.read_groups?.includes(group)),
    expiresAt: row.expires_at?.toISOString() ?? null,
  };
}
