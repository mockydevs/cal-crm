// Bulk actions on contacts: one change applied to the contacts selected in the list, or to
// a whole filtered list, and the Bulk Actions tab that lists what was started. GoHighLevel
// documents adding and removing tags, deleting, "Add to Workflow", sending an email or a
// text message, exporting as CSV and adding an opportunity from the list's action bar, and
// enabling or disabling do not disturb for every channel or chosen ones as a workflow
// action; changing the owner is this product's own command applied to each contact. A
// delete here is a move to the trash, as deleting one contact is. Adding to a workflow
// enrols each contact in one published workflow by the rules every enrolment keeps: once at
// a time, and again only where the workflow's re-entry setting allows.
//
// The contacts are fixed when the action starts. Up to CONTACT_BULK_INLINE_LIMIT are changed
// before the request answers; more run in the background a batch at a time, and the action
// says how far it has got. Every contact ends with one outcome, and one that cannot be
// changed is skipped with its reason and never stops the others. A send, a tag change, an
// enrolment or an opportunity can also start later, or go out in timed batches (drip mode).
import * as z from 'zod';

import { actor } from './activity.js';
import { dndChannels } from './contact-attributes.js';
import { assignContactOwnerInput } from './contact-people.js';
import { contactFilter } from './contact-filters.js';
import { DO_NOT_CONTACT_REASON_MAX, DO_NOT_CONTACT_REASON_MIN } from './contact-preferences.js';
import { defineEndpoint } from './endpoints.js';
import { fieldQueryShape, refineFieldQuery } from './field-query.js';
import { fileLink } from './files.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** The most contacts changed before the request answers, and the size of a background batch. */
export const CONTACT_BULK_INLINE_LIMIT = 100;
/** The most contacts one action covers. */
export const CONTACT_BULK_LIMIT = 100_000;
/** The most tags one action adds or removes. */
export const CONTACT_BULK_TAG_LIMIT = 20;
/** How many actions or outcomes a page holds unless asked, and the most it holds. */
export const CONTACT_BULK_PAGE_SIZE = 20;
export const MAX_CONTACT_BULK_PAGE_SIZE = 100;
/** The most contacts one batch of drip mode reaches, as GoHighLevel's Batch Quantity allows. */
export const CONTACT_BULK_DRIP_BATCH_MAX = 10_000;
/** The longest wait between two batches of drip mode, in minutes: thirty days. */
export const CONTACT_BULK_DRIP_INTERVAL_MAX = 30 * 24 * 60;
/** The most columns an export writes. */
export const CONTACT_EXPORT_COLUMN_LIMIT = 50;
/** The longest a text message of a bulk send is, as messaging takes one. */
export const CONTACT_BULK_SMS_MAX = 1600;
/** How long a link to an export's file works, in seconds. */
export const CONTACT_EXPORT_LINK_SECONDS = 900;

export const contactBulkActionKinds = [
  'add_tags',
  'remove_tags',
  'trash',
  'assign_owner',
  'add_to_workflow',
  'export',
  'send_email',
  'send_sms',
  'set_dnd',
  'add_opportunity',
  'verify_emails',
] as const;
export type ContactBulkActionKind = (typeof contactBulkActionKinds)[number];

export const contactBulkStatuses = [
  'queued',
  'running',
  'completed',
  'cancelled',
  'failed',
] as const;
export type ContactBulkStatus = (typeof contactBulkStatuses)[number];

export const contactBulkOutcomes = ['done', 'unchanged', 'skipped'] as const;
export type ContactBulkOutcome = (typeof contactBulkOutcomes)[number];

const once = (items: readonly unknown[]) => new Set(items).size === items.length;

const contactIds = (most: number, what: string) =>
  z
    .array(publicId('contact'))
    .max(most, { error: `Name at most ${String(most)} contacts ${what}.` })
    .refine(once, { error: 'Name each contact once.', params: { code: 'repeated' } });

const search = z.string().trim().max(200, { error: 'Use at most 200 characters.' });

/** Which contacts: the ones named, or everything a list holds less the ones left out. */
export const contactBulkSelection = z
  .union([
    z.strictObject({
      ids: contactIds(CONTACT_BULK_INLINE_LIMIT, 'at a time').min(1, {
        error: 'Select at least one contact.',
      }),
    }),
    z
      .strictObject({
        all: z.literal(true).meta({
          description:
            'Every contact the list holds with this search and these filters, counted when the action starts.',
        }),
        q: search.optional(),
        filter: contactFilter.optional(),
        createdFrom: timestamp.optional(),
        createdBefore: timestamp.optional(),
        // The list's one custom-field filter, as listContacts takes it.
        fieldId: fieldQueryShape.fieldId,
        fieldOperator: fieldQueryShape.fieldOperator,
        fieldValue: fieldQueryShape.fieldValue,
        except: contactIds(CONTACT_BULK_INLINE_LIMIT, 'to leave out')
          .optional()
          .meta({ description: 'Contacts of the list that were unticked.' }),
      })
      .superRefine(refineFieldQuery),
  ])
  .meta({ id: 'ContactBulkSelection' });
export type ContactBulkSelection = z.output<typeof contactBulkSelection>;

const common = {
  selection: contactBulkSelection,
  name: z
    .string()
    .trim()
    .min(1, { error: 'Enter a name, or leave it out.' })
    .max(200, { error: 'Use at most 200 characters.' })
    .optional()
    .meta({
      description: 'Shown in the list of bulk actions.',
      examples: ['Tag trade fair leads'],
    }),
  requestId: z.uuid().optional().meta({
    description:
      'Your own id for this request. Sent again with the same id, the request starts nothing new and answers the action it started the first time.',
  }),
};

const tagIds = z
  .array(publicId('tag'))
  .min(1, { error: 'Choose at least one tag.' })
  .max(CONTACT_BULK_TAG_LIMIT, {
    error: `Choose at most ${String(CONTACT_BULK_TAG_LIMIT)} tags.`,
  })
  .refine(once, { error: 'Name each tag once.', params: { code: 'repeated' } });

/**
 * When an action runs, as GoHighLevel's bulk actions offer it: now, from a later time, or
 * in timed batches (drip mode: a number of contacts, then a wait, then the next). Left out,
 * the action runs now. The contacts are fixed when it starts either way.
 */
export const contactBulkDelivery = z
  .strictObject({
    startAt: timestamp.optional().meta({
      description:
        'When the first contacts are reached, at most thirty days ahead. Left out, or already past, now.',
    }),
    drip: z
      .strictObject({
        batchSize: z
          .int()
          .min(1, { error: 'Reach at least one contact a batch.' })
          .max(CONTACT_BULK_DRIP_BATCH_MAX, {
            error: `Reach at most ${String(CONTACT_BULK_DRIP_BATCH_MAX)} contacts a batch.`,
          })
          .meta({ description: 'How many contacts each batch reaches.' }),
        intervalMinutes: z
          .int()
          .min(1, { error: 'Wait at least a minute between batches.' })
          .max(CONTACT_BULK_DRIP_INTERVAL_MAX, {
            error: 'Wait at most thirty days between batches.',
          })
          .meta({ description: 'How long after one batch the next starts, in minutes.' }),
      })
      .optional()
      .meta({ description: 'Drip mode. Left out, every contact is reached in one go.' }),
  })
  .meta({ id: 'ContactBulkDelivery' });
export type ContactBulkDelivery = z.infer<typeof contactBulkDelivery>;

/** A built-in column of an export, as the contact table names its columns. */
export const contactExportColumnKeys = [
  'name',
  'phone',
  'email',
  'company',
  'added',
  'lastActivity',
  'tags',
] as const;
export type ContactExportColumnKey = (typeof contactExportColumnKeys)[number];

const exportColumns = z
  .array(
    z.union([z.enum(contactExportColumnKeys), publicId('field')]).meta({
      description: 'A built-in column by its key, or a custom field of contacts by its id.',
    }),
  )
  .min(1, { error: 'Choose at least one column.' })
  .max(CONTACT_EXPORT_COLUMN_LIMIT, {
    error: `Choose at most ${String(CONTACT_EXPORT_COLUMN_LIMIT)} columns.`,
  })
  .refine(once, { error: 'Name each column once.', params: { code: 'repeated' } })
  .meta({
    description:
      'The columns the file has, in this order: the ones the list shows, as GoHighLevel exports them.',
  });

const singleLine = /^[^\r\n]*$/;

const sendEmail = z
  .strictObject({
    action: z.literal('send_email'),
    mailbox: publicId('mailbox').optional().meta({
      description:
        "The mailbox it is sent from. Left out, the business's only working mailbox for conversations.",
    }),
    fromName: z.string().trim().min(1).max(120).regex(singleLine).optional(),
    subject: z
      .string()
      .trim()
      .min(1, { error: 'Enter a subject.' })
      .max(998)
      .regex(singleLine, { error: 'Keep the subject to one line.' })
      .optional()
      .meta({ description: "Required with a body. With a template, it replaces the template's." }),
    body: z
      .string()
      .trim()
      .min(1, { error: 'Write the email.' })
      .max(100_000)
      .optional()
      .meta({ description: 'Plain text, with merge fields such as {{contact.first_name}}.' }),
    templateId: publicId('template').optional().meta({
      description: 'An email template to send instead of a body of its own.',
    }),
    delivery: contactBulkDelivery.optional(),
    ...common,
  })
  .superRefine((input, context) => {
    if ((input.body === undefined) === (input.templateId === undefined))
      context.addIssue({
        code: 'custom',
        path: ['body'],
        message: 'Write the email, or choose a template.',
        params: { code: 'body_or_template' },
      });
    if (input.body !== undefined && input.subject === undefined)
      context.addIssue({
        code: 'custom',
        path: ['subject'],
        message: 'Enter a subject.',
        params: { code: 'required' },
      });
  });

export const bulkContactsInput = z
  .discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('add_tags'),
      tagIds,
      delivery: contactBulkDelivery.optional(),
      ...common,
    }),
    z
      .strictObject({
        action: z.literal('remove_tags'),
        tagIds: tagIds.optional(),
        all: z.literal(true).optional().meta({
          description: 'Remove every tag each contact has, instead of the tags named.',
        }),
        delivery: contactBulkDelivery.optional(),
        ...common,
      })
      .superRefine((input, context) => {
        if ((input.tagIds === undefined) === (input.all === undefined))
          context.addIssue({
            code: 'custom',
            path: ['tagIds'],
            message: 'Name the tags to remove, or ask for all of them.',
            params: { code: 'tags_or_all' },
          });
      }),
    z.strictObject({ action: z.literal('trash'), ...common }),
    z.strictObject({
      action: z.literal('assign_owner'),
      owner: assignContactOwnerInput.shape.owner,
      ...common,
    }),
    z.strictObject({
      action: z.literal('add_to_workflow'),
      workflowId: publicId('automation').meta({
        description:
          'The workflow to add the contacts to. Only a published workflow that is not paused can be chosen.',
      }),
      delivery: contactBulkDelivery.optional(),
      ...common,
    }),
    z.strictObject({
      action: z.literal('export'),
      columns: exportColumns,
      ...common,
    }),
    sendEmail,
    z.strictObject({
      action: z.literal('send_sms'),
      number: publicId('phone_number').optional().meta({
        description:
          "The number it is sent from. Left out, the business's only number that can send text messages.",
      }),
      message: z
        .string()
        .trim()
        .min(1, { error: 'Write the message.' })
        .max(CONTACT_BULK_SMS_MAX, {
          error: `Keep the message to ${String(CONTACT_BULK_SMS_MAX)} characters.`,
        })
        .meta({ description: 'With merge fields such as {{contact.first_name}}.' }),
      delivery: contactBulkDelivery.optional(),
      ...common,
    }),
    z.strictObject({
      action: z.literal('set_dnd'),
      dnd: z.enum(['on', 'off']).meta({ description: 'Turn do not disturb on, or off.' }),
      channels: z
        .union([
          z.literal('all'),
          z
            .array(z.enum(dndChannels))
            .min(1, { error: 'Choose at least one channel.' })
            .max(dndChannels.length)
            .refine(once, { error: 'Name each channel once.', params: { code: 'repeated' } }),
        ])
        .meta({
          description:
            'all: on stops every channel at once (do not contact); off clears that and every channel. A list turns those channels on or off and leaves the rest as each contact has them.',
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
        .meta({ description: 'Why. It is kept in the audit log, as a single change keeps it.' }),
      ...common,
    }),
    z.strictObject({
      action: z.literal('add_opportunity'),
      pipelineId: publicId('pipeline'),
      stageId: publicId('stage').optional().meta({
        description: "The stage. Left out, the pipeline's first.",
      }),
      opportunityName: z.string().trim().min(1).max(200).optional().meta({
        description: "Each opportunity's name. Left out, its contact's name.",
      }),
      status: z.enum(['open', 'won']).default('open'),
      amount: z
        .string()
        .regex(/^\d{1,14}(\.\d{1,4})?$/, {
          error: 'Enter a nonnegative decimal amount with at most four decimal places.',
        })
        .optional()
        .meta({ description: "The opportunity's value, in the business's currency." }),
      source: z.string().trim().min(1).max(200).optional(),
      allowDuplicates: z.boolean().default(false).meta({
        description:
          'Whether a contact that is already with an opportunity gets another. Off, as GoHighLevel has it, such a contact is skipped.',
      }),
      delivery: contactBulkDelivery.optional(),
      ...common,
    }),
    // Email verification checks each primary email address, behind all other work and
    // within the business's daily verification limit. A current result is kept: valid,
    // risky or invalid, from the last 90 days, and from the mailbox while a provider is
    // connected.
    z.strictObject({ action: z.literal('verify_emails'), ...common }),
  ])
  .meta({ id: 'BulkContactsInput' });
export type BulkContactsInput = z.input<typeof bulkContactsInput>;

export const contactBulkAction = z
  .looseObject({
    id: publicId('bulk_action'),
    name: z.string().nullable(),
    action: z.enum(contactBulkActionKinds),
    status: z.enum(contactBulkStatuses).meta({
      description:
        'queued: waiting for the worker or its start time. running: some contacts are done. completed: every contact has an outcome. cancelled: stopped; what was done stays done. failed: an export whose file could not be kept, or an action whose starter left the team or may no longer do it; failure says why.',
    }),
    requested: z.int().min(1).meta({ description: 'How many contacts the action covers.' }),
    done: z.int().min(0).meta({ description: 'Changed.' }),
    unchanged: z.int().min(0).meta({ description: 'Already as asked, so nothing was written.' }),
    skipped: z.int().min(0).meta({ description: 'Could not be changed; each says why.' }),
    actor,
    createdAt: timestamp,
    startedAt: timestamp.nullable(),
    finishedAt: timestamp.nullable(),
    canCancel: z.boolean().meta({
      description: 'Whether it can still be stopped, and you may stop it.',
    }),
    drip: z
      .looseObject({ batchSize: z.int().min(1), intervalMinutes: z.int().min(1) })
      .nullable()
      .meta({ description: 'Drip mode, when the action runs in timed batches.' }),
    nextBatchAt: timestamp.nullable().meta({
      description: 'When the next contacts are reached, for an action waiting for its time.',
    }),
    file: z
      .looseObject({ filename: z.string(), size: z.int().min(0) })
      .nullable()
      .meta({ description: "An export's file, once it is written, until it expires." }),
    fileExpiresAt: timestamp.nullable().meta({
      description:
        "When a completed export's file is removed: thirty days after the export, as GoHighLevel keeps one. Past it, the file is gone.",
    }),
    failure: z
      .looseObject({ code: z.string(), message: z.string() })
      .nullable()
      .meta({ description: 'Why a failed action failed.' }),
  })
  .meta({ id: 'ContactBulkAction' });
export type ContactBulkAction = z.infer<typeof contactBulkAction>;

const group = 'Contacts';

export const bulkUpdateContacts = defineEndpoint({
  operationId: 'bulkUpdateContacts',
  method: 'post',
  path: '/contacts/bulk',
  summary:
    'Tag, trash, reassign, add to a workflow, export, email, text, set do not disturb, add opportunities or verify email addresses for many contacts at once',
  group,
  body: bulkContactsInput,
  response: {
    status: 201,
    description: `The action. Up to ${String(CONTACT_BULK_INLINE_LIMIT)} contacts are changed before it answers and it is completed; more are queued and changed in the background.`,
    schema: contactBulkAction,
  },
});

export const contactBulkActionsQuery = z
  .strictObject({
    after: publicId('bulk_action')
      .optional()
      .meta({ description: "Start after this action: the previous page's next." }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_CONTACT_BULK_PAGE_SIZE)
      .default(CONTACT_BULK_PAGE_SIZE),
    action: z.enum(contactBulkActionKinds).optional(),
    status: z.enum(contactBulkStatuses).optional(),
  })
  .meta({ id: 'ContactBulkActionsQuery' });

export const contactBulkActionList = z
  .looseObject({
    items: z.array(contactBulkAction).meta({ description: 'Newest first.' }),
    next: publicId('bulk_action').nullable().meta({
      description: 'Pass it as after to read the next page. Null on the last page.',
    }),
  })
  .meta({ id: 'ContactBulkActionList' });
export type ContactBulkActionList = z.infer<typeof contactBulkActionList>;

export const listContactBulkActions = defineEndpoint({
  operationId: 'listContactBulkActions',
  method: 'get',
  path: '/contacts/bulk-actions',
  summary: 'List the bulk actions started on contacts, newest first',
  group,
  query: contactBulkActionsQuery,
  response: { status: 200, description: 'A page of bulk actions.', schema: contactBulkActionList },
});

export const contactBulkActionIdInput = z.object({ id: publicId('bulk_action') });

export const getContactBulkAction = defineEndpoint({
  operationId: 'getContactBulkAction',
  method: 'get',
  path: '/contacts/bulk-actions/{id}',
  summary: 'Read a bulk action on contacts and how far it has got',
  group,
  params: contactBulkActionIdInput,
  response: { status: 200, description: 'The action.', schema: contactBulkAction },
});

export const cancelContactBulkAction = defineEndpoint({
  operationId: 'cancelContactBulkAction',
  method: 'post',
  path: '/contacts/bulk-actions/{id}/cancel',
  summary: 'Stop a bulk action on contacts',
  group,
  params: contactBulkActionIdInput,
  response: {
    status: 200,
    description:
      'The action. Contacts already changed stay changed; the rest are left as they are. Stopping an action that has ended changes nothing.',
    schema: contactBulkAction,
  },
});

/**
 * Why a contact was skipped. `refused` is any other refusal of the single-contact command.
 * Adding to a workflow: `already_in_workflow` (the contact is in it now, and is in it once
 * at a time), `reentry_not_allowed` (it has been through a workflow that takes a contact
 * once), `workflow_unavailable` (the workflow was paused, deleted or unpublished since).
 * Sending: `no_address` (no email address or phone number), `do_not_disturb`, `no_consent`,
 * `suppressed`, `missing_values` (a merge field the contact has no value for),
 * `sender_unavailable` (the mailbox or number can no longer send), `message_refused` (any
 * other refusal of the outbound policy). Adding an opportunity: `has_opportunity` (the
 * contact is with one already and duplicates are off), `no_name` (nothing to name it by),
 * `stage_unavailable` (the pipeline or stage was deleted since). Verifying emails:
 * `no_address` (no email address), `verification_excluded` (the address is left out of
 * verification), `daily_limit` (the day's verification limit is used up), `verification_off`
 * (email verification was turned off since).
 */
export const contactBulkSkipCodes = [
  'not_found',
  'in_trash',
  'unknown_tag',
  'unavailable_member',
  'already_in_workflow',
  'reentry_not_allowed',
  'workflow_unavailable',
  'no_address',
  'do_not_disturb',
  'no_consent',
  'suppressed',
  'missing_values',
  'sender_unavailable',
  'message_refused',
  'has_opportunity',
  'no_name',
  'stage_unavailable',
  'verification_excluded',
  'daily_limit',
  'verification_off',
  'refused',
] as const;
export type ContactBulkSkipCode = (typeof contactBulkSkipCodes)[number];

export const contactBulkItem = z
  .looseObject({
    contactId: publicId('contact'),
    name: z.string().nullable().meta({
      description: "The contact's name now. Null when it has none, or the contact is not found.",
    }),
    outcome: z.enum(contactBulkOutcomes).nullable().meta({
      description: 'Null while the contact waits its turn, or when the action was stopped first.',
    }),
    reason: z
      .looseObject({ code: z.enum(contactBulkSkipCodes), message: z.string() })
      .nullable()
      .meta({ description: 'Why it was skipped; null otherwise.' }),
  })
  .meta({ id: 'ContactBulkItem' });
export type ContactBulkItem = z.infer<typeof contactBulkItem>;

export const contactBulkItemsQuery = z
  .strictObject({
    outcome: z
      .enum([...contactBulkOutcomes, 'pending'])
      .optional()
      .meta({ description: 'Only the contacts with this outcome, or still without one.' }),
    after: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .meta({ description: "Start after this place: the previous page's next." }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_CONTACT_BULK_PAGE_SIZE)
      .default(CONTACT_BULK_PAGE_SIZE),
  })
  .meta({ id: 'ContactBulkItemsQuery' });

export const contactBulkItemList = z
  .looseObject({
    items: z.array(contactBulkItem).meta({ description: 'In the order they are applied.' }),
    next: z.int().min(1).nullable().meta({
      description: 'Pass it as after to read the next page. Null on the last page.',
    }),
  })
  .meta({ id: 'ContactBulkItemList' });
export type ContactBulkItemList = z.infer<typeof contactBulkItemList>;

export const listContactBulkActionItems = defineEndpoint({
  operationId: 'listContactBulkActionItems',
  method: 'get',
  path: '/contacts/bulk-actions/{id}/items',
  summary: 'List what became of each contact a bulk action named',
  group,
  params: contactBulkActionIdInput,
  query: contactBulkItemsQuery,
  response: {
    status: 200,
    description: 'A page of contacts with their outcomes, and why each skipped one was skipped.',
    schema: contactBulkItemList,
  },
});

export const createContactExportLink = defineEndpoint({
  operationId: 'createContactExportLink',
  method: 'post',
  path: '/contacts/bulk-actions/{id}/file-link',
  summary: "Create a link to an export's CSV file",
  group,
  params: contactBulkActionIdInput,
  response: {
    status: 201,
    description: `A link that opens the export's file for ${String(CONTACT_EXPORT_LINK_SECONDS / 60)} minutes. Every cell is written so that a spreadsheet shows it as text.`,
    schema: fileLink,
  },
});

export const previewContactEmailChecksInput = z
  .strictObject({ selection: contactBulkSelection })
  .meta({ id: 'PreviewContactEmailChecksInput' });

const count = z.int().min(0);

export const contactEmailCheckPreview = z
  .looseObject({
    contacts: count.meta({ description: 'How many contacts the selection holds.' }),
    noEmail: count.meta({ description: 'Contacts without an email address: skipped.' }),
    excluded: count.meta({
      description: 'Primary addresses left out of verification: skipped.',
    }),
    current: count.meta({
      description:
        'Primary addresses with a current result, kept as they are at no cost: valid, risky or invalid, from the last 90 days, and a mailbox result while a provider is connected. Re-verify after 90 days does not change this.',
    }),
    checks: count.meta({ description: 'Primary addresses that would be checked now.' }),
    providerCalls: count.meta({
      description:
        "Of those, how many the provider would check, each using a credit: none without a provider, and no more than today's limit leaves.",
    }),
    overLimit: count.meta({
      description: "Checks past what today's verification limit leaves: skipped.",
    }),
    remainingToday: count.nullable().meta({
      description:
        'How many provider checks the daily verification limit still allows today, or null with no provider connected.',
    }),
    provider: z.enum(['connected', 'failing', 'disconnected']).nullable().meta({
      description: "The verification provider's connection, or null when there is none.",
    }),
    enabled: z.boolean().meta({ description: 'Whether email verification is on.' }),
  })
  .meta({ id: 'ContactEmailCheckPreview' });
export type ContactEmailCheckPreview = z.infer<typeof contactEmailCheckPreview>;

export const previewContactEmailChecks = defineEndpoint({
  operationId: 'previewContactEmailChecks',
  method: 'post',
  path: '/contacts/bulk/verify-emails/preview',
  summary: 'Count what verifying the email addresses of many contacts would do',
  group,
  body: previewContactEmailChecksInput,
  response: {
    status: 200,
    description:
      'How many of the selected contacts would be checked, how many keep a current result for free, how many would use a provider credit, and how many are skipped.',
    schema: contactEmailCheckPreview,
  },
});

export const contactBulkEndpoints = [
  bulkUpdateContacts,
  previewContactEmailChecks,
  listContactBulkActions,
  getContactBulkAction,
  cancelContactBulkAction,
  listContactBulkActionItems,
  createContactExportLink,
] as const;
