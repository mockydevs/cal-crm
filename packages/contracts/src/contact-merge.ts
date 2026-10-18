// Merging contacts, as GoHighLevel's Merge Contacts does: up to ten contacts become one. The
// contact kept (the master) keeps its own values unless another value is picked field by
// field; a field it has empty takes the first value the others have. Tags, notes, tasks,
// conversations and everything else of the others move to it, and the others go to the
// trash, never to come back. A merge cannot be undone.
// https://help.gohighlevel.com/support/solutions/articles/48001202210
//
// Do not disturb is not picked: the stricter setting of all the contacts is kept, so no
// opt-out is lost by merging.
import * as z from 'zod';

import { contact } from './contacts.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';

/** GoHighLevel's limit: ten contacts in one merge, the one kept among them. */
export const MAX_CONTACTS_IN_MERGE = 10;

/**
 * The most rows a merge moves, across every contact merged away and every kind of row
 * (timeline entries, notes, messages and the rest). A merge holds its contacts while it runs,
 * so a larger one is refused rather than holding them for long.
 */
export const MAX_CONTACT_MERGE_ROWS = 50_000;

/** The contact's own fields that a merge can take from any of the contacts. */
export const contactMergeChoiceFields = [
  'firstName',
  'lastName',
  'dateOfBirth',
  'source',
  'type',
  'timeZone',
  'owner',
] as const;
export type ContactMergeChoiceField = (typeof contactMergeChoiceFields)[number];

/** The most custom fields one merge names. */
export const MAX_CONTACT_MERGE_CUSTOM_FIELDS = 500;

const group = 'Contacts';
const revision = z.string().regex(/^[0-9a-f]{64}$/);
const contactId = publicId('contact');

const mergeIds = z
  .array(contactId)
  .min(1, { error: 'Name at least one contact to merge into this one.' })
  .max(MAX_CONTACTS_IN_MERGE - 1, {
    error: `Merge at most ${String(MAX_CONTACTS_IN_MERGE)} contacts at a time, this one included.`,
  })
  .refine((ids) => new Set(ids).size === ids.length, { error: 'Name each contact once.' })
  .meta({
    description: `The contacts merged into this one and then trashed, in order: a field this contact has empty takes the first of their values. At most ${String(MAX_CONTACTS_IN_MERGE - 1)}.`,
  });

export const mergeContactsInput = z
  .strictObject({
    mergeIds,
    fields: z.partialRecord(z.enum(contactMergeChoiceFields), contactId).optional().meta({
      description:
        "Which contact's value each of the contact's own fields keeps. A field left out keeps this contact's value, or the first value of the others when this contact's is empty.",
    }),
    customFields: z
      .record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), contactId)
      .refine((fields) => Object.keys(fields).length <= MAX_CONTACT_MERGE_CUSTOM_FIELDS, {
        error: `Name at most ${String(MAX_CONTACT_MERGE_CUSTOM_FIELDS)} custom fields.`,
      })
      .optional()
      .meta({
        description:
          "Which contact's value each custom field keeps, by the field's key. Picking a contact with no value empties the field. A field left out keeps this contact's value, or the first value of the others when this contact's is empty.",
      }),
    primaryEmail: z.string().trim().toLowerCase().max(320).optional().meta({
      description:
        "Which of the contacts' email addresses becomes the primary one. Left out: this contact's primary address, or the first of the others' when it has none.",
    }),
    primaryPhone: z
      .string()
      .regex(/^\+[1-9][0-9]{6,14}$/, { error: 'Give the phone number in E.164, as +254712345678.' })
      .optional()
      .meta({
        description:
          "Which of the contacts' phone numbers becomes the primary one, in E.164. Left out: this contact's primary number, or the first of the others' when it has none.",
      }),
    revisions: z
      .record(contactId, revision)
      .refine((revisions) => Object.keys(revisions).length <= MAX_CONTACTS_IN_MERGE, {
        error: `Give at most ${String(MAX_CONTACTS_IN_MERGE)} revisions, one for each contact.`,
      })
      .meta({
        description:
          "Each contact's revision, this one's included, as previewContactMerge gave it. A contact changed since returns 409.",
      }),
  })
  .meta({ id: 'MergeContactsInput' });
export type MergeContactsInput = z.input<typeof mergeContactsInput>;

/** The merge as its command takes it: the contact kept, and the request. */
export const mergeContactsCommandInput = mergeContactsInput
  .extend({ id: contactId })
  .superRefine((input, context) => {
    if (input.mergeIds.includes(input.id))
      context.addIssue({
        code: 'custom',
        path: ['mergeIds'],
        message: 'The contact kept cannot also be merged away.',
        params: { code: 'merges_itself' },
      });
    const all = new Set([input.id, ...input.mergeIds]);
    const picked = [
      ...Object.entries(input.fields ?? {}).map(([key, id]) => ['fields', key, id] as const),
      ...Object.entries(input.customFields ?? {}).map(
        ([key, id]) => ['customFields', key, id] as const,
      ),
    ];
    for (const [where, key, id] of picked)
      if (!all.has(id))
        context.addIssue({
          code: 'custom',
          path: [where, key],
          message: 'Pick one of the contacts being merged.',
          params: { code: 'not_merged' },
        });
    for (const id of all)
      if (input.revisions[id] === undefined)
        context.addIssue({
          code: 'custom',
          path: ['revisions', id],
          message: "Give every contact's revision.",
          params: { code: 'revision_missing' },
        });
    for (const id of Object.keys(input.revisions))
      if (!all.has(id))
        context.addIssue({
          code: 'custom',
          path: ['revisions', id],
          message: 'Give revisions only of the contacts being merged.',
          params: { code: 'not_merged' },
        });
  });
export type MergeContactsCommandInput = z.output<typeof mergeContactsCommandInput>;

/** What moved, by module and kind of row: counts only. */
const moved = z.record(z.string(), z.record(z.string(), z.int().min(0))).meta({
  description:
    'How many rows moved to the contact kept (or were combined with its own), by module and kind of row, such as {"crm": {"notes": 3}}.',
});

export const contactMerge = z
  .looseObject({
    contact: contact.meta({ description: 'The contact kept, as it is after the merge.' }),
    mergedIds: z
      .array(contactId)
      .meta({ description: 'The contacts merged into it, now in the trash.' }),
    moved,
  })
  .meta({ id: 'ContactMerge' });
export type ContactMerge = z.infer<typeof contactMerge>;

export const contactMergePreviewQuery = z
  .strictObject({
    mergeIds: z
      .string()
      .min(1)
      .max(1000)
      .transform((ids) => ids.split(','))
      .pipe(mergeIds)
      .meta({ description: 'The contacts to merge into this one, comma-separated.' }),
  })
  .meta({ id: 'ContactMergePreviewQuery' });

export const contactMergePreview = z
  .looseObject({
    contacts: z
      .array(z.looseObject({ id: contactId, revision }))
      .meta({ description: 'Each contact, this one first: the revision a merge names.' }),
    moved,
    rows: z.int().min(0).meta({ description: 'How many rows the merge would move in all.' }),
    maxRows: z.int().min(1).meta({
      description: 'The most rows one merge moves. A merge over it is refused.',
    }),
  })
  .meta({ id: 'ContactMergePreview' });
export type ContactMergePreview = z.infer<typeof contactMergePreview>;

const params = z.object({ id: contactId });

export const previewContactMerge = defineEndpoint({
  operationId: 'previewContactMerge',
  method: 'get',
  path: '/contacts/{id}/merge-preview',
  summary: 'See what merging contacts into this one would move',
  group,
  params,
  query: contactMergePreviewQuery,
  response: {
    status: 200,
    description:
      "What would move, and each contact's revision for the merge. Needs contacts.merge.",
    schema: contactMergePreview,
  },
});

export const mergeContacts = defineEndpoint({
  operationId: 'mergeContacts',
  method: 'post',
  path: '/contacts/{id}/merge',
  summary: 'Merge contacts into this one',
  group,
  params,
  body: mergeContactsInput,
  response: {
    status: 200,
    description:
      'The contact kept. The others are in the trash, cannot be restored, and their ids answer 404 with mergedInto. It cannot be undone. Needs contacts.merge.',
    schema: contactMerge,
  },
});

export const contactMergeEndpoints = [previewContactMerge, mergeContacts] as const;
