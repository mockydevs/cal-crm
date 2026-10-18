// A deal's owner and followers: the contact page's model (contacts/people.ts) for a deal.
// The owner is one team member, or nobody; followers are any others who want to hear about
// the deal. Tenancy says who is on the team now, and holds the membership it resolved until
// the change commits.
//
// Each change is its own event on the deal's timeline, naming the person by id under a key
// that ends in UserId, which a timeline never gives out: deal.owner_assigned,
// deal.owner_unassigned, deal.follower_added and deal.follower_removed.
import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import {
  assignDealOwnerCommandInput,
  dealFollowersCommandInput,
  MAX_CONTACT_FOLLOWERS,
  type DealDetails,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ValidationError } from '@repo/kernel';

import { ownerRevisionOf, requireRevision } from '../contacts/details.js';
import { memberOf, membersOf } from '../contacts/people.js';
import { lockLiveDeal, readDealDetails, type DealPeopleOptions } from './details.js';
import { followPrimaryContact, holdOwnerRules } from './owner-rules.js';

/** The users who follow the deal, whether or not they are still on the team. */
async function followersOf(
  trx: DatabaseTransaction,
  businessId: string,
  dealId: string,
): Promise<string[]> {
  const rows = await trx
    .selectFrom('crm.deal_followers')
    .select('user_id')
    .where('business_id', '=', businessId)
    .where('deal_id', '=', dealId)
    .execute();
  return rows.map((row) => row.user_id);
}

export function assignDealOwnerCommand(
  options: DealPeopleOptions,
): Command<typeof assignDealOwnerCommandInput, DealDetails> {
  return defineCommand({
    name: 'deal.assign_owner',
    permission: 'deals.manage',
    input: assignDealOwnerCommandInput,
    async handle(trx, input, command): Promise<DealDetails> {
      const businessId = requireBusiness(command.context);
      // Before any row: under a follower rule this change also writes on the contact.
      const rules = await holdOwnerRules(trx, businessId);
      const deal = await lockLiveDeal(trx, businessId, input.id);
      requireRevision("This deal's owner", ownerRevisionOf(deal.owner_user_id), input.revision);
      const owner =
        input.owner === null ? null : await memberOf(options, trx, command, input.owner, '/owner');
      if (owner !== deal.owner_user_id) {
        await trx
          .updateTable('crm.deals')
          .set({ owner_user_id: owner })
          .where('business_id', '=', businessId)
          .where('id', '=', deal.id)
          .execute();
        await command.emit({
          type: owner === null ? 'deal.owner_unassigned' : 'deal.owner_assigned',
          subject: { kind: 'deal', id: deal.id },
          records: [deal.id],
          // Who it was given to, for whoever reads the event later: the deal may have
          // changed hands again by then.
          payload: owner === null ? {} : { assignedUserId: owner },
        });
        if (owner !== null && rules.dealOwnerFollowsContact)
          await followPrimaryContact(trx, command, options.assignees.memberships, deal.id, owner);
      }
      return readDealDetails(trx, command, input.id, options);
    },
  });
}

export function addDealFollowersCommand(
  options: DealPeopleOptions,
): Command<typeof dealFollowersCommandInput, DealDetails> {
  return defineCommand({
    name: 'deal.add_followers',
    permission: 'deals.manage',
    input: dealFollowersCommandInput,
    async handle(trx, input, command): Promise<DealDetails> {
      const businessId = requireBusiness(command.context);
      // The deal's row is held, so two changes to its followers run one after the other and
      // the count below is the count that is written.
      const deal = await lockLiveDeal(trx, businessId, input.id);
      const named = await membersOf(options, trx, command, input.followers);
      const stored = await followersOf(trx, businessId, deal.id);
      const added = named.filter((userId) => !stored.includes(userId));
      // Only people still on the team count: someone who left follows nothing.
      const onTeam = await options.assignees.memberships(trx, command.context, stored);
      if (onTeam.size + added.length > MAX_CONTACT_FOLLOWERS)
        throw new ValidationError([
          {
            path: '/followers',
            code: 'too_many_followers',
            message: `A deal has at most ${String(MAX_CONTACT_FOLLOWERS)} followers.`,
          },
        ]);
      for (const userId of added) {
        await trx
          .insertInto('crm.deal_followers')
          .values({
            business_id: businessId,
            deal_id: deal.id,
            user_id: userId,
            added_by_kind: command.context.actorKind,
            added_by_id: command.context.actorId ?? null,
          })
          .execute();
        await command.emit({
          type: 'deal.follower_added',
          subject: { kind: 'deal', id: deal.id },
          records: [deal.id],
          payload: { followerUserId: userId },
        });
      }
      return readDealDetails(trx, command, input.id, options);
    },
  });
}

export function removeDealFollowersCommand(
  options: DealPeopleOptions,
): Command<typeof dealFollowersCommandInput, DealDetails> {
  return defineCommand({
    name: 'deal.remove_followers',
    permission: 'deals.manage',
    input: dealFollowersCommandInput,
    async handle(trx, input, command): Promise<DealDetails> {
      const businessId = requireBusiness(command.context);
      const deal = await lockLiveDeal(trx, businessId, input.id);
      const named = await membersOf(options, trx, command, input.followers);
      const removed = await trx
        .deleteFrom('crm.deal_followers')
        .where('business_id', '=', businessId)
        .where('deal_id', '=', deal.id)
        .where('user_id', 'in', named)
        .returning('user_id')
        .execute();
      // In the order they were named, whatever order the rows came back in.
      for (const userId of named.filter((each) => removed.some((row) => row.user_id === each)))
        await command.emit({
          type: 'deal.follower_removed',
          subject: { kind: 'deal', id: deal.id },
          records: [deal.id],
          payload: { followerUserId: userId },
        });
      return readDealDetails(trx, command, input.id, options);
    },
  });
}
