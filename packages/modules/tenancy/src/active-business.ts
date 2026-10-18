import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';

/**
 * Holds the business as it is until the transaction ends, and says whether it is active.
 *
 * The lock is shared: any number of holders run at once, and a change of the business's
 * status waits for all of them. So a public writer that checks "is this business on?" and
 * then writes cannot be overtaken by a suspension in between. It is taken before any
 * other row, as every writer of a business does, and it is never upgraded by the holder:
 * the foreign keys of what the holder writes (its events, its audit row) take a weaker
 * lock on the same row.
 *
 * False for a business that is missing, belongs to another agency, or is not active.
 * Nothing is thrown: the caller decides what an unavailable business looks like.
 */
export async function holdActiveBusiness(
  trx: DatabaseTransaction,
  context: TenantContext,
): Promise<boolean> {
  if (context.businessId === undefined) return false;
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select('status')
    .where('id', '=', context.businessId)
    .where('agency_id', '=', context.agencyId)
    .forShare()
    .executeTakeFirst();
  return business?.status === 'active';
}
