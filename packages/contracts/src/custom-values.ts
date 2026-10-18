// Settings → Custom Values: text a business writes once and uses in many messages as
// {{custom_values.<key>}}. A value's key is made when it is created and never changes. The
// limits match crm.custom_values and crm.custom_value_folders.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const CUSTOM_VALUE_LIMITS = {
  /** Custom values one business may have. */
  values: 500,
  /** Folders one business may have. */
  folders: 100,
  /** Characters in one value. */
  value: 5000,
  /** Values one request may move. */
  move: 100,
  /** The most values a page of the list holds. */
  page: 100,
} as const;

const revision = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, {
  error: 'Use a lowercase letter, then lowercase letters, numbers or underscores.',
});
const name = z
  .string()
  .trim()
  .min(1, { error: 'Give the value a name.' })
  .max(120, { error: 'Use at most 120 characters.' });
// As written: spaces and line breaks inside a value are the author's.
const text = z.string().max(CUSTOM_VALUE_LIMITS.value, { error: 'Use at most 5,000 characters.' });
const folderName = z
  .string()
  .trim()
  .min(1, { error: 'Give the folder a name.' })
  .max(80, { error: 'Use at most 80 characters.' });
const folderId = publicId('custom_value_folder');

export const createCustomValueInput = z
  .strictObject({
    name,
    value: text.default(''),
    folderId: folderId.nullable().default(null),
    key: key.optional().meta({
      description:
        'Left out, the key is made from the name (My Custom Value becomes my_custom_value), with a number added if that key is taken. It never changes afterwards.',
    }),
  })
  .meta({ id: 'CreateCustomValueInput' });
export const updateCustomValueInput = z
  .strictObject({ name, value: text, folderId: folderId.nullable(), revision })
  .meta({
    id: 'UpdateCustomValueInput',
    description:
      'The whole value, with the revision it was read at. The key is not part of it: renaming a value never changes its key. A stale revision returns 409 and changes nothing.',
  });
export const moveCustomValuesInput = z
  .strictObject({
    valueIds: z
      .array(publicId('custom_value'))
      .min(1, { error: 'Choose at least one value.' })
      .max(CUSTOM_VALUE_LIMITS.move)
      .refine((ids) => new Set(ids).size === ids.length, { error: 'Name each value once.' }),
    folderId: folderId.nullable().meta({ description: 'The folder, or null for no folder.' }),
  })
  .meta({ id: 'MoveCustomValuesInput' });

export const deleteCustomValuesInput = z
  .strictObject({
    valueIds: z
      .array(publicId('custom_value'))
      .min(1, { error: 'Choose at least one value.' })
      .max(CUSTOM_VALUE_LIMITS.move)
      .refine((ids) => new Set(ids).size === ids.length, { error: 'Name each value once.' }),
  })
  .meta({
    id: 'DeleteCustomValuesInput',
    description:
      'The values to delete, all or none: an id that is not a custom value of this business deletes nothing.',
  });

export const customValue = z
  .looseObject({
    id: publicId('custom_value'),
    key,
    mergeKey: z.string().meta({
      description: 'The path that fills the value into a message, written inside {{ }}.',
      examples: ['custom_values.hours_of_operation'],
    }),
    name: z.string(),
    value: z.string(),
    folderId: folderId.nullable(),
    folderName: z.string().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    revision,
  })
  .meta({ id: 'CustomValue' });
export type CustomValue = z.output<typeof customValue>;

export const listCustomValuesQuery = z
  .strictObject({
    q: z
      .string()
      .trim()
      .max(200, { error: 'Use at most 200 characters.' })
      .optional()
      .meta({ description: 'Finds values by any part of their name, key or text.' }),
    folder: z
      .union([folderId, z.literal('none')])
      .optional()
      .meta({ description: 'Only the values in this folder, or "none" for those in no folder.' }),
    limit: z.coerce.number().int().min(1).max(CUSTOM_VALUE_LIMITS.page).default(20),
    after: z
      .string()
      .max(600)
      .optional()
      .meta({ description: 'Start after the previous page: its next, exactly as it was given.' }),
  })
  .meta({ id: 'ListCustomValuesQuery' });
export type ListCustomValuesQuery = z.output<typeof listCustomValuesQuery>;

export const customValueList = z
  .looseObject({
    items: z.array(customValue),
    total: z.int().meta({ description: 'How many values match the filters, on every page.' }),
    next: z
      .string()
      .nullable()
      .meta({ description: 'Pass it as after to read the next page. Null on the last page.' }),
    canManage: z.boolean(),
  })
  .meta({ id: 'CustomValueList' });
export type CustomValueList = z.output<typeof customValueList>;

export const createCustomValueFolderInput = z
  .strictObject({ name: folderName })
  .meta({ id: 'CreateCustomValueFolderInput' });
export const renameCustomValueFolderInput = z
  .strictObject({ name: folderName, revision })
  .meta({ id: 'RenameCustomValueFolderInput' });
export const customValueFolder = z
  .looseObject({
    id: folderId,
    name: z.string(),
    valueCount: z.int(),
    createdAt: timestamp,
    revision,
  })
  .meta({ id: 'CustomValueFolder' });
export type CustomValueFolder = z.output<typeof customValueFolder>;
export const customValueFolderList = z
  .looseObject({
    items: z.array(customValueFolder),
    canManage: z.boolean(),
    // Every answer of this server carries the two below. They are optional here only so
    // that an answer saved before they existed still reads.
    total: z
      .int()
      .optional()
      .meta({ description: 'How many folders match the filters, on every page.' }),
    next: z.string().nullable().optional().meta({
      description:
        'Pass it as after to read the next page. Null on the last page, and always when no limit was asked for.',
    }),
  })
  .meta({ id: 'CustomValueFolderList' });

export const listCustomValueFoldersQuery = z
  .strictObject({
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
      .max(CUSTOM_VALUE_LIMITS.page)
      .optional()
      .meta({ description: 'How many folders a page holds. Left out, every match is answered.' }),
    after: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .meta({ description: "Start after the previous page: that page's next." }),
  })
  .meta({ id: 'ListCustomValueFoldersQuery' });
export type ListCustomValueFoldersQuery = z.output<typeof listCustomValueFoldersQuery>;
export type CustomValueFolderList = z.output<typeof customValueFolderList>;

const group = 'Custom values';
const valueParams = z.strictObject({ valueId: publicId('custom_value') });
const folderParams = z.strictObject({ folderId });

export const listCustomValues = defineEndpoint({
  operationId: 'listCustomValues',
  method: 'get',
  path: '/custom-values',
  group,
  summary: 'Read custom values by name, a page at a time',
  query: listCustomValuesQuery,
  response: {
    status: 200,
    description: 'A page of values in name order, and how many match.',
    schema: customValueList,
  },
});
export const createCustomValue = defineEndpoint({
  operationId: 'createCustomValue',
  method: 'post',
  path: '/custom-values',
  group,
  summary: 'Create a custom value with a permanent key',
  body: createCustomValueInput,
  response: { status: 201, description: 'The new value, with its key.', schema: customValue },
});
export const moveCustomValues = defineEndpoint({
  operationId: 'moveCustomValues',
  method: 'post',
  path: '/custom-values/move',
  group,
  summary: 'Move custom values into a folder, or out of any folder, all or none',
  body: moveCustomValuesInput,
  response: {
    status: 200,
    description: 'The moved values, in the order they were named.',
    schema: z.looseObject({ items: z.array(customValue) }).meta({ id: 'MovedCustomValues' }),
  },
});
export const deleteCustomValues = defineEndpoint({
  operationId: 'deleteCustomValues',
  method: 'post',
  path: '/custom-values/delete',
  group,
  summary: 'Delete several custom values, all or none',
  body: deleteCustomValuesInput,
  response: {
    status: 200,
    description: 'How many values were deleted: every one that was named.',
    schema: z.looseObject({ deleted: z.int().min(1) }).meta({ id: 'DeletedCustomValues' }),
  },
});
export const getCustomValue = defineEndpoint({
  operationId: 'getCustomValue',
  method: 'get',
  path: '/custom-values/{valueId}',
  group,
  summary: 'Read one custom value',
  params: valueParams,
  response: { status: 200, description: 'The value as it is saved.', schema: customValue },
});
export const updateCustomValue = defineEndpoint({
  operationId: 'updateCustomValue',
  method: 'put',
  path: '/custom-values/{valueId}',
  group,
  summary: 'Change a custom value’s name, text or folder, never its key',
  params: valueParams,
  body: updateCustomValueInput,
  response: { status: 200, description: 'The saved value and its revision.', schema: customValue },
});
export const deleteCustomValue = defineEndpoint({
  operationId: 'deleteCustomValue',
  method: 'delete',
  path: '/custom-values/{valueId}',
  group,
  summary: 'Delete a custom value',
  params: valueParams,
  response: {
    status: 204,
    description:
      'The value is gone. A message that still uses its key is not sent until the key is removed from it or a value with that key exists again.',
  },
});
export const listCustomValueFolders = defineEndpoint({
  operationId: 'listCustomValueFolders',
  method: 'get',
  path: '/custom-value-folders',
  group,
  summary: 'Read custom value folders by name, with the number of values in each',
  query: listCustomValueFoldersQuery,
  response: { status: 200, description: 'The folders.', schema: customValueFolderList },
});
export const createCustomValueFolder = defineEndpoint({
  operationId: 'createCustomValueFolder',
  method: 'post',
  path: '/custom-value-folders',
  group,
  summary: 'Create a folder for custom values',
  body: createCustomValueFolderInput,
  response: { status: 201, description: 'The new folder.', schema: customValueFolder },
});
export const renameCustomValueFolder = defineEndpoint({
  operationId: 'renameCustomValueFolder',
  method: 'put',
  path: '/custom-value-folders/{folderId}',
  group,
  summary: 'Rename a custom value folder without overwriting another edit',
  params: folderParams,
  body: renameCustomValueFolderInput,
  response: { status: 200, description: 'The renamed folder.', schema: customValueFolder },
});
export const deleteCustomValueFolder = defineEndpoint({
  operationId: 'deleteCustomValueFolder',
  method: 'delete',
  path: '/custom-value-folders/{folderId}',
  group,
  summary: 'Delete a custom value folder, leaving its values in no folder',
  params: folderParams,
  response: { status: 204, description: 'The folder is gone. Its values remain, in no folder.' },
});

/** Every endpoint behind Settings → Custom Values. */
export const customValueEndpoints = [
  listCustomValues,
  createCustomValue,
  moveCustomValues,
  deleteCustomValues,
  getCustomValue,
  updateCustomValue,
  deleteCustomValue,
  listCustomValueFolders,
  createCustomValueFolder,
  renameCustomValueFolder,
  deleteCustomValueFolder,
] as const;
