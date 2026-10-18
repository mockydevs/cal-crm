// Duplicate contacts, as GoHighLevel offers them: Settings → Business Profile → "Contact
// Deduplication Preferences" (a primary match field, Email or Phone, and an optional
// secondary one), its duplicate lookup, and Contacts → Manage Duplicates (find by email,
// phone or name; review a group; reject it).
// https://help.gohighlevel.com/support/solutions/articles/48001181714 (the preferences)
// https://help.gohighlevel.com/support/solutions/articles/48001202210 (Manage Duplicates)
//
// One email address or phone number belongs to one contact here, always, so two contacts
// never share one exactly. What the finder shows are near duplicates: addresses that reach
// the same Gmail inbox (dots, a +tag, googlemail.com), the same address with another +tag,
// a phone number whose last ten digits are another's, and similar names that a second sign
// backs up.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The fields a contact is found by when details arrive: GoHighLevel's two. */
export const duplicateMatchFields = ['email', 'phone'] as const;
export type DuplicateMatchField = (typeof duplicateMatchFields)[number];

/** How Manage Duplicates finds a group: GoHighLevel's "Find By". */
export const duplicateFindModes = ['email', 'phone', 'name'] as const;
export type DuplicateFindMode = (typeof duplicateFindModes)[number];

/**
 * Why contacts were put together: `email` and `phone` share a match key (see the group's
 * valueKey); `name` have similar names, backed by `company` (linked to the same company),
 * `email_name` (the same email address before the @, without a +tag and dots aside, on any domain) or `phone` (the same
 * last ten digits).
 */
export const duplicateReasons = ['email', 'phone', 'name', 'company', 'email_name'] as const;
export type DuplicateReason = (typeof duplicateReasons)[number];

/** The most contacts a group shows, and the most a rejection names. */
export const MAX_DUPLICATE_GROUP_CONTACTS = 25;
/** The most groups a page holds, and how many when the request doesn't say. */
export const CONTACT_DUPLICATE_GROUP_PAGE = 20;
export const DEFAULT_DUPLICATE_GROUP_PAGE = 10;

const group = 'Contacts';
const revision = z.string().regex(/^[0-9a-f]{64}$/);

const duplicateSettingsValues = z.strictObject({
  primary: z.enum(duplicateMatchFields).meta({
    description:
      'Which field finds an existing contact first when details arrive from a form, a booking or an import, and the order findDuplicateContact looks in. Email by default.',
  }),
  secondary: z.enum(duplicateMatchFields).nullable().meta({
    description:
      'The other field, tried when the primary one is given and finds nobody. Null: the other field is only used when no primary field was given.',
  }),
});

export const updateDuplicateSettingsInput = duplicateSettingsValues
  .extend({
    revision: revision.meta({
      description: "The settings' revision as you read it. A stale one returns 409.",
    }),
  })
  .superRefine((input, context) => {
    if (input.secondary !== null && input.secondary === input.primary)
      context.addIssue({
        code: 'custom',
        path: ['secondary'],
        message: 'Choose a secondary field other than the primary one, or none.',
        params: { code: 'same_as_primary' },
      });
  })
  .meta({ id: 'UpdateDuplicateSettingsInput' });
export type UpdateDuplicateSettingsInput = z.infer<typeof updateDuplicateSettingsInput>;

export const duplicateSettings = duplicateSettingsValues
  .extend({ revision, canManage: z.boolean() })
  .loose()
  .meta({ id: 'DuplicateSettings', description: 'How a business finds an existing contact.' });
export type DuplicateSettings = z.infer<typeof duplicateSettings>;

/** A contact as a duplicate group shows it, to tell it from the others. */
export const duplicateContact = z
  .looseObject({
    id: publicId('contact'),
    name: z.string().nullable(),
    emails: z.array(z.string()).meta({ description: 'Lowercased. The first is the primary.' }),
    phones: z.array(z.string()).meta({ description: 'In E.164. The first is the primary.' }),
    createdAt: timestamp,
  })
  .meta({ id: 'DuplicateContact' });
export type DuplicateContact = z.infer<typeof duplicateContact>;

export const duplicateGroup = z
  .looseObject({
    by: z.enum(duplicateFindModes),
    valueKey: z.string().meta({
      description:
        'What the contacts share. Email: the address with dots (Gmail only) and any +tag left out, googlemail.com read as gmail.com. Phone: the last ten digits. Name: the first contact’s name, lowercased. Send it back to reject the group.',
      examples: ['janedoe@gmail.com'],
    }),
    reasons: z.array(z.enum(duplicateReasons)),
    weak: z.boolean().meta({
      description:
        'A weaker sign: the same address with another +tag outside Gmail, which some providers deliver elsewhere, or the same last ten digits under different names.',
    }),
    total: z
      .int()
      .min(2)
      .meta({
        description: `How many live contacts share it. At most ${String(MAX_DUPLICATE_GROUP_CONTACTS)} are listed.`,
      }),
    contacts: z.array(duplicateContact),
  })
  .meta({ id: 'DuplicateGroup' });
export type DuplicateGroup = z.infer<typeof duplicateGroup>;

export const listDuplicateGroupsQuery = z
  .strictObject({
    by: z.enum(duplicateFindModes).default('email').meta({
      description: 'Find by email (the default), phone or name.',
    }),
    cursor: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .meta({ description: "Start after this: the previous page's next." }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(CONTACT_DUPLICATE_GROUP_PAGE, {
        error: `Ask for at most ${String(CONTACT_DUPLICATE_GROUP_PAGE)} groups.`,
      })
      .optional()
      .meta({
        description: `How many groups a page holds. Left out, ${String(DEFAULT_DUPLICATE_GROUP_PAGE)}.`,
      }),
  })
  .meta({ id: 'ListDuplicateGroupsQuery' });
export type ListDuplicateGroupsQuery = z.output<typeof listDuplicateGroupsQuery>;

export const duplicateGroupList = z
  .looseObject({
    items: z.array(duplicateGroup),
    next: z.string().nullable().meta({
      description:
        'Pass it as cursor to read on. Null when nothing is left. A page by name may hold fewer groups than asked, even none, and still have a next: names are compared a slice of contacts at a time.',
    }),
  })
  .meta({ id: 'DuplicateGroupList' });
export type DuplicateGroupList = z.infer<typeof duplicateGroupList>;

const lookupEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .regex(z.regexes.email, { error: 'Enter an email address, such as maya@example.com.' });
const lookupPhone = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .meta({ description: "In international form, or in national form for the business's country." });

export const duplicateLookupQuery = z
  .strictObject({ email: lookupEmail.optional(), phone: lookupPhone.optional() })
  .superRefine((input, context) => {
    if (input.email === undefined && input.phone === undefined)
      context.addIssue({
        code: 'custom',
        path: ['email'],
        message: 'Give an email address, a phone number or both.',
        params: { code: 'nothing_to_find' },
      });
  })
  .meta({ id: 'DuplicateLookupQuery' });

export const duplicateLookup = z
  .looseObject({
    contact: duplicateContact
      .extend({
        trashedAt: timestamp.nullable(),
      })
      .nullable()
      .meta({ description: 'The contact that holds it, in the trash too, or null.' }),
    matchedBy: z.enum(duplicateMatchFields).nullable(),
  })
  .meta({ id: 'DuplicateLookup' });
export type DuplicateLookup = z.infer<typeof duplicateLookup>;

export const possibleDuplicates = z
  .looseObject({
    groups: z.array(duplicateGroup).meta({
      description: 'Each group holds this contact and the others that share one sign with it.',
    }),
    count: z.int().min(0).meta({
      description: 'How many other contacts the groups hold: the contact page shows it.',
    }),
  })
  .meta({ id: 'PossibleDuplicates' });
export type PossibleDuplicates = z.infer<typeof possibleDuplicates>;

export const rejectDuplicateGroupInput = z
  .strictObject({
    by: z.enum(duplicateFindModes),
    valueKey: z.string().min(1).max(320),
    contactIds: z
      .array(publicId('contact'))
      .min(2, { error: 'A group has at least two contacts.' })
      .max(MAX_DUPLICATE_GROUP_CONTACTS, {
        error: `Name at most ${String(MAX_DUPLICATE_GROUP_CONTACTS)} contacts.`,
      })
      .refine((ids) => new Set(ids).size === ids.length, {
        error: 'Name each contact once.',
      }),
  })
  .meta({ id: 'RejectDuplicateGroupInput' });
export type RejectDuplicateGroupInput = z.infer<typeof rejectDuplicateGroupInput>;

export const getDuplicateSettings = defineEndpoint({
  operationId: 'getDuplicateSettings',
  method: 'get',
  path: '/contact-duplicate-settings',
  summary: "Read the business's contact deduplication preferences",
  group,
  response: { status: 200, description: 'The preferences.', schema: duplicateSettings },
});

export const updateDuplicateSettings = defineEndpoint({
  operationId: 'updateDuplicateSettings',
  method: 'put',
  path: '/contact-duplicate-settings',
  summary: "Change the business's contact deduplication preferences",
  group,
  body: updateDuplicateSettingsInput,
  response: {
    status: 200,
    description:
      'The preferences as saved. Details that arrive from then on are matched in the new order.',
    schema: duplicateSettings,
  },
});

export const findDuplicateContact = defineEndpoint({
  operationId: 'findDuplicateContact',
  method: 'get',
  path: '/contacts/duplicates',
  summary: 'Find the contact that holds an email address or phone number',
  group,
  query: duplicateLookupQuery,
  response: {
    status: 200,
    description:
      'The contact, found in the order of the deduplication preferences: the primary field first; the other when the primary was not given, or when it finds nobody and a secondary field is set.',
    schema: duplicateLookup,
  },
});

export const listDuplicateGroups = defineEndpoint({
  operationId: 'listDuplicateGroups',
  method: 'get',
  path: '/contacts/duplicate-groups',
  summary: 'List groups of contacts that may be the same person',
  group,
  query: listDuplicateGroupsQuery,
  response: {
    status: 200,
    description:
      'Groups of two or more live contacts, rejected groups left out. Needs contacts.merge.',
    schema: duplicateGroupList,
  },
});

export const rejectDuplicateGroup = defineEndpoint({
  operationId: 'rejectDuplicateGroup',
  method: 'post',
  path: '/contacts/duplicate-groups/reject',
  summary: 'Say a group of contacts are not duplicates',
  group,
  body: rejectDuplicateGroupInput,
  response: {
    status: 204,
    description:
      'Kept for good, for every contact of the group as it is now, not only the ones named: the group is not shown again unless another contact joins it. It cannot be undone.',
  },
});

export const listPossibleDuplicates = defineEndpoint({
  operationId: 'listPossibleDuplicates',
  method: 'get',
  path: '/contacts/{id}/possible-duplicates',
  summary: 'List the contacts that may be the same person as this one',
  group,
  params: z.object({ id: publicId('contact') }),
  response: { status: 200, description: 'Its groups.', schema: possibleDuplicates },
});

export const contactDuplicateEndpoints = [
  getDuplicateSettings,
  updateDuplicateSettings,
  findDuplicateContact,
  listDuplicateGroups,
  rejectDuplicateGroup,
  listPossibleDuplicates,
] as const;
