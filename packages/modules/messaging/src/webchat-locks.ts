// The one lock order of everything that writes web chat: the business row, then a
// conversation, then a session. It is the order the outbound worker and the Inbox use for
// the first two (packages/db/migrations/0046_inbox.sql, private.number_message).
//
// Why the business comes first: the outbound worker and the Inbox's reply hold the business
// FOR UPDATE and then reach a conversation. A web chat writer that held a conversation or a
// session and only then needed the business (the foreign key of its event, its audit row
// and of the message's numbering trigger takes it FOR KEY SHARE) would wait for them
// while they wait for it.
import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';

/**
 * Takes the business row before anything else is locked, and says whether the business
 * exists and is active.
 *
 * `key share` is enough to keep the order and lets any number of visitors write at once.
 * `share` also makes a change of the business's status wait, for a writer whose decision
 * depends on the business being on.
 */
export async function holdBusinessIfActive(
  trx: DatabaseTransaction,
  context: TenantContext,
  strength: 'key share' | 'share' = 'key share',
): Promise<boolean> {
  if (context.businessId === undefined) return false;
  const query = trx
    .selectFrom('tenancy.businesses')
    .select('status')
    .where('id', '=', context.businessId)
    .where('agency_id', '=', context.agencyId);
  const business = await (
    strength === 'share' ? query.forShare() : query.forKeyShare()
  ).executeTakeFirst();
  return business?.status === 'active';
}
