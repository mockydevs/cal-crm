// A calendar's "assign contacts to their calendar team members" setting (tasks/edge-cases/
// public-intake.md, H3): a booking makes its host the contact's owner, through the owner
// command itself, so the event, the timeline and the deal-follower rule are the same as
// when someone on the team does it. With `keepExisting`, a contact that has an owner keeps
// them (the calendar's "skip if the contact already has an assigned user").
import { requireBusiness, type CommandContext } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';

import { lockLiveContact, ownerRevisionOf, type ContactDetailOptions } from './details.js';
import { assignContactOwnerCommand } from './people.js';

export function assignOwnerFromBooking(options: ContactDetailOptions): (
  trx: DatabaseTransaction,
  input: {
    readonly contactId: string;
    readonly membershipId: string;
    readonly keepExisting: boolean;
  },
  command: CommandContext,
) => Promise<void> {
  const assign = assignContactOwnerCommand(options);
  return async (trx, input, command) => {
    const id = toPublicId('contact', input.contactId);
    const contact = await lockLiveContact(trx, requireBusiness(command.context), id);
    if (input.keepExisting && contact.owner_user_id !== null) return;
    await assign.handle(
      trx,
      { id, owner: input.membershipId, revision: ownerRevisionOf(contact.owner_user_id) },
      command,
    );
  };
}
