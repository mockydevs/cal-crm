// The contacts a deal is with, as the opportunity dialog sets them: one primary contact and
// up to ten others, replaced together under a revision. They are the links of the
// deal_contact type (contact-links.ts): nothing here is a second model.
import { defineCommand, requireBusiness, type Command, type CommandContext } from '@repo/commands';
import { setDealContactsCommandInput, type DealDetails } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, toPublicId, ValidationError } from '@repo/kernel';

import { requireRevision } from '../contacts/details.js';
import { requireRecord } from '../records/access.js';
import { contactsRevisionOf, readDealDetails, type DealPeopleOptions } from './details.js';
import { DEAL_CONTACT_LINK } from './link-type.js';
import { holdOwnerRules } from './owner-rules.js';

/** The contacts a deal is to be with: public ids, the primary apart from the others. */
export interface WantedContacts {
  readonly primaryContactId: string | null;
  readonly additionalContactIds: readonly string[];
}

/** The link type every business is seeded with, held until the transaction ends. */
async function contactLinkType(trx: DatabaseTransaction, businessId: string): Promise<string> {
  const row = await trx
    .selectFrom('crm.link_types')
    .select(['id', 'archived_at', 'allows_primary'])
    .where('business_id', '=', businessId)
    .where('key', '=', DEAL_CONTACT_LINK)
    .forShare()
    .executeTakeFirst();
  if (row?.archived_at !== null || !row.allows_primary)
    throw new ConflictError(
      'Deal contacts are unavailable. Ask an administrator to check the link configuration.',
    );
  return row.id;
}

/**
 * A contact of this business that is not in the trash, locked until the link is written.
 * One that isn't is refused where the request named it, not as a missing page.
 */
async function lockContact(trx: DatabaseTransaction, id: string, path: string): Promise<string> {
  let record: Awaited<ReturnType<typeof requireRecord>> | undefined;
  try {
    record = await requireRecord(trx, id, true);
  } catch (error) {
    if (error instanceof ConflictError)
      throw new ValidationError([
        {
          path,
          code: 'contact_in_trash',
          message: 'Restore this contact from the trash before linking it.',
        },
      ]);
    if (!(error instanceof NotFoundError)) throw error;
  }
  if (record?.kind === 'contact') return record.id;
  throw new ValidationError([
    { path, code: 'unknown_contact', message: 'Choose a contact of this business.' },
  ]);
}

/**
 * Makes the deal's contacts what the request says, and reports each link made, changed or
 * removed as its own event on the deal's and the contact's timelines. The caller holds the
 * deal's row. Contacts are locked in id order, after the deal, as every deal link change
 * does, so two changes can't deadlock.
 */
export async function writeDealContacts(
  trx: DatabaseTransaction,
  command: CommandContext,
  dealId: string,
  wanted: WantedContacts,
): Promise<void> {
  const businessId = requireBusiness(command.context);
  const current = await trx
    .selectFrom('crm.record_links as link')
    .innerJoin('crm.link_types as type', (join) =>
      join
        .onRef('type.business_id', '=', 'link.business_id')
        .onRef('type.id', '=', 'link.link_type_id'),
    )
    .select(['link.id', 'link.to_record_id', 'link.is_primary'])
    .where('link.business_id', '=', businessId)
    .where('link.from_record_id', '=', dealId)
    .where('type.key', '=', DEAL_CONTACT_LINK)
    .execute();
  const held = new Map(current.map((row) => [toPublicId('contact', row.to_record_id), row]));
  const named = [
    ...(wanted.primaryContactId === null
      ? []
      : [{ id: wanted.primaryContactId, path: '/primaryContactId' }]),
    ...wanted.additionalContactIds.map((id, index) => ({
      id,
      path: `/additionalContactIds/${String(index)}`,
    })),
  ];
  const removed = current.filter(
    (row) => !named.some((each) => each.id === toPublicId('contact', row.to_record_id)),
  );
  const added = named
    .filter((each) => !held.has(each.id))
    .sort((left, right) => (left.id < right.id ? -1 : 1));
  const repointed = named.filter((each) => {
    const link = held.get(each.id);
    return link !== undefined && link.is_primary !== (each.id === wanted.primaryContactId);
  });
  if (removed.length + added.length + repointed.length === 0) return;

  const typeId = await contactLinkType(trx, businessId);
  const contactIds = new Map<string, string>();
  for (const each of added) contactIds.set(each.id, await lockContact(trx, each.id, each.path));
  const event = (type: string, contactId: string, payload: Record<string, unknown>) =>
    command.emit({
      type,
      subject: { kind: 'deal', id: dealId },
      records: [dealId, contactId],
      payload: { contactId: toPublicId('contact', contactId), ...payload },
    });
  const source = {
    source_kind: command.context.actorKind,
    source_id: command.context.actorId ?? null,
  };

  // The primary before steps down first: a deal has one primary link at any moment.
  for (const each of repointed.filter((one) => one.id !== wanted.primaryContactId)) {
    const link = held.get(each.id);
    if (link === undefined) continue;
    await trx
      .updateTable('crm.record_links')
      .set({ is_primary: false, ...source })
      .where('business_id', '=', businessId)
      .where('id', '=', link.id)
      .execute();
    await event('deal.contact_link_changed', link.to_record_id, { primary: false });
  }
  for (const row of removed) {
    await trx
      .deleteFrom('crm.record_links')
      .where('business_id', '=', businessId)
      .where('id', '=', row.id)
      .execute();
    await event('deal.contact_unlinked', row.to_record_id, {});
  }
  for (const each of repointed.filter((one) => one.id === wanted.primaryContactId)) {
    const link = held.get(each.id);
    if (link === undefined) continue;
    await trx
      .updateTable('crm.record_links')
      .set({ is_primary: true, ...source })
      .where('business_id', '=', businessId)
      .where('id', '=', link.id)
      .execute();
    await event('deal.contact_link_changed', link.to_record_id, { primary: true });
  }
  // In the order the request named them: the primary, then the others.
  for (const each of named.filter((one) => contactIds.has(one.id))) {
    const contactId = contactIds.get(each.id) ?? '';
    const primary = each.id === wanted.primaryContactId;
    await trx
      .insertInto('crm.record_links')
      .values({
        business_id: businessId,
        link_type_id: typeId,
        from_record_id: dealId,
        to_record_id: contactId,
        is_primary: primary,
        ...source,
      })
      .execute();
    await event('deal.contact_linked', contactId, { primary });
  }
}

/** The public ids of the contacts a deal is with now. */
async function heldContacts(
  trx: DatabaseTransaction,
  businessId: string,
  dealId: string,
): Promise<{ primary: string | null; additional: string[] }> {
  const rows = await trx
    .selectFrom('crm.record_links as link')
    .innerJoin('crm.link_types as type', (join) =>
      join
        .onRef('type.business_id', '=', 'link.business_id')
        .onRef('type.id', '=', 'link.link_type_id'),
    )
    .select(['link.to_record_id', 'link.is_primary'])
    .where('link.business_id', '=', businessId)
    .where('link.from_record_id', '=', dealId)
    .where('type.key', '=', DEAL_CONTACT_LINK)
    .execute();
  const id = (row: { to_record_id: string }) => toPublicId('contact', row.to_record_id);
  return {
    primary: rows.filter((row) => row.is_primary).map(id)[0] ?? null,
    additional: rows.filter((row) => !row.is_primary).map(id),
  };
}

export function setDealContactsCommand(
  options: DealPeopleOptions,
): Command<typeof setDealContactsCommandInput, DealDetails> {
  return defineCommand({
    name: 'deal.set_contacts',
    permission: 'deals.manage',
    input: setDealContactsCommandInput,
    async handle(trx, input, command): Promise<DealDetails> {
      const businessId = requireBusiness(command.context);
      // In turn with the owner changes that write on linked records (owner-rules.ts).
      await holdOwnerRules(trx, businessId);
      // The deal first, then its contacts: the order of every deal link change. The lock
      // also keeps trash and purge out until the links are written.
      // The input takes a deal's id and no other, so the record held is a deal.
      const deal = await requireRecord(trx, input.id, true);
      const held = await heldContacts(trx, businessId, deal.id);
      requireRevision(
        "This deal's contacts",
        contactsRevisionOf(held.primary, held.additional),
        input.revision,
      );
      await writeDealContacts(trx, command, deal.id, input);
      return readDealDetails(trx, command, input.id, options);
    },
  });
}
