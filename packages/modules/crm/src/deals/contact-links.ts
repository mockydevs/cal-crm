// Which contacts a deal is with (DATABASE.md section 5.4), kept as links of the deal_contact
// type that seedBusinessDefaults gives every business: from the deal, to the contact, with
// one primary contact per deal. Nothing here makes the link type: a business without it,
// or with it archived, has no deal contacts, and is told so.
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import { publicId, type Deal } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import * as z from 'zod';

import { requireRecord } from '../records/access.js';
import { readDeal } from './deals.js';
import { DEAL_CONTACT_LINK } from './link-type.js';
import { holdOwnerRules } from './owner-rules.js';

export { DEAL_CONTACT_LINK };

/** The most deals of one contact a single read gives. */
export const CONTACT_DEALS_LIMIT = 50;

export const dealContactLinkInput = z.strictObject({
  id: publicId('deal'),
  contactId: publicId('contact'),
  /** Left out, an existing link keeps its primary state, and a new one isn't primary. */
  primary: z.boolean().optional(),
});

export interface DealContactLink {
  readonly dealId: string;
  readonly contactId: string;
  readonly isPrimary: boolean;
  readonly linkedAt: string;
}

async function linkType(trx: DatabaseTransaction, from: string, to: string): Promise<string> {
  const row = await trx
    .selectFrom('crm.link_types')
    .select(['id', 'archived_at', 'allows_primary'])
    .where('key', '=', DEAL_CONTACT_LINK)
    .where('from_object_type_id', '=', from)
    .where('to_object_type_id', '=', to)
    .forShare()
    .executeTakeFirst();
  if (row?.archived_at !== null || !row.allows_primary)
    throw new ConflictError(
      'Deal contacts are unavailable. Ask an administrator to check the link configuration.',
    );
  return row.id;
}

/**
 * Links a contact to a deal, or changes whether it is the deal's primary contact. Repeating
 * it changes nothing. It runs in the caller's transaction, so a deal created just before it
 * and its link are kept together or not at all.
 */
export const linkDealContactCommand = defineCommand({
  name: 'deal.link_contact',
  permission: 'deals.manage',
  input: dealContactLinkInput,
  async handle(trx, input, command): Promise<DealContactLink> {
    const businessId = requireBusiness(command.context);
    // In turn with the owner changes that write on linked records (owner-rules.ts).
    await holdOwnerRules(trx, businessId);
    // Every deal link change takes the deal first, then the contact, so two can't deadlock.
    // The locks also keep trash and purge out until the link is written.
    const deal = await requireRecord(trx, input.id, true);
    const contact = await requireRecord(trx, input.contactId, true);
    const typeId = await linkType(trx, deal.objectTypeId, contact.objectTypeId);
    const existing = await trx
      .selectFrom('crm.record_links')
      .select(['id', 'is_primary'])
      .where('business_id', '=', businessId)
      .where('from_record_id', '=', deal.id)
      .where('to_record_id', '=', contact.id)
      .where('link_type_id', '=', typeId)
      .executeTakeFirst();
    const primary = input.primary ?? existing?.is_primary ?? false;
    if (existing?.is_primary !== primary) {
      const changedRecords = new Set([deal.id, contact.id]);
      if (primary) {
        // One primary contact per deal: the one before stops being it.
        const previous = await trx
          .updateTable('crm.record_links')
          .set({ is_primary: false })
          .where('business_id', '=', businessId)
          .where('from_record_id', '=', deal.id)
          .where('link_type_id', '=', typeId)
          .where('is_primary', '=', true)
          .returning('to_record_id')
          .execute();
        for (const row of previous) changedRecords.add(row.to_record_id);
      }
      const source = {
        source_kind: command.context.actorKind,
        source_id: command.context.actorId ?? null,
      };
      if (existing === undefined)
        await trx
          .insertInto('crm.record_links')
          .values({
            business_id: businessId,
            link_type_id: typeId,
            from_record_id: deal.id,
            to_record_id: contact.id,
            is_primary: primary,
            ...source,
          })
          .execute();
      else
        await trx
          .updateTable('crm.record_links')
          .set({ is_primary: primary, ...source })
          .where('business_id', '=', businessId)
          .where('id', '=', existing.id)
          .execute();
      await command.emit({
        type: existing === undefined ? 'deal.contact_linked' : 'deal.contact_link_changed',
        subject: { kind: 'deal', id: deal.id },
        records: [...changedRecords],
        payload: { contactId: input.contactId, primary },
      });
    }
    const row = await trx
      .selectFrom('crm.record_links')
      .select('created_at')
      .where('business_id', '=', businessId)
      .where('from_record_id', '=', deal.id)
      .where('to_record_id', '=', contact.id)
      .where('link_type_id', '=', typeId)
      .executeTakeFirstOrThrow();
    return {
      dealId: input.id,
      contactId: input.contactId,
      isPrimary: primary,
      linkedAt: row.created_at.toISOString(),
    };
  },
});

/**
 * The deals linked to a contact that are not in the trash, newest first, at most
 * CONTACT_DEALS_LIMIT of them. A contact that isn't this business's is not found.
 */
export async function readContactDeals(
  trx: DatabaseTransaction,
  invocation: Invocation,
  contactId: string,
  query: {
    readonly status?: Deal['status'];
    readonly pipelineId?: string;
    readonly limit?: number;
  } = {},
): Promise<Deal[]> {
  const businessId = requireBusiness(invocation.context);
  const contact = await requireRecord(trx, contactId);
  if (contact.kind !== 'contact') throw new NotFoundError('Contact', contactId);
  // An id that isn't a pipeline's has no deals, and must not reach a uuid comparison.
  const pipelineId =
    query.pipelineId === undefined ? undefined : parsePublicId('pipeline', query.pipelineId);
  if (query.pipelineId !== undefined && pipelineId === undefined) return [];
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
    .select('deal.id')
    .where('link.business_id', '=', businessId)
    .where('link.to_record_id', '=', contact.id)
    .where('type.key', '=', DEAL_CONTACT_LINK)
    .where('deal.deleted_at', 'is', null);
  if (query.status !== undefined) linked = linked.where('deal.status', '=', query.status);
  if (pipelineId !== undefined) linked = linked.where('deal.pipeline_id', '=', pipelineId);
  const rows = await linked
    .orderBy('deal.id', 'desc')
    .limit(Math.min(Math.max(query.limit ?? CONTACT_DEALS_LIMIT, 1), CONTACT_DEALS_LIMIT))
    .execute();
  const deals: Deal[] = [];
  for (const row of rows) deals.push(await readDeal(trx, invocation, toPublicId('deal', row.id)));
  return deals;
}
