// Who a deal is with and whose it is: its primary contact and additional contacts, its
// owner and followers, and who made it. The owner and the followers are the contact page's
// model (contact-details.ts): the same person shape, the same inputs and the same revision
// of an owner.
//
// It is one read, GET /deals/{id}/details, and every change answers with the same shape, so
// the opportunity dialog replaces what it holds. The Deal shape (deals.ts) is unchanged.
import * as z from 'zod';

import { actor } from './activity.js';
import { contactFollowersInput } from './contact-details.js';
import { assignContactOwnerInput, contactPerson } from './contact-people.js';
import {
  additionalContactIds,
  deal,
  dealContact,
  MAX_DEAL_ADDITIONAL_CONTACTS,
  refineDealContacts,
} from './deals.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The most deals of one contact a single read gives. */
export const CONTACT_DEALS_PAGE_SIZE = 50;

const revision = z.string().regex(/^[0-9a-f]{64}$/);

export const dealDetails = z
  .looseObject({
    id: publicId('deal'),
    owner: contactPerson.nullable(),
    ownerRevision: revision.meta({
      description: 'Changes when the owner does. Send it back with a change of owner.',
    }),
    followers: z.array(contactPerson).meta({
      description: 'In the order they were added. People no longer on the team are left out.',
    }),
    primaryContact: dealContact.nullable(),
    additionalContacts: z.array(dealContact).meta({
      description: `The other contacts the deal is with, by name: at most ${String(MAX_DEAL_ADDITIONAL_CONTACTS)}.`,
    }),
    contactsRevision: revision.meta({
      description: 'Changes when a contact is linked, unlinked or made the primary.',
    }),
    createdBy: actor,
    createdAt: timestamp,
    canManage: z.boolean().meta({ description: 'Whether you may change any of it.' }),
    canReadAudit: z.boolean().meta({
      description:
        "Whether you may read the deal's audit log (GET /records/{id}/audit-log, with the deal's own id).",
    }),
  })
  .meta({ id: 'DealDetails', description: 'What the opportunity dialog shows beside the deal.' });
export type DealDetails = z.infer<typeof dealDetails>;

export const setDealContactsInput = z
  .strictObject({
    primaryContactId: publicId('contact').nullable().meta({
      description: 'The primary contact, or null for none.',
    }),
    additionalContactIds: additionalContactIds.meta({
      description: 'Every other contact the deal is with. Replaces the list.',
    }),
    revision: revision.meta({
      description: "The deal's contactsRevision as you read it. A stale one returns 409.",
    }),
  })
  .superRefine(refineDealContacts)
  .meta({ id: 'SetDealContactsInput' });
export type SetDealContactsInput = z.input<typeof setDealContactsInput>;

const dealParams = z.strictObject({ id: publicId('deal') });

/** The commands' inputs: what a request's body holds, with the id from its path. */
export const assignDealOwnerCommandInput = dealParams.extend({
  owner: assignContactOwnerInput.shape.owner,
  revision: revision.optional(),
});
export const dealFollowersCommandInput = dealParams.extend({
  followers: contactFollowersInput.shape.followers,
});
export const setDealContactsCommandInput = setDealContactsInput.safeExtend(dealParams.shape);

const group = 'Deals';
const answer = (description: string) =>
  ({ status: 200, description, schema: dealDetails }) as const;

export const getDealDetails = defineEndpoint({
  operationId: 'getDealDetails',
  method: 'get',
  path: '/deals/{id}/details',
  summary: "Read a deal's contacts, owner, followers and origin",
  group,
  params: dealParams,
  response: answer('The details, also of a deal in the trash.'),
});

export const assignDealOwner = defineEndpoint({
  operationId: 'assignDealOwner',
  method: 'put',
  path: '/deals/{id}/owner',
  summary: "Set a deal's owner, or leave it with none",
  group,
  params: dealParams,
  body: assignContactOwnerInput,
  response: answer(
    "The details after the change. The deal's updatedAt and revision move with its owner.",
  ),
});

export const addDealFollowers = defineEndpoint({
  operationId: 'addDealFollowers',
  method: 'post',
  path: '/deals/{id}/followers',
  summary: 'Add followers to a deal',
  group,
  params: dealParams,
  body: contactFollowersInput,
  response: answer('The details after the change. Someone who already follows stays as they are.'),
});

export const removeDealFollowers = defineEndpoint({
  operationId: 'removeDealFollowers',
  method: 'delete',
  path: '/deals/{id}/followers',
  summary: 'Remove followers from a deal',
  group,
  params: dealParams,
  body: contactFollowersInput,
  response: answer(
    'The details after the change. Someone who does not follow is left as they are.',
  ),
});

export const setDealContacts = defineEndpoint({
  operationId: 'setDealContacts',
  method: 'put',
  path: '/deals/{id}/contacts',
  summary: "Replace a deal's primary contact and additional contacts",
  group,
  params: dealParams,
  body: setDealContactsInput,
  response: answer('The details after the change.'),
});

export const contactDealsQuery = z
  .strictObject({
    status: z.enum(['open', 'won', 'lost', 'all']).default('all'),
    pipelineId: publicId('pipeline').optional(),
  })
  .meta({ id: 'ContactDealsQuery' });

export const contactDeals = z
  .looseObject({
    items: z
      .array(
        z.looseObject({
          deal,
          primary: z.boolean().meta({
            description: "Whether the contact is the deal's primary contact.",
          }),
        }),
      )
      .meta({
        description: `Newest first, at most ${String(CONTACT_DEALS_PAGE_SIZE)}. Deals in the trash are left out.`,
      }),
    more: z.boolean().meta({
      description: 'Whether the contact has more deals than are listed.',
    }),
    canManage: z.boolean().meta({ description: 'Whether you may add and change deals.' }),
  })
  .meta({ id: 'ContactDeals', description: "A contact's deals, as the contact page lists them." });
export type ContactDeals = z.infer<typeof contactDeals>;

export const listContactDeals = defineEndpoint({
  operationId: 'listContactDeals',
  method: 'get',
  path: '/contacts/{id}/deals',
  summary: 'List the deals a contact is with',
  group: 'Contacts',
  params: z.strictObject({ id: publicId('contact') }),
  query: contactDealsQuery,
  response: {
    status: 200,
    description:
      "The contact's deals. To add one from the contact, create a deal with primaryContactId.",
    schema: contactDeals,
  },
});

export const dealPeopleEndpoints = [
  getDealDetails,
  assignDealOwner,
  addDealFollowers,
  removeDealFollowers,
  setDealContacts,
  listContactDeals,
] as const;
