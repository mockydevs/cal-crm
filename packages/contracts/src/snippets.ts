// Conversations → Snippets: text a person keeps to insert into a message. A text snippet
// goes into a text message or a chat; an email snippet has a subject too. Snippets are
// plain text, in folders, and are filled in for one contact when a person picks one (merge
// fields as message templates fill them in). The limits match messaging.snippets and
// messaging.snippet_folders.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const SNIPPET_LIMITS = {
  /** Snippets one business may have. */
  snippets: 2000,
  /** Folders one business may have. */
  folders: 100,
  /** Characters in a text snippet: what one text message holds. */
  text: 1600,
  /** Characters in an email snippet's body. */
  email: 100_000,
  /** Snippets one request may move. */
  move: 100,
  /** The most snippets a page of the list holds. */
  page: 100,
  /** Characters of the body a list shows. */
  preview: 200,
} as const;

export const snippetTypes = ['text', 'email'] as const;
export type SnippetType = (typeof snippetTypes)[number];

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const name = z
  .string()
  .trim()
  .min(1, { error: 'Give the snippet a name.' })
  .max(120, { error: 'Use at most 120 characters.' });
const subject = z
  .string()
  .trim()
  .min(1, { error: 'Give the email a subject.' })
  .max(255, { error: 'Use at most 255 characters.' })
  .regex(/^[^\r\n]*$/, { error: 'Keep the subject on one line.' });
// As written: spaces and line breaks inside a message are the author's.
const body = z
  .string()
  .min(1, { error: 'Write the message.' })
  .max(SNIPPET_LIMITS.email, { error: 'Use at most 100,000 characters.' });
const folderName = z
  .string()
  .trim()
  .min(1, { error: 'Give the folder a name.' })
  .max(80, { error: 'Use at most 80 characters.' });
const folderId = publicId('snippet_folder');

interface SnippetText {
  readonly type: SnippetType;
  readonly subject: string | null;
  readonly body: string;
}

// One rule for a create and a save: a subject belongs to an email and to nothing else, and
// a text snippet fits one text message.
function checkText(value: SnippetText, context: z.core.$RefinementCtx): void {
  if (value.type === 'email' && value.subject === null)
    context.addIssue({
      code: 'custom',
      path: ['subject'],
      message: 'Give the email a subject.',
    });
  if (value.type === 'text' && value.subject !== null)
    context.addIssue({
      code: 'custom',
      path: ['subject'],
      message: 'A text snippet has no subject.',
    });
  if (value.type === 'text' && value.body.length > SNIPPET_LIMITS.text)
    context.addIssue({
      code: 'custom',
      path: ['body'],
      message: 'A text snippet holds at most 1,600 characters.',
    });
}

export const createSnippetInput = z
  .strictObject({
    type: z.enum(snippetTypes),
    name,
    subject: subject.nullable().default(null),
    body,
    folderId: folderId.nullable().default(null),
  })
  .superRefine(checkText)
  .meta({ id: 'CreateSnippetInput' });
export type CreateSnippetInput = z.output<typeof createSnippetInput>;

export const updateSnippetInput = z
  .strictObject({
    name,
    subject: subject.nullable(),
    body,
    folderId: folderId.nullable(),
    revision,
  })
  .meta({
    id: 'UpdateSnippetInput',
    description:
      'The whole snippet, with the revision it was read at. Its type is not part of it: a snippet keeps its type. A stale revision returns 409 and changes nothing.',
  });
export type UpdateSnippetInput = z.output<typeof updateSnippetInput>;

/** What a save must hold for a snippet of this type, as issues, or nothing. */
export function snippetTextIssues(
  value: SnippetText,
): { readonly path: string; readonly message: string }[] {
  const checked = z
    .strictObject({ type: z.enum(snippetTypes), subject: z.string().nullable(), body: z.string() })
    .superRefine(checkText)
    .safeParse(value);
  return checked.success
    ? []
    : checked.error.issues.map((issue) => ({
        path: `/${issue.path.join('/')}`,
        message: issue.message,
      }));
}

export const moveSnippetsInput = z
  .strictObject({
    snippetIds: z
      .array(publicId('snippet'))
      .min(1, { error: 'Choose at least one snippet.' })
      .max(SNIPPET_LIMITS.move)
      .refine((ids) => new Set(ids).size === ids.length, { error: 'Name each snippet once.' }),
    folderId: folderId.nullable().meta({ description: 'The folder, or null for no folder.' }),
  })
  .meta({ id: 'MoveSnippetsInput' });

const snippetFields = {
  id: publicId('snippet'),
  type: z.enum(snippetTypes),
  name: z.string(),
  subject: z.string().nullable(),
  folderId: folderId.nullable(),
  folderName: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  revision,
};

/** A snippet in a list: the start of its body, which can be long. */
export const snippetSummary = z
  .looseObject({
    ...snippetFields,
    bodyPreview: z.string().meta({
      description: 'The first 200 characters of the body, on one line.',
    }),
  })
  .meta({ id: 'SnippetSummary' });
export type SnippetSummary = z.output<typeof snippetSummary>;

export const snippet = z
  .looseObject({
    ...snippetFields,
    body: z.string(),
    mergeFields: z.array(z.string()).meta({
      description:
        'The merge fields the subject and body use, each once, in the order they appear.',
    }),
  })
  .meta({ id: 'Snippet' });
export type Snippet = z.output<typeof snippet>;

export const listSnippetsQuery = z
  .strictObject({
    q: z
      .string()
      .trim()
      .max(200, { error: 'Use at most 200 characters.' })
      .optional()
      .meta({ description: 'Finds snippets by any part of their name, subject or body.' }),
    type: z.enum(snippetTypes).optional(),
    folder: z
      .union([folderId, z.literal('none')])
      .optional()
      .meta({
        description: 'Only the snippets in this folder, or "none" for those in no folder.',
      }),
    limit: z.coerce.number().int().min(1).max(SNIPPET_LIMITS.page).default(20),
    after: z
      .string()
      .max(600)
      .optional()
      .meta({ description: 'Start after the previous page: its next, exactly as it was given.' }),
  })
  .meta({ id: 'ListSnippetsQuery' });
export type ListSnippetsQuery = z.output<typeof listSnippetsQuery>;

export const snippetList = z
  .looseObject({
    items: z.array(snippetSummary),
    total: z.int().meta({ description: 'How many snippets match the filters, on every page.' }),
    next: z
      .string()
      .nullable()
      .meta({ description: 'Pass it as after to read the next page. Null on the last page.' }),
    canManage: z.boolean(),
  })
  .meta({ id: 'SnippetList' });
export type SnippetList = z.output<typeof snippetList>;

export const renderSnippetInput = z
  .strictObject({ contactId: publicId('contact') })
  .meta({ id: 'RenderSnippetInput' });

export const renderedSnippet = z
  .discriminatedUnion('ok', [
    z.looseObject({
      ok: z.literal(true),
      type: z.enum(snippetTypes),
      subject: z.string().nullable(),
      body: z.string(),
    }),
    z.looseObject({
      ok: z.literal(false),
      code: z.enum(['missing_values', 'subject_line_break']),
      fields: z.array(z.string()),
    }),
  ])
  .meta({
    id: 'RenderedSnippet',
    description:
      'The snippet filled in for the contact, ready to put in the composer, or the merge fields that have no value for this contact (or whose value would break the subject onto a second line).',
  });
export type RenderedSnippet = z.output<typeof renderedSnippet>;

export const createSnippetFolderInput = z
  .strictObject({ name: folderName })
  .meta({ id: 'CreateSnippetFolderInput' });
export const renameSnippetFolderInput = z
  .strictObject({ name: folderName, revision })
  .meta({ id: 'RenameSnippetFolderInput' });
export const snippetFolder = z
  .looseObject({
    id: folderId,
    name: z.string(),
    snippetCount: z.int(),
    createdAt: timestamp,
    updatedAt: timestamp,
    revision,
  })
  .meta({ id: 'SnippetFolder' });
export type SnippetFolder = z.output<typeof snippetFolder>;
export const snippetFolderList = z
  .looseObject({ items: z.array(snippetFolder), canManage: z.boolean() })
  .meta({ id: 'SnippetFolderList' });
export type SnippetFolderList = z.output<typeof snippetFolderList>;

const group = 'Snippets';
const snippetParams = z.strictObject({ snippetId: publicId('snippet') });
const folderParams = z.strictObject({ folderId });

export const listSnippets = defineEndpoint({
  operationId: 'listSnippets',
  method: 'get',
  path: '/snippets',
  group,
  summary: 'Read snippets by name, a page at a time',
  query: listSnippetsQuery,
  response: {
    status: 200,
    description: 'A page of snippets in name order, and how many match.',
    schema: snippetList,
  },
});
export const getSnippet = defineEndpoint({
  operationId: 'getSnippet',
  method: 'get',
  path: '/snippets/{snippetId}',
  group,
  summary: 'Read one snippet with its whole body',
  params: snippetParams,
  response: { status: 200, description: 'The snippet and its revision.', schema: snippet },
});
export const createSnippet = defineEndpoint({
  operationId: 'createSnippet',
  method: 'post',
  path: '/snippets',
  group,
  summary: 'Create a text or email snippet',
  body: createSnippetInput,
  response: { status: 201, description: 'The new snippet.', schema: snippet },
});
export const moveSnippets = defineEndpoint({
  operationId: 'moveSnippets',
  method: 'post',
  path: '/snippets/move',
  group,
  summary: 'Move snippets into a folder, or out of any folder',
  body: moveSnippetsInput,
  response: {
    status: 200,
    description: 'The snippets, in the order they were named. All move or none does.',
    schema: z.looseObject({ items: z.array(snippetSummary) }).meta({ id: 'MovedSnippets' }),
  },
});
export const updateSnippet = defineEndpoint({
  operationId: 'updateSnippet',
  method: 'put',
  path: '/snippets/{snippetId}',
  group,
  summary: 'Edit a snippet without overwriting another edit',
  params: snippetParams,
  body: updateSnippetInput,
  response: { status: 200, description: 'The saved snippet and its revision.', schema: snippet },
});
export const deleteSnippet = defineEndpoint({
  operationId: 'deleteSnippet',
  method: 'delete',
  path: '/snippets/{snippetId}',
  group,
  summary: 'Delete a snippet for good',
  params: snippetParams,
  response: {
    status: 204,
    description: 'The snippet is gone. Messages it was put into keep their text.',
  },
});
export const renderSnippet = defineEndpoint({
  operationId: 'renderSnippet',
  method: 'post',
  path: '/snippets/{snippetId}/render',
  group,
  summary: 'Fill a snippet in for one contact, for the composer',
  params: snippetParams,
  body: renderSnippetInput,
  response: {
    status: 200,
    description:
      'The filled-in text, or the fields with no value. Nothing is sent. A trigger link in the snippet becomes this contact’s own address for it.',
    schema: renderedSnippet,
  },
});
export const listSnippetFolders = defineEndpoint({
  operationId: 'listSnippetFolders',
  method: 'get',
  path: '/snippet-folders',
  group,
  summary: 'Read the snippet folders, each with how many snippets it holds',
  response: { status: 200, description: 'The folders, by name.', schema: snippetFolderList },
});
export const createSnippetFolder = defineEndpoint({
  operationId: 'createSnippetFolder',
  method: 'post',
  path: '/snippet-folders',
  group,
  summary: 'Create a snippet folder',
  body: createSnippetFolderInput,
  response: { status: 201, description: 'The new folder.', schema: snippetFolder },
});
export const renameSnippetFolder = defineEndpoint({
  operationId: 'renameSnippetFolder',
  method: 'put',
  path: '/snippet-folders/{folderId}',
  group,
  summary: 'Rename a snippet folder',
  params: folderParams,
  body: renameSnippetFolderInput,
  response: { status: 200, description: 'The renamed folder.', schema: snippetFolder },
});
export const deleteSnippetFolder = defineEndpoint({
  operationId: 'deleteSnippetFolder',
  method: 'delete',
  path: '/snippet-folders/{folderId}',
  group,
  summary: 'Delete a snippet folder, keeping its snippets',
  params: folderParams,
  response: {
    status: 204,
    description: 'The folder is gone. Its snippets remain, in no folder.',
  },
});

/** Every snippet endpoint, for the API's list of operations. */
export const snippetEndpoints = [
  listSnippets,
  getSnippet,
  createSnippet,
  moveSnippets,
  updateSnippet,
  deleteSnippet,
  renderSnippet,
  listSnippetFolders,
  createSnippetFolder,
  renameSnippetFolder,
  deleteSnippetFolder,
] as const;
