// The team members a record names: a contact's owner and followers, and through them an
// opportunity's. Kept apart from contact-details.ts so the lists that only name a person or
// reassign an owner (opportunities, bulk actions) do not load every schema of the contact
// page with it. They are exported from this file only: contact-details.ts imports them and
// does not re-export them, so the package index reaches each by one path.
import * as z from 'zod';

import { publicId } from './ids.js';

/** What changes whenever a record's people do: sent back with a change, to refuse a stale one. */
export const contactPeopleRevision = z.string().regex(/^[0-9a-f]{64}$/);

/** Someone on the team, chosen as tasks and conversations choose an assignee. */
export const contactMember = z.union([z.literal('me'), publicId('membership')]);

export const contactPerson = z
  .looseObject({
    membershipId: publicId('membership').nullable().meta({
      description:
        "Their membership of this business, or of its agency. Null when they are no longer on the team: they stay the contact's owner until someone changes it, and their name may no longer be shown.",
    }),
    name: z
      .string()
      .nullable()
      .meta({ examples: ['Dana Brooks'] }),
    you: z.boolean().meta({ description: 'Whether this is you.' }),
  })
  .meta({ id: 'ContactPerson', description: "A team member, as a contact's owner or follower." });
export type ContactPerson = z.infer<typeof contactPerson>;

export const assignContactOwnerInput = z
  .strictObject({
    owner: contactMember.nullable().meta({
      description: 'A membership id, "me", or null for no owner.',
    }),
    revision: contactPeopleRevision.meta({
      description: "The contact's ownerRevision as you read it. A stale one returns 409.",
    }),
  })
  .meta({ id: 'AssignContactOwnerInput' });
export type AssignContactOwnerInput = z.input<typeof assignContactOwnerInput>;
