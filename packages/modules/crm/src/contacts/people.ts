// A contact's owner and followers. The owner is one team member, or nobody; followers are
// any others who want to hear about the contact. Both are people, as a task's assignee is:
// tenancy says who is on the team now, and holds the membership it resolved until the
// change commits.
//
// Each change is its own event on the contact's timeline, naming the person by id (ids are
// not personal data, and whoever reads the event later needs to know who it was then):
// contact.owner_assigned, contact.owner_unassigned, contact.follower_added and
// contact.follower_removed.
import { defineCommand, requireBusiness, type Command, type CommandContext } from '@repo/commands';
import {
  assignContactOwnerCommandInput,
  contactFollowersCommandInput,
  MAX_CONTACT_FOLLOWERS,
  type ContactDetails,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ValidationError } from '@repo/kernel';

import { followDealsOfContact, holdOwnerRules } from '../deals/owner-rules.js';
import {
  lockLiveContact,
  ownerRevisionOf,
  readContactDetails,
  requireRevision,
  type ContactDetailOptions,
} from './details.js';

/**
 * The user a membership id or "me" names. Tenancy refuses someone who isn't on this team in
 * the words of a task's assignee; here the refusal points at the field that named them.
 */
export async function memberOf(
  options: ContactDetailOptions,
  trx: DatabaseTransaction,
  command: CommandContext,
  selection: string,
  path: string,
): Promise<string> {
  let userId: string | null;
  try {
    userId = await options.assignees.resolve(trx, command.context, selection);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    userId = null;
  }
  if (userId === null)
    throw new ValidationError([
      {
        path,
        code: 'unavailable_member',
        message: 'Choose someone on this business or agency team.',
      },
    ]);
  return userId;
}

/** The users a list of membership ids names, each once, in the order given. */
export async function membersOf(
  options: ContactDetailOptions,
  trx: DatabaseTransaction,
  command: CommandContext,
  selections: readonly string[],
): Promise<string[]> {
  const users: string[] = [];
  for (const [index, selection] of selections.entries()) {
    const userId = await memberOf(options, trx, command, selection, `/followers/${String(index)}`);
    if (!users.includes(userId)) users.push(userId);
  }
  return users;
}

/** The users who follow the contact, whether or not they are still on the team. */
async function followersOf(
  trx: DatabaseTransaction,
  businessId: string,
  contactId: string,
): Promise<string[]> {
  const rows = await trx
    .selectFrom('crm.contact_followers')
    .select('user_id')
    .where('business_id', '=', businessId)
    .where('contact_id', '=', contactId)
    .execute();
  return rows.map((row) => row.user_id);
}

export function assignContactOwnerCommand(
  options: ContactDetailOptions,
): Command<typeof assignContactOwnerCommandInput, ContactDetails> {
  return defineCommand({
    name: 'contact.assign_owner',
    permission: 'contacts.manage',
    input: assignContactOwnerCommandInput,
    async handle(trx, input, command): Promise<ContactDetails> {
      const businessId = requireBusiness(command.context);
      // Before any row: under a follower rule this change also writes on the contact's
      // deals. With the rules off it reads one row and locks nothing.
      const rules = await holdOwnerRules(trx, businessId);
      const contact = await lockLiveContact(trx, businessId, input.id);
      requireRevision(
        "This contact's owner",
        ownerRevisionOf(contact.owner_user_id),
        input.revision,
      );
      const owner =
        input.owner === null ? null : await memberOf(options, trx, command, input.owner, '/owner');
      if (owner !== contact.owner_user_id) {
        await trx
          .updateTable('crm.contacts')
          .set({ owner_user_id: owner })
          .where('business_id', '=', businessId)
          .where('id', '=', contact.id)
          .execute();
        await command.emit({
          type: owner === null ? 'contact.owner_unassigned' : 'contact.owner_assigned',
          subject: { kind: 'contact', id: contact.id },
          records: [contact.id],
          // Who it was given to, for whoever reads the event later: the contact may have
          // changed hands again by then.
          payload: owner === null ? {} : { assignedUserId: owner },
        });
        if (owner !== null && rules.contactOwnerFollowsDeal)
          await followDealsOfContact(
            trx,
            command,
            options.assignees.memberships,
            contact.id,
            owner,
          );
      }
      return readContactDetails(trx, command, input.id, options);
    },
  });
}

export function addContactFollowersCommand(
  options: ContactDetailOptions,
): Command<typeof contactFollowersCommandInput, ContactDetails> {
  return defineCommand({
    name: 'contact.add_followers',
    permission: 'contacts.manage',
    input: contactFollowersCommandInput,
    async handle(trx, input, command): Promise<ContactDetails> {
      const businessId = requireBusiness(command.context);
      // The contact's row is held, so two changes to its followers run one after the other
      // and the count below is the count that is written.
      const contact = await lockLiveContact(trx, businessId, input.id);
      const named = await membersOf(options, trx, command, input.followers);
      const stored = await followersOf(trx, businessId, contact.id);
      const added = named.filter((userId) => !stored.includes(userId));
      // Only people still on the team count: someone who left follows nothing (details.ts).
      const onTeam = await options.assignees.memberships(trx, command.context, stored);
      if (onTeam.size + added.length > MAX_CONTACT_FOLLOWERS)
        throw new ValidationError([
          {
            path: '/followers',
            code: 'too_many_followers',
            message: `A contact has at most ${String(MAX_CONTACT_FOLLOWERS)} followers.`,
          },
        ]);
      for (const userId of added) {
        await trx
          .insertInto('crm.contact_followers')
          .values({
            business_id: businessId,
            contact_id: contact.id,
            user_id: userId,
            added_by_kind: command.context.actorKind,
            added_by_id: command.context.actorId ?? null,
          })
          .execute();
        await command.emit({
          type: 'contact.follower_added',
          subject: { kind: 'contact', id: contact.id },
          records: [contact.id],
          payload: { followerUserId: userId },
        });
      }
      return readContactDetails(trx, command, input.id, options);
    },
  });
}

export function removeContactFollowersCommand(
  options: ContactDetailOptions,
): Command<typeof contactFollowersCommandInput, ContactDetails> {
  return defineCommand({
    name: 'contact.remove_followers',
    permission: 'contacts.manage',
    input: contactFollowersCommandInput,
    async handle(trx, input, command): Promise<ContactDetails> {
      const businessId = requireBusiness(command.context);
      const contact = await lockLiveContact(trx, businessId, input.id);
      const named = await membersOf(options, trx, command, input.followers);
      const removed = await trx
        .deleteFrom('crm.contact_followers')
        .where('business_id', '=', businessId)
        .where('contact_id', '=', contact.id)
        .where('user_id', 'in', named)
        .returning('user_id')
        .execute();
      // In the order they were named, whatever order the rows came back in.
      for (const userId of named.filter((each) => removed.some((row) => row.user_id === each)))
        await command.emit({
          type: 'contact.follower_removed',
          subject: { kind: 'contact', id: contact.id },
          records: [contact.id],
          payload: { followerUserId: userId },
        });
      return readContactDetails(trx, command, input.id, options);
    },
  });
}

const removeAllFollowersInput = contactFollowersCommandInput.pick({ id: true });

/** Clears stored followers, including people whose memberships have since ended. */
export function removeAllContactFollowersCommand(
  options: ContactDetailOptions,
): Command<typeof removeAllFollowersInput, ContactDetails> {
  return defineCommand({
    name: 'contact.remove_all_followers',
    permission: 'contacts.manage',
    input: removeAllFollowersInput,
    async handle(trx, input, command): Promise<ContactDetails> {
      const businessId = requireBusiness(command.context);
      const contact = await lockLiveContact(trx, businessId, input.id);
      const removed = await trx
        .deleteFrom('crm.contact_followers')
        .where('business_id', '=', businessId)
        .where('contact_id', '=', contact.id)
        .returning('user_id')
        .execute();
      for (const userId of removed.map((row) => row.user_id).toSorted())
        await command.emit({
          type: 'contact.follower_removed',
          subject: { kind: 'contact', id: contact.id },
          records: [contact.id],
          payload: { followerUserId: userId },
        });
      return readContactDetails(trx, command, input.id, options);
    },
  });
}
