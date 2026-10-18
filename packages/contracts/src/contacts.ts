// Contacts: the people a business works with. Names, email addresses and phone numbers; the
// limits match crm.contacts and crm.contact_identities.
import { parsePublicId } from '@repo/kernel';
import * as z from 'zod';

import {
  contactPreferenceChanges,
  contactPreferences,
  refineContactPreferences,
} from './contact-preferences.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';
import { fieldQueryShape, refineFieldQuery } from './field-query.js';
import { contactFilterParameter } from './contact-filter-parameter.js';
import {
  calendarDate,
  contactPhoneLabels,
  contactSourceText,
  contactTypes,
  dndChannels,
} from './contact-attributes.js';
import { contactPhone } from './contact-phone.js';
import { contactEmailVerifications } from './contact-email-verifications.js';

export { contactPhone, type ContactPhone } from './contact-phone.js';

/** At most this many email addresses, and this many phone numbers, per contact. */
export const MAX_CONTACT_IDENTITIES = 10;

/**
 * A control character: NUL cannot be stored in text at all (PostgreSQL's character types),
 * and a line break or the like in a name breaks every place a name is shown on one line.
 */
const CONTROL = /\p{Cc}/u;

const personName = z
  .string()
  .trim()
  .max(200, { error: 'Use at most 200 characters.' })
  .refine((name) => !CONTROL.test(name), {
    error: 'Use letters, spaces and punctuation only: no line breaks or control characters.',
  })
  .nullable();

// Trimmed and lowercased before it's checked, so " Maya@Example.com " is accepted.
const emailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(320, { error: 'Use at most 320 characters.' })
  .regex(z.regexes.email, { error: 'Enter an email address, such as maya@example.com.' })
  .meta({ examples: ['maya.thompson@example.com'] });

const phoneNumber = z
  .string()
  .trim()
  .min(1, { error: 'Enter a phone number.' })
  .max(40, { error: 'Use at most 40 characters.' })
  .meta({
    description:
      "As written: in international form, or in national form for the business's country.",
    examples: ['+254 712 345678'],
  });

const emails = z
  .array(emailAddress)
  .max(MAX_CONTACT_IDENTITIES, { error: 'Add at most 10 email addresses.' })
  .meta({ description: 'The first is the primary address.' });

const phones = z
  .array(phoneNumber)
  .max(MAX_CONTACT_IDENTITIES, { error: 'Add at most 10 phone numbers.' })
  .meta({ description: 'The first is the primary number.' });

/** Points at each email address listed again, ignoring case. */
function refuseRepeatedEmails(
  addresses: readonly string[] | undefined,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, address] of (addresses ?? []).entries()) {
    if (seen.has(address))
      context.addIssue({
        code: 'custom',
        path: ['emails', index],
        message: 'This email address is already listed.',
        params: { code: 'repeated' },
      });
    seen.add(address);
  }
}

const isBlank = (name: string | null) => name === null || name === '';

/**
 * What a contact is beside its names and addresses. Each is optional in a change, as the
 * rest is: left out it stays, null clears it.
 */
const contactAttributeChanges = {
  dateOfBirth: calendarDate.nullable().optional().meta({
    description: 'The day the contact was born, as YYYY-MM-DD. Not in the future. Null clears it.',
  }),
  source: contactSourceText.nullable().optional().meta({
    description:
      'Where the contact came from, in the business’s own words, at most 200 characters. Null clears it.',
  }),
  type: z.enum(contactTypes).nullable().optional().meta({
    description: 'Whether the contact is a lead or a customer. Null clears it.',
  }),
};

/** The most custom fields one request that creates a contact may set. */
export const MAX_CONTACT_CREATE_FIELDS = 100;

/**
 * What the Add Contact panel also holds, so a contact is made whole in one request or not
 * at all: a label for each phone number, a time zone, and do not disturb.
 */
const contactCreationExtras = {
  phoneLabels: z
    .array(z.enum(contactPhoneLabels).nullable())
    .max(MAX_CONTACT_IDENTITIES, { error: 'Give at most 10 labels.' })
    .optional()
    .meta({
      description:
        'A label for each phone number, in the order of phones; null for a number without one. A contact uses each label once.',
    }),
  timeZone: contactPreferenceChanges.timeZone,
  dnd: z
    .strictObject({
      all: z.boolean().default(false).meta({
        description: 'Do not contact: stops every message, on every channel.',
      }),
      channels: z
        .array(z.enum(dndChannels))
        .max(dndChannels.length)
        .default([])
        .meta({ description: 'The channels stopped one at a time.' }),
    })
    .optional()
    .meta({ description: 'Do not disturb, as the contact starts. Left out, nothing is stopped.' }),
  fields: z
    .record(
      z.string().min(1).max(80),
      z.union([z.string(), z.boolean(), z.array(z.string()).max(100)]).nullable(),
    )
    .refine((fields) => Object.keys(fields).length <= MAX_CONTACT_CREATE_FIELDS, {
      error: `Give at most ${String(MAX_CONTACT_CREATE_FIELDS)} custom fields.`,
    })
    .optional()
    .meta({
      description:
        'Custom field values by field key or id (fld_…), as setting a field takes them; a choice by its key or label. Written with the contact, so a workflow it starts reads them.',
      examples: [{ service_interest: 'DJ', budget: '5000' }],
    }),
};

export const createContactInput = z
  .strictObject({
    firstName: personName.default(null),
    lastName: personName.default(null),
    emails: emails.default([]),
    phones: phones.default([]),
    ...contactAttributeChanges,
    ...contactCreationExtras,
  })
  .superRefine((input, context) => {
    refuseRepeatedEmails(input.emails, context);
    const labels = input.phoneLabels ?? [];
    if (labels.length > input.phones.length)
      context.addIssue({
        code: 'custom',
        path: ['phoneLabels'],
        message: 'Give a label for a phone number that is listed.',
        params: { code: 'label_without_phone' },
      });
    labels.forEach((label, index) => {
      if (label !== null && labels.indexOf(label) !== index)
        context.addIssue({
          code: 'custom',
          path: ['phoneLabels', index],
          message: 'A contact uses each label once.',
          params: { code: 'repeated' },
        });
    });
    if (
      isBlank(input.firstName) &&
      isBlank(input.lastName) &&
      input.emails.length === 0 &&
      input.phones.length === 0
    )
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'Give the contact a name, an email address or a phone number.',
        params: { code: 'contact_empty' },
      });
  })
  .meta({ id: 'CreateContactInput' });

export type CreateContactInput = z.input<typeof createContactInput>;

const contactChanges = z.strictObject({
  firstName: personName.optional(),
  lastName: personName.optional(),
  emails: emails.optional().meta({ description: 'Replaces the list. The first is the primary.' }),
  phones: phones.optional().meta({ description: 'Replaces the list. The first is the primary.' }),
  ...contactAttributeChanges,
  ...contactPreferenceChanges,
});

export const updateContactInput = contactChanges
  .superRefine((input, context) => {
    refuseRepeatedEmails(input.emails, context);
    refineContactPreferences(input, context);
  })
  .meta({
    id: 'UpdateContactInput',
    description: 'Only the fields sent change. A contact must keep a name, an email or a phone.',
  });

export type UpdateContactInput = z.input<typeof updateContactInput>;

/** Which contact: as a path parameter, and as a command's input. */
export const contactIdInput = z.object({ id: publicId('contact') });

/** A change to a contact, as the update command takes it: its id and the changes. */
export const updateContactCommandInput = contactChanges
  .extend(contactIdInput.shape)
  .superRefine((input, context) => {
    refuseRepeatedEmails(input.emails, context);
    refineContactPreferences(input, context);
  });

export const contact = z
  .looseObject({
    id: publicId('contact'),
    firstName: z
      .string()
      .nullable()
      .meta({ examples: ['Maya'] }),
    lastName: z
      .string()
      .nullable()
      .meta({ examples: ['Thompson'] }),
    name: z
      .string()
      .nullable()
      .meta({ description: 'The first and last name; null when neither is set.' }),
    emails: z.array(z.string()).meta({ description: 'Lowercased. The first is the primary.' }),
    phones: z.array(contactPhone).meta({ description: 'The first is the primary.' }),
    ...contactPreferences,
    dateOfBirth: calendarDate
      .nullable()
      .optional()
      .meta({ description: 'The day the contact was born, or null.' }),
    source: z
      .string()
      .nullable()
      .optional()
      .meta({ description: 'Where the contact came from, in the business’s own words, or null.' }),
    type: z
      .enum(contactTypes)
      .nullable()
      .optional()
      .meta({ description: 'A lead or a customer, or null when not said.' }),
    trashedAt: timestamp
      .nullable()
      .meta({ description: 'When it was moved to the trash; null when it is not there.' }),
    createdAt: timestamp,
    updatedAt: timestamp,
    canManage: z.boolean().meta({ description: 'Whether you may change it.' }),
  })
  .meta({ id: 'Contact', description: 'A person the business works with.' });

export type Contact = z.infer<typeof contact>;

const group = 'Contacts';

export const createContact = defineEndpoint({
  operationId: 'createContact',
  method: 'post',
  path: '/contacts',
  summary: 'Create a contact',
  group,
  body: createContactInput,
  response: { status: 201, description: 'The new contact.', schema: contact },
});

export const getContact = defineEndpoint({
  operationId: 'getContact',
  method: 'get',
  path: '/contacts/{id}',
  summary: 'Read a contact, including one in the trash',
  group,
  params: contactIdInput,
  response: {
    status: 200,
    description:
      'The contact. A contact merged into another answers 404, with the id of the one it was merged into as mergedInto.',
    schema: contact,
  },
});

export const updateContact = defineEndpoint({
  operationId: 'updateContact',
  method: 'patch',
  path: '/contacts/{id}',
  summary: 'Change a contact',
  group,
  params: contactIdInput,
  body: updateContactInput,
  response: { status: 200, description: 'The changed contact.', schema: contact },
});

export const trashContact = defineEndpoint({
  operationId: 'trashContact',
  method: 'delete',
  path: '/contacts/{id}',
  summary: 'Move a contact to the trash',
  group,
  params: contactIdInput,
  response: {
    status: 200,
    description: 'The contact, in the trash. It keeps its email addresses and phone numbers.',
    schema: contact,
  },
});

export const restoreContact = defineEndpoint({
  operationId: 'restoreContact',
  method: 'post',
  path: '/contacts/{id}/restore',
  summary: 'Restore a contact from the trash',
  group,
  params: contactIdInput,
  response: {
    status: 200,
    description:
      'The restored contact. A contact merged into another cannot be restored: that answers 409.',
    schema: contact,
  },
});

/** How many contacts a page of the list holds when the request does not say. */
export const CONTACT_PAGE_SIZE = 50;
/** The most contacts a page can hold (GoHighLevel offers 20, 50 and 100). */
export const MAX_CONTACT_PAGE_SIZE = 100;

/**
 * The orders the list comes in: by when a contact was added (`newest`), by name with
 * unnamed contacts last, or by when it last changed (`updated`).
 */
export const contactSorts = ['newest', 'name', 'updated'] as const;
export type ContactSort = (typeof contactSorts)[number];
export const contactSortDirections = ['asc', 'desc'] as const;
export type ContactSortDirection = (typeof contactSortDirections)[number];

/** The way an order runs when the request names none: names from A, the others newest first. */
export const contactSortDirection = (
  sort: ContactSort,
  direction?: ContactSortDirection,
): ContactSortDirection => direction ?? (sort === 'name' ? 'asc' : 'desc');

/** At most this many custom fields as columns of one page. */
export const MAX_CONTACT_LIST_FIELDS = 20;

/**
 * What a row of the list can also carry. Each is read only when asked for by name, so a
 * page costs what its visible columns need and no more.
 */
export const contactListExtras = ['lastActivity', 'tags', 'company', 'emailVerification'] as const;
export type ContactListExtra = (typeof contactListExtras)[number];

/** The extras a request names, each once, in the contract's order. */
export function contactListExtrasOf(include: string | undefined): ContactListExtra[] {
  const named = new Set((include ?? '').split(','));
  return contactListExtras.filter((extra) => named.has(extra));
}

const search = z
  .string()
  .trim()
  .max(200, { error: 'Use at most 200 characters.' })
  .optional()
  .meta({
    description:
      'Finds contacts by name (words or any part), email address or phone number digits.',
    examples: ['maya'],
  });

/** What narrows the list: the search and the filters, without an order or a place in it. */
const contactFilterShape = {
  q: search,
  createdFrom: timestamp.optional().meta({ description: 'Added at or after this moment.' }),
  createdBefore: timestamp.optional().meta({ description: 'Added before this moment.' }),
  fieldId: fieldQueryShape.fieldId,
  fieldOperator: fieldQueryShape.fieldOperator,
  fieldValue: fieldQueryShape.fieldValue,
  filter: contactFilterParameter,
};

/** The search, the filters and the order: what makes a list the list it is. */
const contactListShape = {
  q: search,
  sort: z.enum(contactSorts).default('newest'),
  direction: z.enum(contactSortDirections).optional().meta({
    description:
      'Which way the order runs. Left out: names from A, and newest first for the others. Contacts without a name come last either way.',
  }),
};

const listFields = z
  .string()
  .max(MAX_CONTACT_LIST_FIELDS * 32)
  .optional()
  .meta({
    description: `Custom fields to answer on each row, as field ids separated by commas, at most ${String(MAX_CONTACT_LIST_FIELDS)}. Left out, a row has no field values.`,
    examples: ['fld_01h455vb4pex5vsknk084sn02q'],
  });

/** The field ids a `fields` parameter names, each once, in the order given. */
export function contactListFieldsOf(fields: string | undefined): string[] {
  return fields === undefined || fields === '' ? [] : [...new Set(fields.split(','))];
}

function refineListFields(input: { fields?: string | undefined }, context: z.RefinementCtx): void {
  const named = contactListFieldsOf(input.fields);
  if (named.length > MAX_CONTACT_LIST_FIELDS)
    context.addIssue({
      code: 'custom',
      path: ['fields'],
      message: `Name at most ${String(MAX_CONTACT_LIST_FIELDS)} fields.`,
      params: { code: 'too_many_fields' },
    });
  if (named.some((id) => parsePublicId('field', id) === undefined))
    context.addIssue({
      code: 'custom',
      path: ['fields'],
      message: 'Name fields by their ids, separated by commas.',
      params: { code: 'invalid_fields' },
    });
}

/** One order applies to a list: a built-in one with its direction, or a field with its own. */
function refineListOrder(
  input: { direction?: string | undefined; sortField?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (input.direction !== undefined && input.sortField !== undefined)
    context.addIssue({
      code: 'custom',
      path: ['direction'],
      message: 'A field has its own direction: use fieldOrder.',
      params: { code: 'direction_with_field' },
    });
}

export const listContactsQuery = z
  .strictObject({
    ...contactListShape,
    limit: z.coerce
      .number()
      .int()
      .min(1, { error: 'Ask for at least 1 contact.' })
      .max(MAX_CONTACT_PAGE_SIZE, {
        error: `Ask for at most ${String(MAX_CONTACT_PAGE_SIZE)} contacts.`,
      })
      .optional()
      .meta({
        description: `How many contacts a page holds. Left out, ${String(CONTACT_PAGE_SIZE)}.`,
      }),
    fields: listFields,
    after: publicId('contact')
      .optional()
      .meta({ description: "Start after this contact: the previous page's next." }),
    createdFrom: contactFilterShape.createdFrom,
    createdBefore: contactFilterShape.createdBefore,
    filter: contactFilterShape.filter,
    ...fieldQueryShape,
    include: z
      .string()
      .regex(new RegExp(`^(${contactListExtras.join('|')})(,(${contactListExtras.join('|')}))*$`), {
        error: `Name any of ${contactListExtras.join(', ')}, separated by commas.`,
      })
      .optional()
      .meta({
        description:
          'More about each contact, by name and separated by commas: lastActivity, tags, company, emailVerification. Left out, a row has none of them.',
        examples: ['lastActivity,tags'],
      }),
  })
  .superRefine((input, context) => {
    refineFieldQuery(input, context);
    refineListFields(input, context);
    refineListOrder(input, context);
  })
  .meta({ id: 'ListContactsQuery' });

export type ListContactsQuery = z.input<typeof listContactsQuery>;

/**
 * How a contact last got in touch. `form` is a form they sent in and `appointment` a
 * booking made, moved or cancelled; `email`, `sms` and `webchat` are a message from them on
 * that channel. `other` is a message on a channel this version has no name for.
 */
export const contactActivityChannels = [
  'email',
  'sms',
  'webchat',
  'form',
  'appointment',
  'other',
] as const;
export type ContactActivityChannel = (typeof contactActivityChannels)[number];

export const contactLastActivity = z
  .looseObject({
    at: timestamp,
    channel: z.enum(contactActivityChannels),
  })
  .meta({
    id: 'ContactLastActivity',
    description:
      'The newest time the contact got in touch: a message from them, a form they sent in, or an appointment booked, moved or cancelled. A message the business sends is not activity, and neither is an edit made inside the CRM, such as a note or a tag.',
  });
export type ContactLastActivity = z.infer<typeof contactLastActivity>;

export const contactSummary = z
  .looseObject({
    id: publicId('contact'),
    name: z.string().nullable(),
    email: z.string().nullable().meta({ description: 'The primary email address.' }),
    phone: contactPhone.nullable().meta({ description: 'The primary phone number.' }),
    createdAt: timestamp,
    lastActivity: contactLastActivity.nullable().optional().meta({
      description: 'Present when include names lastActivity. Null when there has been none yet.',
    }),
    tags: z
      .array(z.looseObject({ id: publicId('tag'), name: z.string() }))
      .optional()
      .meta({ description: "Present when include names tags: the contact's tags, by name." }),
    company: z
      .looseObject({ id: publicId('company'), name: z.string() })
      .nullable()
      .optional()
      .meta({
        description:
          "Present when include names company: the contact's primary company, or null when it has none or that company is in the trash.",
      }),
    emailVerification: z.enum(contactEmailVerifications).nullable().optional().meta({
      description:
        'Present when include names emailVerification: what verification found of the primary email address; null without one.',
    }),
    fields: z
      .record(
        z.string(),
        z
          .union([z.string(), z.boolean(), z.array(z.string()), z.record(z.string(), z.string())])
          .nullable(),
      )
      .optional()
      .meta({
        description:
          "Present when fields names any: the value of each field asked for, by field id, as a record field shows it (numbers and money as exact decimal text, choices as option keys, a text box list's text by option key, a file upload field's file ids). Null when the contact has none.",
      }),
  })
  .meta({ id: 'ContactSummary', description: 'A contact, as the list shows it.' });

export type ContactSummary = z.infer<typeof contactSummary>;

export const contactList = z
  .looseObject({
    items: z.array(contactSummary),
    next: publicId('contact')
      .nullable()
      .meta({ description: 'Pass it as after to read the next page. Null on the last page.' }),
    canManage: z.boolean().meta({ description: 'Whether you may add and change contacts.' }),
  })
  .meta({ id: 'ContactList' });

export type ContactList = z.infer<typeof contactList>;

export const listContacts = defineEndpoint({
  operationId: 'listContacts',
  method: 'get',
  path: '/contacts',
  summary: 'List contacts not in the trash, with search and filters',
  group,
  query: listContactsQuery,
  response: {
    status: 200,
    description: `A page of contacts, ${String(CONTACT_PAGE_SIZE)} at most.`,
    schema: contactList,
  },
});

/**
 * How far a narrowed list is counted. A search or a filter is tested contact by contact,
 * so its count stops here and says so; the whole list is counted from an index and has no
 * such limit.
 */
export const CONTACT_COUNT_LIMIT = 10_000;

export const countContactsQuery = z
  .strictObject(contactFilterShape)
  .superRefine(refineFieldQuery)
  .meta({ id: 'CountContactsQuery' });

export type CountContactsQuery = z.input<typeof countContactsQuery>;

export const contactCount = z
  .looseObject({
    count: z
      .int()
      .min(0)
      .meta({
        description: `How many contacts the list holds. With a search or a filter it is counted up to ${String(CONTACT_COUNT_LIMIT)}.`,
      }),
    exact: z.boolean().meta({
      description: `False when a search or a filter was not counted to its end: count is then the least it can be, and is shown as "${String(CONTACT_COUNT_LIMIT)}+".`,
    }),
  })
  .meta({ id: 'ContactCount' });

export type ContactCount = z.infer<typeof contactCount>;

export const countContacts = defineEndpoint({
  operationId: 'countContacts',
  method: 'get',
  path: '/contacts/count',
  summary: 'Count the contacts a list holds, with the same search and filters',
  group,
  query: countContactsQuery,
  response: {
    status: 200,
    description: 'The number of contacts not in the trash that the search and filters keep.',
    schema: contactCount,
  },
});

/** A list as a contact's neighbours are asked of it: the search, the filters and the order. */
export const contactNeighboursQuery = z
  .strictObject({
    ...contactListShape,
    createdFrom: contactFilterShape.createdFrom,
    createdBefore: contactFilterShape.createdBefore,
    filter: contactFilterShape.filter,
    fieldId: fieldQueryShape.fieldId,
    fieldOperator: fieldQueryShape.fieldOperator,
    fieldValue: fieldQueryShape.fieldValue,
  })
  .superRefine(refineFieldQuery)
  .meta({ id: 'ContactNeighboursQuery' });
export type ContactNeighboursQuery = z.input<typeof contactNeighboursQuery>;

const neighbour = z
  .looseObject({ id: publicId('contact'), name: z.string().nullable() })
  .nullable();

export const contactNeighbours = z
  .looseObject({
    inList: z.boolean().meta({
      description:
        'Whether the list holds the contact. False when a filter no longer keeps it or it is in the trash: the rest is then null.',
    }),
    previous: neighbour.meta({ description: 'The contact before it in the list, or null.' }),
    next: neighbour.meta({ description: 'The contact after it in the list, or null.' }),
    position: z
      .int()
      .min(1)
      .nullable()
      .meta({
        description: `Its place in the list, from 1. Null when it is not in the list, or when more than ${String(CONTACT_COUNT_LIMIT)} contacts of a searched or filtered list come before it.`,
      }),
  })
  .meta({ id: 'ContactNeighbours' });
export type ContactNeighbours = z.infer<typeof contactNeighbours>;

export const getContactNeighbours = defineEndpoint({
  operationId: 'getContactNeighbours',
  method: 'get',
  path: '/contacts/{id}/neighbours',
  summary: 'Read the contacts before and after one in a list, and its place',
  group,
  params: contactIdInput,
  query: contactNeighboursQuery,
  response: {
    status: 200,
    description:
      'The previous and next contact in the list the parameters describe, so a contact page can step through a list after a reload.',
    schema: contactNeighbours,
  },
});
