// What the contact page reads and changes beside the contact itself: its owner and
// followers, each email address and phone number, a phone number with its label, do not
// disturb for every channel or for one at a time, and how the contact came to be.
//
// It is one read, GET /contacts/{id}/details, and every change answers with the same shape,
// so a page replaces what it holds. The Contact shape (contacts.ts) is unchanged.
import * as z from 'zod';

import { actor } from './activity.js';
import { contactPhoneLabels, dndChannels, type DndChannel } from './contact-attributes.js';
import {
  assignContactOwnerInput,
  contactMember,
  contactPeopleRevision,
  contactPerson,
} from './contact-people.js';
import { DO_NOT_CONTACT_REASON_MAX, DO_NOT_CONTACT_REASON_MIN } from './contact-preferences.js';
import { suppressionReasons } from './consent.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';
import { emailVerification } from './email-verification-status.js';

/** At most this many team members follow one contact, as GoHighLevel has it. */
export const MAX_CONTACT_FOLLOWERS = 10;

// The phone labels and do-not-disturb channels are in contact-attributes.ts and the
// people a record names are in contact-people.ts, so a list can name them without
// loading this file. They are exported from those files only, never re-exported here:
// a name the package index reaches by two paths is lost under the server's module hooks.
const revision = contactPeopleRevision;
const member = contactMember;

export const contactAddressKinds = ['email', 'phone'] as const;
export type ContactAddressKind = (typeof contactAddressKinds)[number];

/**
 * Delivery suppression is separate from verification. An address remains `unchecked`
 * here until a suppression blocks it; verification describes the quality of the address.
 */
export const contactAddressDeliveries = ['unchecked', 'blocked'] as const;

export const contactAddress = z
  .looseObject({
    id: publicId('contact_identity'),
    kind: z.enum(contactAddressKinds),
    value: z.string().meta({
      description: 'A lowercased email address, or a phone number in E.164.',
      examples: ['maya.thompson@example.com'],
    }),
    display: z.string().meta({
      description:
        "As people write it: the email address, or the number in national form for the business's country.",
      examples: ['0712 345678'],
    }),
    label: z
      .enum(contactPhoneLabels)
      .nullable()
      .meta({ description: 'Only a phone number has one.' }),
    primary: z.boolean().meta({
      description:
        'The one of its kind that automations send to and a reply is first offered. Exactly one of each kind is primary.',
    }),
    verification: emailVerification.nullable().optional().meta({
      description: 'Email checks, independently of delivery blocks. Null for phones.',
    }),
    delivery: z
      .looseObject({
        status: z.enum(contactAddressDeliveries),
        reason: z.enum(suppressionReasons).nullable().meta({
          description:
            'Why it is blocked: a hard bounce, a complaint, an invalid number, and so on.',
        }),
        since: timestamp.nullable(),
      })
      .optional()
      .meta({
        description:
          'Present when the server can tell. Blocked addresses are refused by every send, whatever the consent. More statuses will come when a verification service is connected.',
      }),
  })
  .meta({
    id: 'ContactAddress',
    description: "One of a contact's email addresses or phone numbers.",
  });
export type ContactAddress = z.infer<typeof contactAddress>;

export const contactDnd = z
  .looseObject({
    all: z.boolean().meta({
      description:
        "Do not contact: nothing is sent on any channel. The same setting as the contact's doNotContact.",
    }),
    channels: z.array(z.enum(dndChannels)).meta({
      description:
        'The channels nothing is sent on, in order. Consent and blocked addresses still apply to the others.',
    }),
    inbound: z.boolean().meta({
      description:
        'Inbound do not disturb, one setting for what the contact sends in. Their text messages are blocked: not shown in conversations, not passed on to the team, and they start nothing; a STOP, START or HELP still changes their consent. Their calls are not blocked yet, and will be once the phone system checks this setting. It stops nothing sent to the contact.',
    }),
    revision: revision.meta({
      description: 'Changes when any of these settings does. Send it back with a change.',
    }),
  })
  .meta({ id: 'ContactDnd' });
export type ContactDnd = z.infer<typeof contactDnd>;

/** How a contact came to be. `unknown` for one made before this was recorded. */
export const contactSources = [
  'user',
  'api',
  'form',
  'booking',
  'import',
  'email',
  'sms',
  'webchat',
  'automation',
  'assistant',
  'unknown',
] as const;
export type ContactSource = (typeof contactSources)[number];

export const contactDetails = z
  .looseObject({
    id: publicId('contact'),
    owner: contactPerson.nullable(),
    ownerRevision: revision.meta({
      description: 'Changes when the owner does. Send it back with a change of owner.',
    }),
    followers: z.array(contactPerson).meta({
      description: 'In the order they were added. People no longer on the team are left out.',
    }),
    addresses: z.array(contactAddress).meta({
      description: 'Email addresses, then phone numbers; the primary of each kind first.',
    }),
    addressesRevision: revision.meta({
      description:
        'Changes when an address is added, removed, relabelled or made primary. Send it back with a change to one.',
    }),
    dnd: contactDnd,
    createdBy: actor,
    createdSource: z.enum(contactSources).meta({
      description:
        'How the contact came to be: a person in the app, an API key, a form, a booking, an import, mail or a text message from them, a web chat, an automation or an assistant.',
    }),
    createdAt: timestamp,
    canManage: z.boolean().meta({ description: 'Whether you may change any of it.' }),
    canReadAudit: z.boolean().meta({
      description: "Whether you may read the contact's audit log (GET /records/{id}/audit-log).",
    }),
  })
  .meta({ id: 'ContactDetails', description: 'What the contact page shows beside the contact.' });
export type ContactDetails = z.infer<typeof contactDetails>;

/** Which contact: as a path parameter, and as a command's input. */
const contactParams = z.strictObject({ id: publicId('contact') });
const addressParams = z.strictObject({
  id: publicId('contact'),
  addressId: publicId('contact_identity'),
});

const followers = z
  .array(member)
  .min(1, { error: 'Name at least one person.' })
  .max(MAX_CONTACT_FOLLOWERS, {
    error: `Name at most ${String(MAX_CONTACT_FOLLOWERS)} people.`,
  });

export const contactFollowersInput = z
  .strictObject({
    followers: followers.meta({ description: 'Membership ids, or "me".' }),
  })
  .meta({ id: 'ContactFollowersInput' });
export type ContactFollowersInput = z.input<typeof contactFollowersInput>;

// Trimmed before it is checked, as the contact's own lists are (contacts.ts).
const addressValue = z
  .string()
  .trim()
  .min(1, { error: 'Enter an email address or a phone number.' })
  .max(320, { error: 'Use at most 320 characters.' });

export const addContactAddressInput = z
  .strictObject({
    kind: z.enum(contactAddressKinds),
    value: addressValue.meta({
      description:
        "An email address, or a phone number in international form or in national form for the business's country.",
      examples: ['+254 712 345678'],
    }),
    label: z.enum(contactPhoneLabels).nullable().default(null),
  })
  .superRefine((input, context) => {
    if (input.kind !== 'email') return;
    if (input.label !== null)
      context.addIssue({
        code: 'custom',
        path: ['label'],
        message: 'Only a phone number has a label.',
        params: { code: 'label_not_for_email' },
      });
    const address = input.value.toLowerCase();
    if (address.length > 320 || !z.regexes.email.test(address))
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Enter an email address, such as maya@example.com.',
      });
  })
  .meta({
    id: 'AddContactAddressInput',
    description:
      'The first address of its kind becomes the primary. A later one never changes which is primary.',
  });
export type AddContactAddressInput = z.input<typeof addContactAddressInput>;

export const updateContactAddressInput = z
  .strictObject({
    label: z.enum(contactPhoneLabels).nullable().optional(),
    primary: z.literal(true).optional().meta({
      description: 'Makes it the primary of its kind. The one that was is primary no longer.',
    }),
    revision: revision.meta({
      description: "The contact's addressesRevision as you read it. A stale one returns 409.",
    }),
  })
  .refine((input) => input.label !== undefined || input.primary !== undefined, {
    path: [],
    error: 'Send a label, or primary.',
    params: { code: 'nothing_to_change' },
  })
  .meta({ id: 'UpdateContactAddressInput' });
export type UpdateContactAddressInput = z.input<typeof updateContactAddressInput>;

export const removeContactAddressInput = z
  .strictObject({ revision })
  .meta({ id: 'RemoveContactAddressInput' });
export type RemoveContactAddressInput = z.input<typeof removeContactAddressInput>;

/** The channels of a list, each once, in the contract's order: how they are stored and shown. */
export function dndChannelsOf(channels: readonly DndChannel[]): DndChannel[] {
  return dndChannels.filter((channel) => channels.includes(channel));
}

export const setContactDndInput = z
  .strictObject({
    all: z.boolean().meta({ description: 'Do not contact: stop every channel.' }),
    channels: z
      .array(z.enum(dndChannels))
      .max(dndChannels.length)
      .meta({ description: 'The channels to stop one at a time. Replaces the list.' }),
    inbound: z.boolean().optional().meta({
      description:
        'Inbound do not disturb: blocks text messages from the contact now, and their calls once the phone system checks it. Left out, it stays as it is.',
    }),
    reason: z
      .string()
      .trim()
      .min(DO_NOT_CONTACT_REASON_MIN, {
        error: `Say why, in at least ${String(DO_NOT_CONTACT_REASON_MIN)} characters.`,
      })
      .max(DO_NOT_CONTACT_REASON_MAX, {
        error: `Use at most ${String(DO_NOT_CONTACT_REASON_MAX)} characters.`,
      })
      .meta({
        description: 'Why. It is kept with the change, in the audit log, and in no event.',
        examples: ['Asked by phone on 9 October to get no more text messages.'],
      }),
    revision: revision.meta({
      description: "The contact's dnd.revision as you read it. A stale one returns 409.",
    }),
  })
  .meta({ id: 'SetContactDndInput' });
export type SetContactDndInput = z.input<typeof setContactDndInput>;

/** The commands' inputs: what a request's body holds, with the ids from its path. */
export const assignContactOwnerCommandInput = contactParams.extend({
  owner: assignContactOwnerInput.shape.owner,
  // Left out only by a caller that sets the owner whatever it is, such as an automation;
  // the API's own body always names one.
  revision: revision.optional(),
});
export const contactFollowersCommandInput = contactParams.extend({ followers });
export const addContactAddressCommandInput = addContactAddressInput.safeExtend(contactParams.shape);
export const updateContactAddressCommandInput = updateContactAddressInput.safeExtend(
  addressParams.shape,
);
export const removeContactAddressCommandInput = addressParams.extend({ revision });
export const setContactDndCommandInput = setContactDndInput.extend(contactParams.shape);

const group = 'Contacts';
const answer = (description: string) =>
  ({ status: 200, description, schema: contactDetails }) as const;

export const getContactDetails = defineEndpoint({
  operationId: 'getContactDetails',
  method: 'get',
  path: '/contacts/{id}/details',
  summary: "Read a contact's owner, followers, addresses, do not disturb and origin",
  group,
  params: contactParams,
  response: answer('The details, also of a contact in the trash.'),
});

export const assignContactOwner = defineEndpoint({
  operationId: 'assignContactOwner',
  method: 'put',
  path: '/contacts/{id}/owner',
  summary: "Set a contact's owner, or leave it with none",
  group,
  params: contactParams,
  body: assignContactOwnerInput,
  response: answer('The details after the change.'),
});

export const addContactFollowers = defineEndpoint({
  operationId: 'addContactFollowers',
  method: 'post',
  path: '/contacts/{id}/followers',
  summary: 'Add followers to a contact',
  group,
  params: contactParams,
  body: contactFollowersInput,
  response: answer('The details after the change. Someone who already follows stays as they are.'),
});

export const removeContactFollowers = defineEndpoint({
  operationId: 'removeContactFollowers',
  method: 'delete',
  path: '/contacts/{id}/followers',
  summary: 'Remove followers from a contact',
  group,
  params: contactParams,
  body: contactFollowersInput,
  response: answer(
    'The details after the change. Someone who does not follow is left as they are.',
  ),
});

export const addContactAddress = defineEndpoint({
  operationId: 'addContactAddress',
  method: 'post',
  path: '/contacts/{id}/addresses',
  summary: 'Add an email address or a phone number to a contact',
  group,
  params: contactParams,
  body: addContactAddressInput,
  response: {
    status: 201,
    description: 'The details with the new address.',
    schema: contactDetails,
  },
});

export const updateContactAddress = defineEndpoint({
  operationId: 'updateContactAddress',
  method: 'patch',
  path: '/contacts/{id}/addresses/{addressId}',
  summary: "Label one of a contact's addresses, or make it the primary",
  group,
  params: addressParams,
  body: updateContactAddressInput,
  response: answer('The details after the change.'),
});

export const removeContactAddress = defineEndpoint({
  operationId: 'removeContactAddress',
  method: 'delete',
  path: '/contacts/{id}/addresses/{addressId}',
  summary: "Remove one of a contact's addresses",
  group,
  params: addressParams,
  body: removeContactAddressInput,
  response: answer(
    'The details without it. When it was the primary, the oldest other address of its kind is.',
  ),
});

export const setContactDnd = defineEndpoint({
  operationId: 'setContactDnd',
  method: 'put',
  path: '/contacts/{id}/dnd',
  summary: 'Turn do not disturb on or off, for every channel or for some',
  group,
  params: contactParams,
  body: setContactDndInput,
  response: answer('The details after the change. It applies from the next send check.'),
});

export const contactDetailEndpoints = [
  getContactDetails,
  assignContactOwner,
  addContactFollowers,
  removeContactFollowers,
  addContactAddress,
  updateContactAddress,
  removeContactAddress,
  setContactDnd,
] as const;
