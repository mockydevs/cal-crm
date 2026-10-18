// What the opportunity dialog reads beside the deal itself: the contacts the deal is with,
// its owner and followers, and who made it. One read; every command of this folder's
// people.ts and of contacts.ts answers with it.
//
// The owner and the followers are the contact page's model (contacts/details.ts): people,
// resolved through the lookups the server hands over from the modules that own the team and
// people's names.
import { createHash } from 'node:crypto';

import { requireBusiness, type Invocation } from '@repo/commands';
import type { ContactPerson, Deal, DealContact, DealDetails, DealListExtra } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  actorKinds,
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  type TenantContext,
  ValidationError,
} from '@repo/kernel';

import { countryOf } from '../contacts/contacts.js';
import { ownerRevisionOf, type ContactDetailOptions } from '../contacts/details.js';
import { asContactPhone } from '../contacts/phones.js';
import { DEAL_CONTACT_LINK } from './link-type.js';

/** What this folder needs of the modules that own the team and people's names. */
export type DealPeopleOptions = Pick<ContactDetailOptions, 'actorNames' | 'assignees'>;

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Names the contacts a change was based on: the primary, and every other in id order. */
export const contactsRevisionOf = (primary: string | null, additional: readonly string[]): string =>
  digest(['contacts', primary, [...additional].sort()]);

/** A deal's row as the commands of this folder need it, locked until the transaction ends. */
export interface LockedDeal {
  readonly id: string;
  readonly owner_user_id: string | null;
}

/**
 * The deal, locked for a change, or not found. A deal in the trash is refused, as the deal
 * command refuses it.
 */
export async function lockLiveDeal(
  trx: DatabaseTransaction,
  businessId: string,
  id: string,
): Promise<LockedDeal> {
  const dealId = parsePublicId('deal', id);
  const row =
    dealId === undefined
      ? undefined
      : await trx
          .selectFrom('crm.deals')
          .select(['id', 'owner_user_id', 'deleted_at'])
          .where('business_id', '=', businessId)
          .where('id', '=', dealId)
          .forUpdate()
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Deal', id);
  if (row.deleted_at !== null) throw new ConflictError('Restore this deal before changing it.');
  return row;
}

/** How each of these users is shown: their membership now, their name, and whether it is you. */
export async function peopleOf(
  trx: DatabaseTransaction,
  context: TenantContext,
  options: DealPeopleOptions,
  userIds: readonly string[],
): Promise<(userId: string) => ContactPerson> {
  const people = [...new Set(userIds)];
  const memberships = await options.assignees.memberships(trx, context, people);
  const names = people.length === 0 ? undefined : await options.actorNames.user?.(trx, people);
  return (userId) => ({
    membershipId: memberships.get(userId) ?? null,
    name: names?.get(userId) ?? null,
    you: context.actorKind === 'user' && userId === context.userId,
  });
}

interface LinkedContacts {
  primary: DealContact | null;
  readonly additional: DealContact[];
}

/**
 * The contacts each of these deals is with: the primary, and the others by name. One read
 * for all of them. A contact in the trash stays linked and says so.
 */
export async function linkedContacts(
  trx: DatabaseTransaction,
  businessId: string,
  dealIds: readonly string[],
  primaryOnly = false,
): Promise<Map<string, LinkedContacts>> {
  const linked = new Map<string, LinkedContacts>();
  if (dealIds.length === 0) return linked;
  let links = trx
    .selectFrom('crm.record_links as link')
    .innerJoin('crm.link_types as type', (join) =>
      join
        .onRef('type.business_id', '=', 'link.business_id')
        .onRef('type.id', '=', 'link.link_type_id'),
    )
    .innerJoin('crm.contacts as c', (join) =>
      join.onRef('c.business_id', '=', 'link.business_id').onRef('c.id', '=', 'link.to_record_id'),
    )
    .select(['link.from_record_id', 'link.is_primary', 'c.id', 'c.display_name', 'c.deleted_at'])
    .select((select) =>
      (['email', 'phone'] as const).map((kind) =>
        select
          .selectFrom('crm.contact_identities as i')
          .select('i.value_normalized')
          .whereRef('i.business_id', '=', 'c.business_id')
          .whereRef('i.contact_id', '=', 'c.id')
          .where('i.kind', '=', kind)
          .where('i.is_primary', '=', true)
          .as(kind),
      ),
    )
    .where('link.business_id', '=', businessId)
    .where('link.from_record_id', 'in', [...dealIds])
    .where('type.key', '=', DEAL_CONTACT_LINK);
  if (primaryOnly) links = links.where('link.is_primary', '=', true);
  const rows = await links.orderBy('c.sort_name').orderBy('c.id').execute();
  const country = rows.length === 0 ? undefined : await countryOf(trx, businessId);
  for (const row of rows) {
    const contact: DealContact = {
      id: toPublicId('contact', row.id),
      name: row.display_name,
      email: row.email,
      phone: row.phone === null ? null : asContactPhone(row.phone, country),
      trashed: row.deleted_at !== null,
    };
    const of = linked.get(row.from_record_id) ?? { primary: null, additional: [] };
    if (row.is_primary) of.primary = contact;
    else of.additional.push(contact);
    linked.set(row.from_record_id, of);
  }
  return linked;
}

/** A deal of the transaction's business as the dialog shows it beside the deal, or not found. */
export async function readDealDetails(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  options: DealPeopleOptions,
): Promise<DealDetails> {
  const { context } = invocation;
  const businessId = requireBusiness(context);
  const dealId = parsePublicId('deal', id);
  const row =
    dealId === undefined
      ? undefined
      : await trx
          .selectFrom('crm.deals')
          .select(['id', 'owner_user_id', 'created_by_kind', 'created_by_id', 'created_at'])
          .select('deleted_at')
          .where('business_id', '=', businessId)
          .where('id', '=', dealId)
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Deal', id);

  const followers = await trx
    .selectFrom('crm.deal_followers')
    .select('user_id')
    .where('business_id', '=', businessId)
    .where('deal_id', '=', row.id)
    .orderBy('created_at')
    .orderBy('user_id')
    .execute();
  const person = await peopleOf(trx, context, options, [
    ...(row.owner_user_id === null ? [] : [row.owner_user_id]),
    ...followers.map((follower) => follower.user_id),
  ]);
  const contacts = (await linkedContacts(trx, businessId, [row.id])).get(row.id) ?? {
    primary: null,
    additional: [],
  };

  const createdKind = actorKinds.find((kind) => kind === row.created_by_kind) ?? 'system';
  const createdName =
    row.created_by_id === null
      ? undefined
      : (await options.actorNames[createdKind]?.(trx, [row.created_by_id]))?.get(row.created_by_id);

  return {
    id: toPublicId('deal', row.id),
    owner: row.owner_user_id === null ? null : person(row.owner_user_id),
    ownerRevision: ownerRevisionOf(row.owner_user_id),
    // Someone who left the team is left out, and follows again if they come back.
    followers: followers
      .map((follower) => person(follower.user_id))
      .filter((follower) => follower.membershipId !== null),
    primaryContact: contacts.primary,
    additionalContacts: contacts.additional,
    contactsRevision: contactsRevisionOf(
      contacts.primary?.id ?? null,
      contacts.additional.map((contact) => contact.id),
    ),
    createdBy: {
      kind: createdKind,
      name: createdName ?? null,
      you:
        createdKind === 'user' &&
        context.actorKind === 'user' &&
        row.created_by_id === context.userId,
    },
    createdAt: row.created_at.toISOString(),
    canManage:
      row.deleted_at === null &&
      (invocation.permissions === 'all' || invocation.permissions.has('deals.manage')),
    canReadAudit: invocation.permissions === 'all' || invocation.permissions.has('audit.read'),
  };
}

type Extras = Pick<Deal, 'primaryContact' | 'owner' | 'tags'>;

async function tagsOf(
  trx: DatabaseTransaction,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, NonNullable<Extras['tags']>>> {
  const rows = await trx
    .selectFrom('crm.record_tags as assigned')
    .innerJoin('crm.tags as tag', (join) =>
      join
        .onRef('tag.business_id', '=', 'assigned.business_id')
        .onRef('tag.id', '=', 'assigned.tag_id'),
    )
    .select(['assigned.record_id', 'tag.id', 'tag.name'])
    .where('assigned.business_id', '=', businessId)
    .where('assigned.record_id', 'in', [...ids])
    .orderBy('tag.name_key')
    .orderBy('tag.id')
    .execute();
  const tags = new Map<string, NonNullable<Extras['tags']>>();
  for (const row of rows) {
    const list = tags.get(row.record_id) ?? [];
    list.push({ id: toPublicId('tag', row.id), name: row.name });
    tags.set(row.record_id, list);
  }
  return tags;
}

/**
 * Reads what the request named for these deals of a page, and gives each row's share of it:
 * one read for each extra, whatever the size of the page. A row has only the members that
 * were asked for: without any, it is exactly what it was.
 */
export async function readDealExtras(
  trx: DatabaseTransaction,
  invocation: Invocation,
  deals: readonly { readonly id: string; readonly owner_user_id: string | null }[],
  extras: readonly DealListExtra[],
  options: DealPeopleOptions | undefined,
): Promise<(id: string) => Extras> {
  const businessId = requireBusiness(invocation.context);
  const wanted = new Set(extras);
  if (wanted.has('owner') && options === undefined)
    throw new ValidationError([
      { path: '/include', code: 'unavailable', message: 'Owners cannot be read here.' },
    ]);
  const ids = deals.map((deal) => deal.id);
  const present = ids.length > 0;
  const contacts =
    wanted.has('contact') && present ? await linkedContacts(trx, businessId, ids, true) : null;
  const tags = wanted.has('tags') && present ? await tagsOf(trx, businessId, ids) : null;
  const owners = new Map(deals.map((deal) => [deal.id, deal.owner_user_id]));
  const person =
    !wanted.has('owner') || options === undefined
      ? null
      : await peopleOf(
          trx,
          invocation.context,
          options,
          deals.flatMap((deal) => (deal.owner_user_id === null ? [] : [deal.owner_user_id])),
        );
  return (id) => {
    const owner = owners.get(id) ?? null;
    return {
      ...(wanted.has('contact') ? { primaryContact: contacts?.get(id)?.primary ?? null } : {}),
      ...(person === null ? {} : { owner: owner === null ? null : person(owner) }),
      ...(wanted.has('tags') ? { tags: tags?.get(id) ?? [] } : {}),
    };
  };
}
