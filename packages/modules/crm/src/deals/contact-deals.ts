// A contact's deals, as the contact page lists them: the deals linked to it by the
// deal_contact type, with whether it is each one's primary contact.
import { requireBusiness, type Invocation } from '@repo/commands';
import {
  CONTACT_DEALS_PAGE_SIZE,
  type ContactDeals,
  type contactDealsQuery,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import type * as z from 'zod';

import { requireRecord } from '../records/access.js';
import { readDeal } from './deals.js';
import { DEAL_CONTACT_LINK } from './link-type.js';

/**
 * The deals a contact is with that are not in the trash, newest first, at most
 * CONTACT_DEALS_PAGE_SIZE of them, each with whether the contact is its primary contact. A
 * contact that isn't this business's is not found.
 */
export async function readContactDealList(
  trx: DatabaseTransaction,
  invocation: Invocation,
  contactId: string,
  query: z.output<typeof contactDealsQuery>,
): Promise<ContactDeals> {
  const businessId = requireBusiness(invocation.context);
  const contact = await requireRecord(trx, contactId);
  if (contact.kind !== 'contact') throw new NotFoundError('Contact', contactId);
  const canManage = invocation.permissions === 'all' || invocation.permissions.has('deals.manage');
  // An id that isn't a pipeline's has no deals, and must not reach a uuid comparison.
  const pipelineId =
    query.pipelineId === undefined ? undefined : parsePublicId('pipeline', query.pipelineId);
  if (query.pipelineId !== undefined && pipelineId === undefined)
    return { items: [], more: false, canManage };
  let linked = trx
    .selectFrom('crm.record_links as link')
    .innerJoin('crm.link_types as type', (join) =>
      join
        .onRef('type.business_id', '=', 'link.business_id')
        .onRef('type.id', '=', 'link.link_type_id'),
    )
    .innerJoin('crm.deals as deal', (join) =>
      join
        .onRef('deal.business_id', '=', 'link.business_id')
        .onRef('deal.id', '=', 'link.from_record_id'),
    )
    .select(['deal.id', 'link.is_primary'])
    .where('link.business_id', '=', businessId)
    .where('link.to_record_id', '=', contact.id)
    .where('type.key', '=', DEAL_CONTACT_LINK)
    .where('deal.deleted_at', 'is', null);
  if (query.status !== 'all') linked = linked.where('deal.status', '=', query.status);
  if (pipelineId !== undefined) linked = linked.where('deal.pipeline_id', '=', pipelineId);
  const rows = await linked
    .orderBy('deal.id', 'desc')
    .limit(CONTACT_DEALS_PAGE_SIZE + 1)
    .execute();
  const items: ContactDeals['items'] = [];
  for (const row of rows.slice(0, CONTACT_DEALS_PAGE_SIZE))
    items.push({
      deal: await readDeal(trx, invocation, toPublicId('deal', row.id)),
      primary: row.is_primary,
    });
  return { items, more: rows.length > CONTACT_DEALS_PAGE_SIZE, canManage };
}
