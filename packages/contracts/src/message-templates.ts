// Message templates: reusable emails that automations send by id or name. Merge fields such
// as {{contact.firstName}} are filled in when sent. A template is plain text, or formatted
// text (HTML the server cleans when it is saved) with a plain-text part beside it. A merge
// value that's missing, or that would break the subject onto a second line (where it could
// start a header), stops the send rather than being blanked or rewritten.
import * as z from 'zod';

import type { ConditionValue, ConditionValues } from './automations-evaluate.js';
import {
  EMAIL_CONTENT_LIMITS,
  emailContent,
  emailPreheader,
  storedEmailContent,
  type EmailContent,
} from './email-content.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { messageTemplateRevision as templateRevision } from './message-template-revision.js';
import { timestamp } from './timestamps.js';

const templateName = z.string().trim().min(1, { error: 'Give the template a name.' }).max(120);

export const messageTemplateInput = z
  .strictObject({
    name: templateName,
    subject: z
      .string()
      .trim()
      .min(1, { error: 'Give the email a subject.' })
      .max(255)
      .regex(/^[^\r\n]*$/, { error: 'Keep the subject on one line.' }),
    body: z.string().min(1, { error: 'Write the message.' }).max(100_000).optional().meta({
      description:
        'The message as plain text. Give this or content, not both; one of them is required.',
    }),
    content: emailContent.optional().meta({
      description:
        'The message as plain text or as formatted text. Give this or body, not both; one of them is required.',
    }),
    preheader: emailPreheader.nullable().optional(),
  })
  .meta({ id: 'MessageTemplateInput' });

export type MessageTemplateInput = z.output<typeof messageTemplateInput>;

/** What rendering needs: a template's subject and body. */
export interface RenderableTemplate {
  readonly subject: string;
  readonly body: string;
}

export type RenderedTemplate =
  | { readonly ok: true; readonly subject: string; readonly body: string }
  | {
      readonly ok: false;
      /** missing_values: no value to fill in; subject_line_break: a value has a line break. */
      readonly code: 'missing_values' | 'subject_line_break';
      readonly fields: readonly string[];
    };

// A merge field is a dotted path; anything else in braces is left as written. It may name
// what to write when the record has no value, as Liquid writes it: {{contact.firstName |
// default: "there"}}. The fallback is plain words: no quote, brace, angle bracket,
// ampersand or line break, so it is the same text in a subject, a plain-text body and HTML,
// and it can never become markup or a second header line.
const MERGE_TOKEN =
  /\{\{\s*([a-z][a-z_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)(?:\s*\|\s*default\s*:\s*"([^"{}<>&\r\n]{0,100})")?\s*\}\}/g;

const tokensIn = (text: string): string[] =>
  [...text.matchAll(MERGE_TOKEN)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

/** The fields a text uses at least once with no fallback: those a send needs a value for. */
const requiredTokensIn = (text: string): string[] =>
  [...text.matchAll(MERGE_TOKEN)].flatMap((match) =>
    match[1] === undefined || match[2] !== undefined ? [] : [match[1]],
  );

// Text for a value, or undefined when there's nothing to say: no value, or only blanks.
function textOf(value: ConditionValue | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  return text.trim() === '' ? undefined : text;
}

/**
 * The fields a template uses, each once, in the order they first appear: in its subject,
 * its text, and its formatted part and preview text when it has them.
 */
export function mergeTokens(
  template: RenderableTemplate & {
    readonly html?: string | null | undefined;
    readonly preheader?: string | null | undefined;
  },
): string[] {
  return [
    ...new Set([
      ...tokensIn(template.subject),
      ...tokensIn(template.preheader ?? ''),
      ...tokensIn(template.body),
      ...tokensIn(template.html ?? ''),
    ]),
  ];
}

/**
 * The fields a template uses with no fallback, each once, in the order mergeTokens gives:
 * a record with no value for one of them can't be sent the template.
 */
export function requiredMergeTokens(
  template: RenderableTemplate & {
    readonly html?: string | null | undefined;
    readonly preheader?: string | null | undefined;
  },
): string[] {
  const required = new Set([
    ...requiredTokensIn(template.subject),
    ...requiredTokensIn(template.preheader ?? ''),
    ...requiredTokensIn(template.body),
    ...requiredTokensIn(template.html ?? ''),
  ]);
  return mergeTokens(template).filter((field) => required.has(field));
}

/** A template filled in for one record, or why it can't be sent as written. */
export function renderMessageTemplate(
  template: RenderableTemplate,
  values: ConditionValues,
): RenderedTemplate {
  const fields = requiredMergeTokens(template);
  const missing = fields.filter((field) => textOf(values[field]) === undefined);
  if (missing.length > 0) return { ok: false, code: 'missing_values', fields: missing };
  const broken = tokensIn(template.subject).filter((field) =>
    /[\r\n]/.test(textOf(values[field]) ?? ''),
  );
  if (broken.length > 0)
    return { ok: false, code: 'subject_line_break', fields: [...new Set(broken)] };
  const fill = (text: string) =>
    text.replace(
      MERGE_TOKEN,
      (_token, path: string, fallback: string | undefined) =>
        textOf(values[path]) ?? fallback ?? '',
    );
  return { ok: true, subject: fill(template.subject), body: fill(template.body) };
}

// Authoring: people and API clients create, edit, duplicate, archive, delete and restore
// templates. A delete moves a template to the trash, never out of the database, since
// automations name it by id: a template in the trash is archived too, which frees its name
// and stops automations sending it, and it can be restored. A template a published
// workflow sends can't be deleted until that workflow stops sending it.

/**
 * The contact fields a send can fill in, as automations read them (the automation
 * module's contactValues). A business's own fields follow as contact.custom.<key>.
 */
export const contactMergeFields = [
  'contact.firstName',
  'contact.lastName',
  'contact.name',
  'contact.email',
  'contact.phone',
  'contact.tags',
  'contact.source',
  'contact.type',
  'contact.createdAt',
  'contact.updatedAt',
  // What email verification found of the primary address, and whether it is verified.
  'contact.emailVerification',
  'contact.emailVerified',
] as const;

export const updateMessageTemplateInput = messageTemplateInput
  .extend({ revision: templateRevision })
  .meta({
    id: 'UpdateMessageTemplateInput',
    description:
      'The whole template, with the revision it was read at. A stale revision returns 409 and changes nothing.',
  });
export type UpdateMessageTemplateInput = z.output<typeof updateMessageTemplateInput>;

export const messageTemplateRevisionInput = z
  .strictObject({ revision: templateRevision })
  .meta({ id: 'MessageTemplateRevisionInput' });

const templateFields = {
  id: publicId('template'),
  name: z.string(),
  subject: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable(),
  deletedAt: timestamp.nullable().optional().meta({
    description:
      'When it was moved to the trash. Null or absent when it is not in the trash. A template in the trash is archived too.',
  }),
  revision: templateRevision,
};

/** A template in a list: without its body, which can be long, and what the body uses. */
export const messageTemplateSummary = z
  .looseObject({
    ...templateFields,
    format: z.enum(['text', 'html']).meta({
      description: 'html when the template holds formatted text beside its plain-text part.',
    }),
    preheader: z.string().nullable(),
    folder: z
      .looseObject({
        id: publicId('template_folder'),
        name: z.string(),
        path: z.array(z.string()).meta({
          description: 'The names of the folders it is in, outermost first, ending with its own.',
        }),
      })
      .nullable()
      .meta({ description: 'The folder the template is filed in; null when it is unfiled.' }),
    preview: z.string().meta({
      description: 'The start of the plain-text part on one line, at most 140 characters.',
    }),
    workflowUses: z.int().min(0).nullable().optional().meta({
      description:
        'How many workflows have a Send email step that uses this template, in their draft or their running version: the workflows listTemplateWorkflowActions lists. Archived workflows are not counted. Null when this server cannot tell.',
    }),
  })
  .meta({ id: 'MessageTemplateSummary' });
export type MessageTemplateSummary = z.output<typeof messageTemplateSummary>;

export const messageTemplateUse = z
  .looseObject({
    id: publicId('automation'),
    name: z.string(),
    status: z.enum(['active', 'paused']),
    runsInProgress: z.literal(true).optional().meta({
      description:
        'Present when only runs that began on an earlier version still send it: the version it runs now does not.',
    }),
  })
  .meta({ id: 'MessageTemplateUse' });
export type MessageTemplateUse = z.output<typeof messageTemplateUse>;

export const messageTemplate = z
  .looseObject({
    ...messageTemplateSummary.shape,
    body: z.string().meta({ description: 'The plain-text part.' }),
    content: storedEmailContent,
    mergeFields: z.array(z.string()).meta({
      description:
        'The merge fields the subject and body use, each once, in the order they appear.',
    }),
    unfillableFields: z.array(z.string()).nullable().meta({
      description:
        'The merge fields it uses that no send can fill in: not a built-in contact field, a live custom contact field of this business (by its merge key or as contact.custom.<key>), or one of its custom values that has text. A send stops at one, so nobody would get the email. Null when this server cannot tell.',
    }),
    canManage: z.boolean(),
    usedBy: z.array(messageTemplateUse).nullable().meta({
      description:
        'The active and paused automations that send this template: their published version does, or runs that began on an earlier one still will. They send its current text, and while any do it can be neither archived nor deleted. Null when this server cannot tell.',
    }),
  })
  .meta({ id: 'MessageTemplate' });
export type MessageTemplate = z.output<typeof messageTemplate>;

export const messageTemplateList = z
  .looseObject({
    canManage: z.boolean(),
    items: z.array(messageTemplateSummary),
    nextCursor: publicId('template').nullable(),
    total: z.int().min(0).optional().meta({
      description:
        'How many templates match the folder, the search and the other filters, on every page together.',
    }),
  })
  .meta({ id: 'MessageTemplateList' });
export type MessageTemplateList = z.output<typeof messageTemplateList>;

const sampleValue = z.union([
  z.string().max(10_000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(10_000), z.number()])).max(100),
]);
export const previewMessageTemplateInput = z
  .strictObject({
    // As written: a preview shows the text being typed, before a save trims it.
    subject: z
      .string()
      .max(255)
      .regex(/^[^\r\n]*$/, { error: 'Keep the subject on one line.' }),
    body: z.string().max(100_000),
    values: z
      .record(z.string().max(200), sampleValue)
      .refine((values) => Object.keys(values).length <= 200, {
        error: 'Give at most 200 sample values.',
      })
      .default({}),
  })
  .meta({
    id: 'PreviewMessageTemplateInput',
    description:
      'Unsaved text and sample values by merge field, such as {"contact.firstName": "Ada"}.',
  });

export const messageTemplatePreview = z
  .discriminatedUnion('ok', [
    z.looseObject({ ok: z.literal(true), subject: z.string(), body: z.string() }),
    z.looseObject({
      ok: z.literal(false),
      code: z.enum(['missing_values', 'subject_line_break']),
      fields: z.array(z.string()),
    }),
  ])
  .meta({ id: 'MessageTemplatePreview' });
export type MessageTemplatePreview = z.output<typeof messageTemplatePreview>;

/**
 * A template as a send would fill it in from these values, or exactly why a send would
 * stop: the same rendering, so a preview never shows a blank where a send would refuse.
 */
export function previewMessageTemplate(
  template: RenderableTemplate,
  values: ConditionValues,
): MessageTemplatePreview {
  const rendered = renderMessageTemplate(template, values);
  return rendered.ok ? rendered : { ok: false, code: rendered.code, fields: [...rendered.fields] };
}

const templateParams = z.object({ id: publicId('template') });

export const listMessageTemplates = defineEndpoint({
  operationId: 'listMessageTemplates',
  method: 'get',
  path: '/message-templates',
  summary: 'Read message templates by name',
  group: 'Message templates',
  query: z.strictObject({
    archived: z.enum(['exclude', 'include', 'only']).default('exclude').meta({
      description:
        'Whether archived templates are listed: left out, beside the live ones, or alone. Templates in the trash are never listed here.',
    }),
    deleted: z.enum(['exclude', 'only']).default('exclude').meta({
      description: 'only: the templates in the trash, and archived is then ignored.',
    }),
    format: z.enum(['text', 'html']).optional().meta({
      description: 'Only plain-text templates, or only formatted ones.',
    }),
    used: z.enum(['yes', 'no']).optional().meta({
      description:
        'Only the templates some workflow uses, or only those none does: the count workflowUses gives.',
    }),
    sort: z.enum(['name', 'updated', 'uses']).default('name').meta({
      description:
        'name: A to Z. updated: last changed first. uses: used by the most workflows first, then by name.',
    }),
    after: publicId('template').optional().meta({
      description: "Start after this template: the previous page's nextCursor.",
    }),
    folder: z
      .union([z.literal('root'), publicId('template_folder')])
      .optional()
      .meta({
        description:
          'Omit for the whole library; root means unfiled templates; otherwise direct assets of this folder.',
      }),
    q: z.string().trim().max(120).optional().meta({
      description:
        'Literal case-insensitive search of template names and subjects within the selected scope.',
    }),
    limit: z.coerce.number().int().min(1).max(100).optional().meta({
      description: 'How many to answer with. Left out, 50.',
    }),
  }),
  response: {
    status: 200,
    description:
      'Up to limit templates in the order asked, without their bodies: each with its folder, format and the start of its text, for a list or a picker.',
    schema: messageTemplateList,
  },
});
export const getMessageTemplate = defineEndpoint({
  operationId: 'getMessageTemplate',
  method: 'get',
  path: '/message-templates/{id}',
  summary: 'Read one message template',
  group: 'Message templates',
  params: templateParams,
  response: {
    status: 200,
    description: 'The template, its revision and the automations that send it.',
    schema: messageTemplate,
  },
});
export const createMessageTemplate = defineEndpoint({
  operationId: 'createMessageTemplate',
  method: 'post',
  path: '/message-templates',
  summary: 'Create a message template',
  group: 'Message templates',
  body: messageTemplateInput
    .extend({ folderId: publicId('template_folder').nullable().optional() })
    .meta({ id: 'CreateMessageTemplateInput' }),
  response: {
    status: 201,
    description: 'The saved template with its revision.',
    schema: messageTemplate,
  },
});
export const updateMessageTemplate = defineEndpoint({
  operationId: 'updateMessageTemplate',
  method: 'put',
  path: '/message-templates/{id}',
  summary: 'Edit a message template without overwriting another edit',
  group: 'Message templates',
  params: templateParams,
  body: updateMessageTemplateInput,
  response: { status: 200, description: 'The saved template.', schema: messageTemplate },
});
export const archiveMessageTemplate = defineEndpoint({
  operationId: 'archiveMessageTemplate',
  method: 'post',
  path: '/message-templates/{id}/archive',
  summary: 'Archive a message template, freeing its name',
  group: 'Message templates',
  params: templateParams,
  body: messageTemplateRevisionInput,
  response: {
    status: 200,
    description:
      'The archived template, its name free. Refused with 409 while an active or paused workflow sends it, or runs still in progress will: those sends would fail.',
    schema: messageTemplate,
  },
});
export const restoreMessageTemplate = defineEndpoint({
  operationId: 'restoreMessageTemplate',
  method: 'post',
  path: '/message-templates/{id}/restore',
  summary: 'Restore an archived message template, or one in the trash',
  group: 'Message templates',
  params: templateParams,
  body: messageTemplateRevisionInput,
  response: {
    status: 200,
    description:
      'The template, live again. Refused while a live template has its name: rename that one first.',
    schema: messageTemplate,
  },
});
export const deleteMessageTemplate = defineEndpoint({
  operationId: 'deleteMessageTemplate',
  method: 'delete',
  path: '/message-templates/{id}',
  summary: 'Move a message template to the trash',
  group: 'Message templates',
  params: templateParams,
  body: messageTemplateRevisionInput,
  response: {
    status: 200,
    description:
      'The template in the trash: archived, its name free, and restorable. Refused with 409 while an active or paused workflow sends it. One already in the trash is answered as it is.',
    schema: messageTemplate,
  },
});
export const duplicateMessageTemplateInput = z
  .strictObject({
    name: templateName.optional().meta({
      description:
        'The name of the copy. Left out, "Copy of" and the name, numbered (2), (3) and on when that is taken.',
    }),
  })
  .meta({ id: 'DuplicateMessageTemplateInput' });
export const duplicateMessageTemplate = defineEndpoint({
  operationId: 'duplicateMessageTemplate',
  method: 'post',
  path: '/message-templates/{id}/duplicate',
  summary: 'Copy a message template',
  group: 'Message templates',
  params: templateParams,
  body: duplicateMessageTemplateInput,
  response: {
    status: 201,
    description:
      'A new live template with the same subject, text, preview text and folder. A template in the trash is refused with 409: restore it first.',
    schema: messageTemplate,
  },
});

/** The most templates one bulk request names. A larger selection is sent in several. */
export const MESSAGE_TEMPLATE_BULK_LIMIT = 100;
export const messageTemplateBulkActions = ['move', 'archive', 'delete', 'restore'] as const;
/** Why a template of a bulk request was left as it was. */
export const messageTemplateBulkSkipCodes = [
  'not_found',
  'in_use',
  'in_trash',
  'name_taken',
] as const;
export type MessageTemplateBulkSkipCode = (typeof messageTemplateBulkSkipCodes)[number];

const bulkIds = z
  .array(publicId('template'))
  .min(1, { error: 'Select at least one template.' })
  .max(MESSAGE_TEMPLATE_BULK_LIMIT, {
    error: `Select at most ${String(MESSAGE_TEMPLATE_BULK_LIMIT)} templates at a time.`,
  })
  .refine((items) => new Set(items).size === items.length, {
    error: 'Name each template once.',
    params: { code: 'repeated' },
  });

export const bulkMessageTemplatesInput = z
  .discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('move'),
      ids: bulkIds,
      folderId: publicId('template_folder')
        .nullable()
        .meta({ description: 'The folder to file them in; null to unfile them.' }),
    }),
    z.strictObject({ action: z.literal('archive'), ids: bulkIds }),
    z.strictObject({ action: z.literal('delete'), ids: bulkIds }),
    z.strictObject({ action: z.literal('restore'), ids: bulkIds }),
  ])
  .meta({ id: 'BulkMessageTemplatesInput' });
export type BulkMessageTemplatesInput = z.output<typeof bulkMessageTemplatesInput>;

export const bulkMessageTemplatesResult = z
  .looseObject({
    action: z.enum(messageTemplateBulkActions),
    results: z
      .array(
        z.looseObject({
          id: publicId('template'),
          outcome: z.enum(['done', 'unchanged', 'skipped']).meta({
            description:
              'done: it was changed. unchanged: it was already as asked, so nothing was written. skipped: it could not be, for the reason given.',
          }),
          reason: z
            .looseObject({
              code: z.enum(messageTemplateBulkSkipCodes).meta({
                description:
                  'not_found: no such template here. in_use: a workflow sends it, so it was not archived or deleted. in_trash: it is in the trash, so it was not moved or archived. name_taken: a live template has its name, so it was not restored.',
              }),
              message: z.string().meta({ description: 'In plain words, for people.' }),
            })
            .nullable(),
        }),
      )
      .meta({ description: 'One entry for each template named, in the order named.' }),
    done: z.int().min(0),
    unchanged: z.int().min(0),
    skipped: z.int().min(0),
  })
  .meta({ id: 'BulkMessageTemplatesResult' });
export type BulkMessageTemplatesResult = z.output<typeof bulkMessageTemplatesResult>;

export const bulkMessageTemplates = defineEndpoint({
  operationId: 'bulkMessageTemplates',
  method: 'post',
  path: '/message-templates/bulk',
  summary: 'Move, archive, delete or restore many message templates at once',
  group: 'Message templates',
  body: bulkMessageTemplatesInput,
  response: {
    status: 200,
    description:
      'What became of each template. All that can be changed are, in one step; one that cannot is skipped with its reason and never stops the others. Sending the same request again changes nothing and answers unchanged.',
    schema: bulkMessageTemplatesResult,
  },
});
export const previewMessageTemplateText = defineEndpoint({
  operationId: 'previewMessageTemplate',
  method: 'post',
  path: '/message-templates/preview',
  summary: 'Fill in unsaved template text with sample values',
  group: 'Message templates',
  body: previewMessageTemplateInput,
  response: {
    status: 200,
    description: 'The filled-in text, or the fields with no value. Nothing is saved or sent.',
    schema: messageTemplatePreview,
  },
});

/**
 * What a template input says its message is: `content`, or the older plain-text `body`.
 * Neither, or both, is refused where the input is used, with this as the reason.
 */
export function templateContentOf(input: {
  readonly body?: string | undefined;
  readonly content?: EmailContent | undefined;
}): EmailContent | { readonly code: 'content_required' | 'content_twice' } {
  if (input.content !== undefined)
    return input.body === undefined ? input.content : { code: 'content_twice' };
  return input.body === undefined
    ? { code: 'content_required' }
    : { format: 'text', text: input.body };
}

/** The start of a text on one line, as a picker shows it beside a template's name. */
export function emailPreviewLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= EMAIL_CONTENT_LIMITS.preview
    ? line
    : `${line.slice(0, EMAIL_CONTENT_LIMITS.preview - 1).trimEnd()}…`;
}

// A rendered preview: a saved template or unsaved content, filled in for a real contact or
// from sample values, as a workflow would send it. Nothing is saved or sent.
export const renderEmailPreviewInput = z
  .strictObject({
    template: publicId('template').optional().meta({
      description: 'A saved template to preview. Give this, or subject and content.',
    }),
    subject: z
      .string()
      .max(998)
      .regex(/^[^\r\n]*$/, { error: 'Keep the subject on one line.' })
      .optional()
      .meta({
        description:
          'Unsaved subject. Beside a template it stands in for the template’s own, as a workflow step’s subject does; empty means the template’s.',
      }),
    content: emailContent.optional(),
    preheader: z
      .string()
      .max(EMAIL_CONTENT_LIMITS.preheader)
      .regex(/^[^\r\n]*$/)
      .optional(),
    contact: publicId('contact').optional().meta({
      description: 'A contact whose own values fill the merge fields. Sample values win over them.',
    }),
    values: z
      .record(z.string().max(200), sampleValue)
      .refine((values) => Object.keys(values).length <= 200, {
        error: 'Give at most 200 sample values.',
      })
      .default({}),
    footer: z.boolean().default(true).meta({
      description:
        'true: with the unsubscribe line and the business’s postal address a workflow email is sent with. false: the content alone.',
    }),
  })
  .meta({ id: 'RenderEmailPreviewInput' });
export type RenderEmailPreviewInput = z.output<typeof renderEmailPreviewInput>;

export const renderedEmailPreview = z
  .looseObject({
    subject: z.string(),
    preheader: z.string().nullable(),
    html: z.string().nullable().meta({
      description:
        'The formatted part, cleaned, with merge values escaped. Null for a plain-text email. Show it in a sandboxed frame.',
    }),
    text: z.string(),
    mergeFields: z.array(z.string()),
    missingFields: z.array(z.string()).meta({
      description:
        'The merge fields with no value here. They are left as written in the preview; a send to this contact would stop at them.',
    }),
    subjectLineBreak: z.array(z.string()).meta({
      description:
        'The subject’s merge fields whose value holds a line break; a send stops at them.',
    }),
  })
  .meta({ id: 'RenderedEmailPreview' });
export type RenderedEmailPreview = z.output<typeof renderedEmailPreview>;

export const renderEmailPreview = defineEndpoint({
  operationId: 'renderEmailPreview',
  method: 'post',
  path: '/message-templates/render',
  summary: 'Preview an email filled in for a contact or sample values',
  group: 'Message templates',
  body: renderEmailPreviewInput,
  response: {
    status: 200,
    description:
      'The subject, preview text, formatted and plain-text parts with merge fields filled in, and the fields left unfilled. Nothing is saved or sent.',
    schema: renderedEmailPreview,
  },
});

/** Every authoring endpoint, for the API's list of operations. */
export const messageTemplateEndpoints = [
  listMessageTemplates,
  getMessageTemplate,
  createMessageTemplate,
  updateMessageTemplate,
  archiveMessageTemplate,
  restoreMessageTemplate,
  deleteMessageTemplate,
  duplicateMessageTemplate,
  bulkMessageTemplates,
  previewMessageTemplateText,
  renderEmailPreview,
] as const;
