import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { messageTemplate } from './message-templates.js';
import { timestamp } from './timestamps.js';

/** CRM library limits: bound tree reads and ancestry work, including moved subtrees. */
export const MESSAGE_TEMPLATE_FOLDER_LIMIT = 500;
export const MESSAGE_TEMPLATE_FOLDER_MAX_DEPTH = 5;

// Messaging owns the library tree; template IDs and content survive placement changes.
const folderId = publicId('template_folder');
const name = z.string().trim().min(1).max(120);
const revision = z.int().min(1);

export const messageTemplateFolder = z
  .looseObject({
    id: folderId,
    parentId: folderId.nullable(),
    name: z.string(),
    revision,
    templateCount: z.int().min(0),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'MessageTemplateFolder' });
export type MessageTemplateFolder = z.output<typeof messageTemplateFolder>;

export const messageTemplateFolderList = z
  .looseObject({
    canManage: z.boolean(),
    items: z.array(messageTemplateFolder).max(MESSAGE_TEMPLATE_FOLDER_LIMIT),
    counts: z
      .looseObject({
        all: z.int().min(0).meta({ description: 'Live templates: not archived.' }),
        unfiled: z.int().min(0).meta({ description: 'Live templates in no folder.' }),
        archived: z.int().min(0).meta({ description: 'Archived templates not in the trash.' }),
        deleted: z.int().min(0).meta({ description: 'Templates in the trash.' }),
      })
      .optional()
      .meta({ description: 'How many templates each view of the library holds.' }),
  })
  .meta({ id: 'MessageTemplateFolderList' });
export type MessageTemplateFolderList = z.output<typeof messageTemplateFolderList>;

export const messageTemplateFolderDetail = z
  .looseObject({
    folder: messageTemplateFolder,
    breadcrumbs: z.array(messageTemplateFolder).min(1).max(MESSAGE_TEMPLATE_FOLDER_MAX_DEPTH),
  })
  .meta({ id: 'MessageTemplateFolderDetail' });
export type MessageTemplateFolderDetail = z.output<typeof messageTemplateFolderDetail>;

export const createMessageTemplateFolderInput = z
  .strictObject({ name, parentId: folderId.nullable().default(null) })
  .meta({ id: 'CreateMessageTemplateFolderInput' });

export const updateMessageTemplateFolderInput = z
  .strictObject({ revision, name: name.optional(), parentId: folderId.nullable().optional() })
  .refine((input) => input.name !== undefined || input.parentId !== undefined, {
    error: 'Give a new name or destination folder.',
  })
  .meta({ id: 'UpdateMessageTemplateFolderInput' });

export const messageTemplateFolderRevisionInput = z
  .strictObject({ revision })
  .meta({ id: 'MessageTemplateFolderRevisionInput' });

export const moveMessageTemplateInput = z
  .strictObject({ revision: z.string().regex(/^[0-9a-f]{64}$/), folderId: folderId.nullable() })
  .meta({
    id: 'MoveMessageTemplateInput',
    description:
      'Move the same template, without changing its ID or content. A stale revision refuses the move.',
  });

const folderParams = z.strictObject({ id: folderId });
export const listMessageTemplateFolders = defineEndpoint({
  operationId: 'listMessageTemplateFolders',
  method: 'get',
  path: '/message-template-folders',
  summary: 'Read the bounded message template folder tree',
  group: 'Message templates',
  response: {
    status: 200,
    description: 'Folders with direct live template counts and authoring permission.',
    schema: messageTemplateFolderList,
  },
});
export const getMessageTemplateFolder = defineEndpoint({
  operationId: 'getMessageTemplateFolder',
  method: 'get',
  path: '/message-template-folders/{id}',
  summary: 'Read a template folder and its ordered breadcrumbs',
  group: 'Message templates',
  params: folderParams,
  response: {
    status: 200,
    description: 'The folder and root-to-current breadcrumbs within this business.',
    schema: messageTemplateFolderDetail,
  },
});
export const createMessageTemplateFolder = defineEndpoint({
  operationId: 'createMessageTemplateFolder',
  method: 'post',
  path: '/message-template-folders',
  summary: 'Create a message template folder',
  group: 'Message templates',
  body: createMessageTemplateFolderInput,
  response: {
    status: 201,
    description: 'The folder in its initial revision.',
    schema: messageTemplateFolder,
  },
});
export const updateMessageTemplateFolder = defineEndpoint({
  operationId: 'updateMessageTemplateFolder',
  method: 'patch',
  path: '/message-template-folders/{id}',
  summary: 'Rename or move a message template folder',
  group: 'Message templates',
  params: folderParams,
  body: updateMessageTemplateFolderInput,
  response: {
    status: 200,
    description:
      'The folder after a revision-checked change; cycles and excessive subtree depth are refused.',
    schema: messageTemplateFolder,
  },
});
export const removeMessageTemplateFolder = defineEndpoint({
  operationId: 'removeMessageTemplateFolder',
  method: 'delete',
  path: '/message-template-folders/{id}',
  summary: 'Remove a folder and relocate its contents without deleting templates',
  group: 'Message templates',
  params: folderParams,
  body: messageTemplateFolderRevisionInput,
  response: {
    status: 204,
    description:
      'Direct assets and child folders have moved to the parent atomically. A destination collision changes nothing.',
  },
});
export const moveMessageTemplate = defineEndpoint({
  operationId: 'moveMessageTemplate',
  method: 'put',
  path: '/message-templates/{id}/folder',
  summary: 'Move a message template without changing its content or workflow links',
  group: 'Message templates',
  params: z.strictObject({ id: publicId('template') }),
  body: moveMessageTemplateInput,
  response: {
    status: 200,
    description: 'The same template in its new folder and revision.',
    schema: messageTemplate,
  },
});
export const messageTemplateFolderEndpoints = [
  listMessageTemplateFolders,
  getMessageTemplateFolder,
  createMessageTemplateFolder,
  updateMessageTemplateFolder,
  removeMessageTemplateFolder,
  moveMessageTemplate,
] as const;
