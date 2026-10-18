// What the contact page reads beside the contact itself: the owner and followers, each
// address with its label, do not disturb, and how the contact came to be. One read; every
// command of this folder's people.ts, addresses.ts and dnd.ts answers with it.
//
// Who is on the team, what people are called and which addresses are blocked belong to
// other modules, so the server hands their lookups over.
import { createHash } from 'node:crypto';

import { requireBusiness, type Invocation } from '@repo/commands';
import {
  contactPhoneLabels,
  contactSources,
  dndChannels,
  type ContactAddress,
  type ContactDetails,
  type ContactPerson,
  type ContactSource,
  type DndChannel,
  type suppressionReasons,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  actorKinds,
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  type TenantContext,
} from '@repo/kernel';

import type { ActorNames } from '../activity/activity.js';
import { countryOf } from './contacts.js';
import { asContactPhone } from './phones.js';

/** An address of a contact that can't be sent to, as the module that owns sending says. */
export interface AddressBlock {
  readonly kind: 'email' | 'phone';
  /** The address as crm.contact_identities.value_normalized has it. */
  readonly value: string;
  readonly reason: (typeof suppressionReasons)[number];
  readonly since: Date;
}

/** What this folder needs of the modules that own the team, people's names and sending. */
/** What a bulk action on contacts needs of workflows (Contacts → Bulk Actions → Add to workflow). */
export interface BulkWorkflows {
  /**
   * The workflow named by its public id: its stored id when it is published and not paused,
   * not_published when it is this business's and is not, or not_found.
   */
  readonly resolve: (
    trx: DatabaseTransaction,
    invocation: Invocation,
    workflowId: string,
  ) => Promise<{ readonly id: string } | 'not_found' | 'not_published'>;
  /**
   * Holds the runs of these contacts still (ids sorted), as a start of a run and a merge
   * hold them: before a batch holds the contacts themselves, so a merge, which takes the
   * runs before the contacts, never waits for a batch that waits for it.
   */
  readonly hold?: (trx: DatabaseTransaction, contactIds: readonly string[]) => Promise<void>;
  /** Enrols one contact, by stored ids, by the rules every enrolment keeps. */
  readonly enrol: (
    trx: DatabaseTransaction,
    invocation: Invocation,
    workflowId: string,
    contactId: string,
  ) => Promise<'started' | 'already_running' | 'already_went_through' | 'unavailable'>;
}

export interface ContactDetailOptions {
  readonly actorNames: ActorNames;
  readonly assignees: {
    /** The user a membership id or "me" names, held on the team until the transaction ends. */
    readonly resolve: (
      trx: DatabaseTransaction,
      context: TenantContext,
      selection: string | null,
    ) => Promise<string | null>;
    /** The membership each of these users is on the team through now, by user id. */
    readonly memberships: (
      trx: DatabaseTransaction,
      context: TenantContext,
      userIds: readonly string[],
    ) => Promise<ReadonlyMap<string, string>>;
  };
  /**
   * The workflows a bulk action adds contacts to, which only the automation module knows.
   * Left out, no workflow can be chosen.
   */
  readonly workflows?: BulkWorkflows;
  readonly addressVerifications?: (
    trx: DatabaseTransaction,
    context: TenantContext,
    contactId: string,
  ) => Promise<
    readonly {
      readonly value: string;
      readonly verification: NonNullable<ContactAddress['verification']>;
    }[]
  >;
  /** The contact's addresses nothing can be sent to. Left out, no address shows a delivery. */
  readonly blockedAddresses?: (
    trx: DatabaseTransaction,
    context: TenantContext,
    contactId: string,
  ) => Promise<readonly AddressBlock[]>;
}

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Names the owner a change was based on, so a change over someone else's is refused. */
export const ownerRevisionOf = (ownerUserId: string | null): string =>
  digest(['owner', ownerUserId]);

/** A stored address, as far as a change to one can be stale. */
export interface AddressRow {
  readonly id: string;
  readonly kind: string;
  readonly value_normalized: string;
  readonly label: string | null;
  readonly is_primary: boolean;
}

/** Names the addresses a change was based on: every one, with its label and its place. */
export const addressesRevisionOf = (rows: readonly AddressRow[]): string =>
  digest([
    'addresses',
    ...[...rows]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((row) => [row.id, row.kind, row.value_normalized, row.label, row.is_primary]),
  ]);

/** The channels stored for a contact, as the contract names and orders them. */
export const storedDndChannels = (stored: readonly string[]): DndChannel[] =>
  dndChannels.filter((channel) => stored.includes(channel));

/** Names the do-not-disturb settings a change was based on, outbound and inbound. */
export const dndRevisionOf = (
  all: boolean,
  channels: readonly DndChannel[],
  inbound: boolean,
): string => digest(['dnd', all, storedDndChannels(channels), inbound]);

const stale = (what: string) =>
  new ConflictError(`${what} changed after you opened it. Reload the page and try again.`);

/** Refuses a change based on something someone else has since changed. */
export function requireRevision(what: string, current: string, given: string | undefined): void {
  if (given !== undefined && given !== current) throw stale(what);
}

/** A contact's row as the commands of this folder need it, locked until the transaction ends. */
export interface LockedContact {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly owner_user_id: string | null;
  readonly do_not_contact: boolean;
  readonly dnd_channels: string[];
  readonly dnd_inbound: boolean;
}

/**
 * The contact, locked for a change, or not found. A contact in the trash is refused, as the
 * contact command refuses it. It takes no lock beyond the contact's row: queueing a message
 * holds the business's row while it waits for the contact's.
 *
 * FOR NO KEY UPDATE, the lock PostgreSQL's own update takes when no key changes: two
 * changes to the contact still wait for each other, but a foreign key to the contact (a
 * stored message, through its conversation) does not wait for this one. A writer holding the
 * business row stores those, and this change then needs the business for its event's foreign
 * key: with FOR UPDATE here the two would wait for each other in opposite orders.
 */
export async function lockLiveContact(
  trx: DatabaseTransaction,
  businessId: string,
  id: string,
): Promise<LockedContact> {
  const contactId = parsePublicId('contact', id);
  const row =
    contactId === undefined
      ? undefined
      : await trx
          .selectFrom('crm.contacts')
          .select([
            'id',
            'first_name',
            'last_name',
            'owner_user_id',
            'do_not_contact',
            'dnd_channels',
            'dnd_inbound',
            'deleted_at',
          ])
          .where('business_id', '=', businessId)
          .where('id', '=', contactId)
          .forNoKeyUpdate()
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Contact', id);
  if (row.deleted_at !== null)
    throw new ConflictError('Restore the contact from the trash before changing it.');
  return row;
}

/** Marks the contact changed, as a change to its names does: its updated_at moves. */
export async function touchContact(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
): Promise<void> {
  await trx
    .updateTable('crm.contacts')
    .set((eb) => ({ first_name: eb.ref('first_name') }))
    .where('business_id', '=', businessId)
    .where('id', '=', contactId)
    .execute();
}

/** The contact's email addresses and phone numbers: emails first, the primary of each first. */
export async function readAddressRows(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
): Promise<AddressRow[]> {
  const rows = await trx
    .selectFrom('crm.contact_identities')
    .select(['id', 'kind', 'value_normalized', 'label', 'is_primary'])
    .where('business_id', '=', businessId)
    .where('contact_id', '=', contactId)
    .where('kind', 'in', ['email', 'phone'])
    .orderBy('kind')
    .orderBy('is_primary', 'desc')
    .orderBy('id')
    .execute();
  return rows;
}

/** A contact of the transaction's business as the page shows it beside the contact, or not found. */
export async function readContactDetails(
  trx: DatabaseTransaction,
  invocation: Invocation,
  id: string,
  options: ContactDetailOptions,
): Promise<ContactDetails> {
  const { context } = invocation;
  const businessId = requireBusiness(context);
  const contactId = parsePublicId('contact', id);
  const row =
    contactId === undefined
      ? undefined
      : await trx
          .selectFrom('crm.contacts')
          .select([
            'id',
            'owner_user_id',
            'do_not_contact',
            'dnd_channels',
            'dnd_inbound',
            'created_by_kind',
            'created_by_id',
            'created_source',
            'created_at',
            'deleted_at',
            'merged_into_id',
          ])
          .where('business_id', '=', businessId)
          .where('id', '=', contactId)
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Contact', id);
  if (row.merged_into_id !== null)
    throw new NotFoundError('Contact', id, {
      mergedInto: toPublicId('contact', row.merged_into_id),
    });

  const followers = await trx
    .selectFrom('crm.contact_followers')
    .select('user_id')
    .where('business_id', '=', businessId)
    .where('contact_id', '=', row.id)
    .orderBy('created_at')
    .orderBy('user_id')
    .execute();
  const people = [
    ...(row.owner_user_id === null ? [] : [row.owner_user_id]),
    ...followers.map((follower) => follower.user_id),
  ];
  const memberships = await options.assignees.memberships(trx, context, people);
  const userNames =
    people.length === 0 ? undefined : await options.actorNames.user?.(trx, [...new Set(people)]);
  const person = (userId: string): ContactPerson => ({
    membershipId: memberships.get(userId) ?? null,
    name: userNames?.get(userId) ?? null,
    you: context.actorKind === 'user' && userId === context.userId,
  });

  const addresses = await readAddressRows(trx, businessId, row.id);
  const country = await countryOf(trx, businessId);
  const blocks = await options.blockedAddresses?.(trx, context, row.id);
  const verifications = await options.addressVerifications?.(trx, context, row.id);
  const shown = addresses.map((address): ContactAddress => {
    const kind = address.kind === 'email' ? 'email' : 'phone';
    const block = blocks?.find(
      (each) => each.kind === kind && each.value === address.value_normalized,
    );
    return {
      id: toPublicId('contact_identity', address.id),
      kind,
      value: address.value_normalized,
      display:
        kind === 'email'
          ? address.value_normalized
          : asContactPhone(address.value_normalized, country).display,
      label: contactPhoneLabels.find((label) => label === address.label) ?? null,
      primary: address.is_primary,
      ...(verifications === undefined
        ? {}
        : {
            verification:
              kind === 'phone'
                ? null
                : (verifications.find((item) => item.value === address.value_normalized)
                    ?.verification ?? null),
          }),
      ...(blocks === undefined
        ? {}
        : {
            delivery:
              block === undefined
                ? { status: 'unchecked' as const, reason: null, since: null }
                : {
                    status: 'blocked' as const,
                    reason: block.reason,
                    since: block.since.toISOString(),
                  },
          }),
    };
  });

  const createdKind = actorKinds.find((kind) => kind === row.created_by_kind) ?? 'system';
  const createdName =
    row.created_by_id === null
      ? undefined
      : (await options.actorNames[createdKind]?.(trx, [row.created_by_id]))?.get(row.created_by_id);
  const source: ContactSource =
    contactSources.find((each) => each === row.created_source) ?? 'unknown';
  const channels = storedDndChannels(row.dnd_channels);

  return {
    id: toPublicId('contact', row.id),
    owner: row.owner_user_id === null ? null : person(row.owner_user_id),
    ownerRevision: ownerRevisionOf(row.owner_user_id),
    // A follower is a person, as an owner is. Someone who left the team is left out, and
    // follows again if they come back; their row is not deleted behind their back.
    followers: followers
      .filter((follower) => memberships.has(follower.user_id))
      .map((follower) => person(follower.user_id)),
    addresses: shown,
    addressesRevision: addressesRevisionOf(addresses),
    dnd: {
      all: row.do_not_contact,
      channels,
      inbound: row.dnd_inbound,
      revision: dndRevisionOf(row.do_not_contact, channels, row.dnd_inbound),
    },
    createdBy: {
      kind: createdKind,
      name: createdName ?? null,
      you:
        createdKind === 'user' &&
        context.actorKind === 'user' &&
        row.created_by_id === context.userId,
    },
    createdSource: source,
    createdAt: row.created_at.toISOString(),
    canManage:
      row.deleted_at === null &&
      (invocation.permissions === 'all' || invocation.permissions.has('contacts.manage')),
    canReadAudit: invocation.permissions === 'all' || invocation.permissions.has('audit.read'),
  };
}
