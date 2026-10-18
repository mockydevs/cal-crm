// The opportunity settings of a business, and the two rules they switch on: a deal's new
// owner is made a follower of the deal's primary contact, and a contact's new owner is made
// a follower of the open deals the contact is the primary contact of. Both are
// GoHighLevel's ("Sync Contact Follower with Opportunity Owner", "Sync Opportunity Follower
// with Contact Owner").
//
// A rule writes on a second record inside an owner change: a contact from a deal's command,
// deals from a contact's. Two such commands on linked records would each hold their own row
// and wait for the other's. So whoever runs under a rule first takes one lock for the
// business (holdOwnerRules), as do the commands that link deals to contacts, and they run
// one after the other. With both rules off, nothing is locked and nothing is written.
import { createHash } from 'node:crypto';

import {
  defineCommand,
  requireBusiness,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  MAX_CONTACT_FOLLOWERS,
  updateOpportunitySettingsInput,
  type OpportunitySettings,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';

import { DEAL_CONTACT_LINK } from './link-type.js';

/** The most deals one change of a contact's owner makes the new owner follow. */
export const FOLLOWED_DEALS_LIMIT = 100;

/** Who is on the team now, by user id: the tenancy module's answer (ContactDetailOptions). */
export type Memberships = (
  trx: DatabaseTransaction,
  context: TenantContext,
  userIds: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

interface Stored {
  readonly deal_owner_differs: boolean;
  readonly deal_owner_follows_contact: boolean;
  readonly contact_owner_follows_deal: boolean;
}
/** As a business has them before anyone saves any: nothing is linked. */
const defaults: Stored = {
  deal_owner_differs: true,
  deal_owner_follows_contact: false,
  contact_owner_follows_deal: false,
};
const columns = [
  'deal_owner_differs',
  'deal_owner_follows_contact',
  'contact_owner_follows_deal',
] as const;

function shown(row: Stored, invocation: Invocation): OpportunitySettings {
  const values = {
    allowDifferentOwners: row.deal_owner_differs,
    opportunityOwnerFollowsContact: row.deal_owner_follows_contact,
    contactOwnerFollowsOpportunity: row.contact_owner_follows_deal,
  };
  return {
    ...values,
    revision: createHash('sha256')
      .update(JSON.stringify(['opportunity-settings', values]))
      .digest('hex'),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('pipelines.manage'),
  };
}

export async function readOpportunitySettings(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<OpportunitySettings> {
  const businessId = requireBusiness(invocation.context);
  const row = await trx
    .selectFrom('crm.settings')
    .select(columns)
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  return shown(row ?? defaults, invocation);
}

export const updateOpportunitySettingsCommand = defineCommand({
  name: 'opportunity_settings.update',
  permission: 'pipelines.manage',
  input: updateOpportunitySettingsInput,
  async handle(trx, input, command): Promise<OpportunitySettings> {
    const businessId = requireBusiness(command.context);
    await trx
      .insertInto('crm.settings')
      .values({ business_id: businessId })
      .onConflict((conflict) => conflict.column('business_id').doNothing())
      .execute();
    const current = await trx
      .selectFrom('crm.settings')
      .select(columns)
      .where('business_id', '=', businessId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (shown(current, command).revision !== input.revision)
      throw new ConflictError(
        'These settings changed. Reload the saved version before editing again.',
      );
    const next: Stored = {
      deal_owner_differs: input.allowDifferentOwners,
      deal_owner_follows_contact: input.opportunityOwnerFollowsContact,
      contact_owner_follows_deal: input.contactOwnerFollowsOpportunity,
    };
    if (columns.some((column) => current[column] !== next[column])) {
      await trx
        .updateTable('crm.settings')
        .set(next)
        .where('business_id', '=', businessId)
        .execute();
      await command.emit({
        type: 'opportunity_settings.updated',
        subject: { kind: 'business', id: businessId },
        payload: {
          allowDifferentOwners: input.allowDifferentOwners,
          opportunityOwnerFollowsContact: input.opportunityOwnerFollowsContact,
          contactOwnerFollowsOpportunity: input.contactOwnerFollowsOpportunity,
        },
      });
    }
    return shown(next, command);
  },
});

/** The two rules, as they are when a command starts. */
export interface OwnerRules {
  readonly dealOwnerFollowsContact: boolean;
  readonly contactOwnerFollowsDeal: boolean;
}

/**
 * Reads the rules. When either is on, the caller waits its turn among the commands that
 * change owners or link deals to contacts in this business, and keeps it until it commits.
 * Call it before taking any row.
 */
export async function holdOwnerRules(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<OwnerRules> {
  const row = await trx
    .selectFrom('crm.settings')
    .select(['deal_owner_follows_contact', 'contact_owner_follows_deal'])
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  const rules = {
    dealOwnerFollowsContact: row?.deal_owner_follows_contact ?? false,
    contactOwnerFollowsDeal: row?.contact_owner_follows_deal ?? false,
  };
  if (rules.dealOwnerFollowsContact || rules.contactOwnerFollowsDeal)
    await sql`select pg_advisory_xact_lock(
      hashtextextended(${`crm.owner_rules:${businessId}`}, 0))`.execute(trx);
  return rules;
}

/**
 * Makes a deal's new owner a follower of the deal's primary contact: unless the contact is
 * theirs already, they follow it already, it is in the trash, or it has all the followers a
 * contact may have. The owner change itself never fails for any of these.
 */
export async function followPrimaryContact(
  trx: DatabaseTransaction,
  command: CommandContext,
  memberships: Memberships,
  dealId: string,
  ownerUserId: string,
): Promise<void> {
  const businessId = requireBusiness(command.context);
  const contact = await trx
    .selectFrom('crm.record_links as link')
    .innerJoin('crm.link_types as type', (join) =>
      join
        .onRef('type.business_id', '=', 'link.business_id')
        .onRef('type.id', '=', 'link.link_type_id'),
    )
    .innerJoin('crm.contacts as c', (join) =>
      join.onRef('c.business_id', '=', 'link.business_id').onRef('c.id', '=', 'link.to_record_id'),
    )
    .select(['c.id', 'c.owner_user_id'])
    .where('link.business_id', '=', businessId)
    .where('link.from_record_id', '=', dealId)
    .where('link.is_primary', '=', true)
    .where('type.key', '=', DEAL_CONTACT_LINK)
    .where('c.deleted_at', 'is', null)
    .executeTakeFirst();
  if (contact === undefined || contact.owner_user_id === ownerUserId) return;
  const followers = await trx
    .selectFrom('crm.contact_followers')
    .select('user_id')
    .where('business_id', '=', businessId)
    .where('contact_id', '=', contact.id)
    .execute();
  const stored = followers.map((row) => row.user_id);
  if (stored.includes(ownerUserId)) return;
  const onTeam = await memberships(trx, command.context, stored);
  if (onTeam.size >= MAX_CONTACT_FOLLOWERS) return;
  await trx
    .insertInto('crm.contact_followers')
    .values({
      business_id: businessId,
      contact_id: contact.id,
      user_id: ownerUserId,
      added_by_kind: command.context.actorKind,
      added_by_id: command.context.actorId ?? null,
    })
    .execute();
  await command.emit({
    type: 'contact.follower_added',
    subject: { kind: 'contact', id: contact.id },
    records: [contact.id],
    payload: { followerUserId: ownerUserId },
  });
}

/**
 * Makes a contact's new owner a follower of the open deals the contact is the primary
 * contact of, newest first and at most FOLLOWED_DEALS_LIMIT: unless the deal is theirs
 * already, they follow it already, or it has all the followers a deal may have.
 */
export async function followDealsOfContact(
  trx: DatabaseTransaction,
  command: CommandContext,
  memberships: Memberships,
  contactId: string,
  ownerUserId: string,
): Promise<void> {
  const businessId = requireBusiness(command.context);
  const deals = await trx
    .selectFrom('crm.record_links as link')
    .innerJoin('crm.link_types as type', (join) =>
      join
        .onRef('type.business_id', '=', 'link.business_id')
        .onRef('type.id', '=', 'link.link_type_id'),
    )
    .innerJoin('crm.deals as d', (join) =>
      join
        .onRef('d.business_id', '=', 'link.business_id')
        .onRef('d.id', '=', 'link.from_record_id'),
    )
    .select(['d.id', 'd.owner_user_id'])
    .where('link.business_id', '=', businessId)
    .where('link.to_record_id', '=', contactId)
    .where('link.is_primary', '=', true)
    .where('type.key', '=', DEAL_CONTACT_LINK)
    .where('d.deleted_at', 'is', null)
    .where('d.status', '=', 'open')
    .orderBy('d.id', 'desc')
    .limit(FOLLOWED_DEALS_LIMIT)
    .execute();
  const wanted = deals.filter((deal) => deal.owner_user_id !== ownerUserId);
  if (wanted.length === 0) return;
  const followers = await trx
    .selectFrom('crm.deal_followers')
    .select(['deal_id', 'user_id'])
    .where('business_id', '=', businessId)
    .where(
      'deal_id',
      'in',
      wanted.map((deal) => deal.id),
    )
    .execute();
  const onTeam = await memberships(trx, command.context, [
    ...new Set(followers.map((row) => row.user_id)),
  ]);
  const byDeal = Map.groupBy(followers, (row) => row.deal_id);
  // Oldest first, so the events are in the order of the deals.
  for (const deal of wanted.toReversed()) {
    const stored = (byDeal.get(deal.id) ?? []).map((row) => row.user_id);
    if (stored.includes(ownerUserId)) continue;
    if (stored.filter((userId) => onTeam.has(userId)).length >= MAX_CONTACT_FOLLOWERS) continue;
    await trx
      .insertInto('crm.deal_followers')
      .values({
        business_id: businessId,
        deal_id: deal.id,
        user_id: ownerUserId,
        added_by_kind: command.context.actorKind,
        added_by_id: command.context.actorId ?? null,
      })
      .execute();
    await command.emit({
      type: 'deal.follower_added',
      subject: { kind: 'deal', id: deal.id },
      records: [deal.id],
      payload: { followerUserId: ownerUserId },
    });
  }
}
