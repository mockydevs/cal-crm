// Settings → Custom Fields: the folders an object's fields are grouped in, and the paged
// list of fields the page shows. The limits match crm.field_folders and
// crm.field_definitions.
import { actorKinds } from '@repo/kernel';
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { fieldChoiceDisplays, fieldDefinition, fieldValueTypes } from './fields.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const FIELD_FOLDER_LIMITS = {
  /** Folders one object may have, its system folder included. */
  perObject: 100,
  /** Fields one request may move. */
  move: 100,
  /** The most fields a page of the list holds. */
  page: 100,
  /** The most fields one folder's order may name. */
  order: 1000,
} as const;

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const objectKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, {
  error: 'Use a lowercase letter, then lowercase letters, numbers or underscores.',
});
const folderName = z
  .string()
  .trim()
  .min(1, { error: 'Give the folder a name.' })
  .max(80, { error: 'Use at most 80 characters.' });
const distinct = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

export const createFieldFolderInput = z
  .strictObject({ objectKey, name: folderName })
  .meta({ id: 'CreateFieldFolderInput' });
export const renameFieldFolderInput = z.strictObject({ name: folderName, revision }).meta({
  id: 'RenameFieldFolderInput',
  description:
    'The new name, with the revision the folder was read at. A stale revision returns 409 and changes nothing. A system folder is never renamed.',
});
export const reorderFieldFoldersInput = z
  .strictObject({
    objectKey,
    folderIds: z
      .array(publicId('field_folder'))
      .min(1)
      .max(FIELD_FOLDER_LIMITS.perObject)
      .refine(distinct, { error: 'Name each folder once.' }),
  })
  .meta({
    id: 'ReorderFieldFoldersInput',
    description:
      "Every folder of the object, in the new order. A list that isn't exactly the object's folders returns 409 and changes nothing, so an order made from an old list is never applied.",
  });
export const reorderFolderFieldsInput = z
  .strictObject({
    fieldIds: z
      .array(publicId('field'))
      .min(1)
      .max(FIELD_FOLDER_LIMITS.order)
      .refine(distinct, { error: 'Name each field once.' }),
  })
  .meta({
    id: 'ReorderFolderFieldsInput',
    description:
      "Every field of the folder that is not archived, in the new order. A list that isn't exactly those returns 409 and changes nothing, so an order made from an old list is never applied.",
  });
export const moveFieldsInput = z
  .strictObject({
    fieldIds: z
      .array(publicId('field'))
      .min(1, { error: 'Choose at least one field.' })
      .max(FIELD_FOLDER_LIMITS.move)
      .refine(distinct, { error: 'Name each field once.' }),
  })
  .meta({ id: 'MoveFieldsInput' });

export const fieldFolder = z
  .looseObject({
    id: publicId('field_folder'),
    objectKey,
    name: z.string(),
    system: z.boolean().meta({
      description:
        'The folder every object has from the start. It holds fields nobody put elsewhere, and cannot be renamed or deleted.',
    }),
    position: z.int().meta({ description: 'Where it comes among its object’s folders, from 0.' }),
    fieldCount: z.int().meta({ description: 'Its fields that are not archived.' }),
    createdAt: timestamp,
    revision,
  })
  .meta({ id: 'FieldFolder' });
export type FieldFolder = z.output<typeof fieldFolder>;
export const fieldFolderList = z
  .looseObject({
    items: z.array(fieldFolder),
    canManage: z.boolean(),
    // Every answer of this server carries the two below. They are optional here only so
    // that an answer saved before they existed still reads.
    total: z
      .int()
      .optional()
      .meta({ description: 'How many folders match the filters, on every page.' }),
    next: publicId('field_folder').nullable().optional().meta({
      description:
        'Pass it as after to read the next page. Null on the last page, and always when no limit was asked for.',
    }),
  })
  .meta({ id: 'FieldFolderList' });
export type FieldFolderList = z.output<typeof fieldFolderList>;

/**
 * The orders the field list comes in: by creation, or by each field's place in its folder
 * (object by object, folders in their own order), which is the order a record shows them in.
 */
export const customFieldSorts = ['created_desc', 'created_asc', 'position'] as const;

export const listCustomFieldsQuery = z
  .strictObject({
    objectKey: objectKey.optional().meta({ description: 'Only fields of this object.' }),
    valueType: z.enum(fieldValueTypes).optional(),
    display: z.enum(fieldChoiceDisplays).optional().meta({
      description:
        'Only choice fields shown this way: with valueType, tells a radio field from a dropdown.',
    }),
    folderId: publicId('field_folder').optional(),
    source: z
      .enum(actorKinds)
      .optional()
      .meta({ description: 'Only fields created by this kind of actor.' }),
    createdFrom: timestamp.optional().meta({ description: 'Created at or after this moment.' }),
    createdBefore: timestamp.optional().meta({ description: 'Created before this moment.' }),
    q: z
      .string()
      .trim()
      .max(200, { error: 'Use at most 200 characters.' })
      .optional()
      .meta({ description: 'Finds fields by any part of their name or key.' }),
    archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
    sort: z.enum(customFieldSorts).default('created_desc'),
    limit: z.coerce.number().int().min(1).max(FIELD_FOLDER_LIMITS.page).default(20),
    after: publicId('field')
      .optional()
      .meta({ description: "Start after this field: the previous page's next." }),
  })
  .meta({ id: 'ListCustomFieldsQuery' });
export type ListCustomFieldsQuery = z.output<typeof listCustomFieldsQuery>;

/** A field as the Custom Fields list shows it: with its folder, merge key and origin. */
export const customField = fieldDefinition
  .extend({
    folderId: publicId('field_folder'),
    folderName: z.string(),
    placeholder: z.string(),
    mergeKey: z.string().nullable(),
    createdAt: timestamp,
    source: z.enum(actorKinds),
    // Optional only so that an answer saved before they existed still reads.
    system: z.boolean().optional(),
    position: z.int().optional(),
  })
  .meta({ id: 'CustomField' });
export type CustomField = z.output<typeof customField>;

export const customFieldList = z
  .looseObject({
    items: z.array(customField),
    total: z.int().meta({ description: 'How many fields match the filters, on every page.' }),
    next: publicId('field')
      .nullable()
      .meta({ description: 'Pass it as after to read the next page. Null on the last page.' }),
    objects: z
      .array(
        z.looseObject({
          key: objectKey,
          label: z.string(),
          fields: z.int().meta({ description: 'Its fields that are not archived.' }),
          folders: z.int(),
        }),
      )
      .meta({ description: 'Every object, whatever the filters, for the cards and counts.' }),
    canManage: z.boolean(),
  })
  .meta({ id: 'CustomFieldList' });
export type CustomFieldList = z.output<typeof customFieldList>;

/** The folder a reorder was made in, and its fields that are not archived, in their order. */
export const folderFieldOrder = z
  .looseObject({ folder: fieldFolder, fieldIds: z.array(publicId('field')) })
  .meta({ id: 'FolderFieldOrder' });
export type FolderFieldOrder = z.output<typeof folderFieldOrder>;

export const listFieldFoldersQuery = z
  .strictObject({
    objectKey: objectKey.optional().meta({ description: 'Only folders of this object.' }),
    q: z
      .string()
      .trim()
      .max(200, { error: 'Use at most 200 characters.' })
      .optional()
      .meta({ description: 'Finds folders by any part of their name.' }),
    createdFrom: timestamp.optional().meta({ description: 'Created at or after this moment.' }),
    createdBefore: timestamp.optional().meta({ description: 'Created before this moment.' }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(FIELD_FOLDER_LIMITS.page)
      .optional()
      .meta({ description: 'How many folders a page holds. Left out, every match is answered.' }),
    after: publicId('field_folder')
      .optional()
      .meta({ description: "Start after this folder: the previous page's next." }),
  })
  .meta({ id: 'ListFieldFoldersQuery' });
export type ListFieldFoldersQuery = z.output<typeof listFieldFoldersQuery>;

const group = 'Fields';
const folderParams = z.strictObject({ folderId: publicId('field_folder') });

export const listCustomFields = defineEndpoint({
  operationId: 'listCustomFields',
  method: 'get',
  path: '/custom-fields',
  group,
  summary: 'Read fields a page at a time, filtered, with counts for each object',
  query: listCustomFieldsQuery,
  response: {
    status: 200,
    description: 'A page of fields, how many match, and each object’s counts.',
    schema: customFieldList,
  },
});
export const listFieldFolders = defineEndpoint({
  operationId: 'listFieldFolders',
  method: 'get',
  path: '/field-folders',
  group,
  summary: 'Read field folders in their order, with the number of fields in each',
  query: listFieldFoldersQuery,
  response: {
    status: 200,
    description: 'The folders, by object and then by position.',
    schema: fieldFolderList,
  },
});
export const createFieldFolder = defineEndpoint({
  operationId: 'createFieldFolder',
  method: 'post',
  path: '/field-folders',
  group,
  summary: 'Create a folder for an object’s fields',
  body: createFieldFolderInput,
  response: {
    status: 201,
    description: 'The new folder, last in its object.',
    schema: fieldFolder,
  },
});
export const reorderFieldFolders = defineEndpoint({
  operationId: 'reorderFieldFolders',
  method: 'put',
  path: '/field-folders/order',
  group,
  summary: 'Put an object’s folders in a new order',
  body: reorderFieldFoldersInput,
  response: {
    status: 200,
    description: 'The object’s folders in their new order.',
    schema: fieldFolderList,
  },
});
export const renameFieldFolder = defineEndpoint({
  operationId: 'renameFieldFolder',
  method: 'put',
  path: '/field-folders/{folderId}',
  group,
  summary: 'Rename a field folder without overwriting another edit',
  params: folderParams,
  body: renameFieldFolderInput,
  response: {
    status: 200,
    description: 'The renamed folder and its revision.',
    schema: fieldFolder,
  },
});
export const deleteFieldFolder = defineEndpoint({
  operationId: 'deleteFieldFolder',
  method: 'delete',
  path: '/field-folders/{folderId}',
  group,
  summary: 'Delete a field folder, moving its fields to the object’s system folder',
  params: folderParams,
  response: {
    status: 204,
    description: 'The folder is gone. Its fields, and their values, are in the system folder.',
  },
});
export const reorderFolderFields = defineEndpoint({
  operationId: 'reorderFolderFields',
  method: 'put',
  path: '/field-folders/{folderId}/fields/order',
  group,
  summary: 'Put the fields of a folder in a new order',
  params: folderParams,
  body: reorderFolderFieldsInput,
  response: {
    status: 200,
    description: 'The folder and its fields in their new order.',
    schema: folderFieldOrder,
  },
});
export const moveFieldsToFolder = defineEndpoint({
  operationId: 'moveFieldsToFolder',
  method: 'post',
  path: '/field-folders/{folderId}/fields',
  group,
  summary: 'Move fields into a folder of their own object, all or none',
  params: folderParams,
  body: moveFieldsInput,
  response: {
    status: 200,
    description: 'The folder, with its new number of fields.',
    schema: fieldFolder,
  },
});

/** Every endpoint behind Settings → Custom Fields that this file adds. */
export const fieldFolderEndpoints = [
  listCustomFields,
  listFieldFolders,
  createFieldFolder,
  reorderFieldFolders,
  renameFieldFolder,
  deleteFieldFolder,
  moveFieldsToFolder,
  reorderFolderFields,
] as const;
