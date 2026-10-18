// Objects: the kinds of record a business keeps, as GoHighLevel's Settings → Objects lists
// them. Contacts, companies and deals are the standard ones; a business adds its own custom
// objects (Pet, Property, Event), each with an icon, a primary field whose value names each
// record, and searchable fields. Keys are bare here (`pet`); GoHighLevel's internal name,
// `custom_objects.pet`, is shown beside them and starts the merge keys of their fields.
import { actorKinds } from '@repo/kernel';
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { fieldDefinition } from './fields.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** GoHighLevel: "All plans get 10 Custom Objects per location". */
export const MAX_CUSTOM_OBJECTS = 10;

/** Searchable fields of a custom object beside its primary field, as GoHighLevel allows. */
export const MAX_SEARCHABLE_FIELDS = 3;

/** The kinds of object: the three standard ones, and custom. */
export const objectKinds = ['contact', 'company', 'deal', 'custom'] as const;
export type ObjectKind = (typeof objectKinds)[number];

/** The standard objects' keys, which no custom object can take. */
export const standardObjectKeys: readonly string[] = ['contact', 'company', 'deal'];

/**
 * The icons a custom object can have: names from the icon set the dashboard draws
 * (lucide-react), each checked to exist there.
 */
export const objectIcons = [
  'book',
  'box',
  'boxes',
  'briefcase',
  'building',
  'building-2',
  'calendar',
  'camera',
  'car',
  'clipboard-list',
  'dumbbell',
  'file-text',
  'folder',
  'gift',
  'graduation-cap',
  'hammer',
  'heart',
  'hotel',
  'house',
  'key',
  'landmark',
  'map-pin',
  'music',
  'package',
  'paw-print',
  'phone',
  'plane',
  'receipt',
  'scale',
  'shield',
  'shopping-bag',
  'star',
  'stethoscope',
  'store',
  'tag',
  'ticket',
  'truck',
  'user',
  'users',
  'utensils',
  'wrench',
] as const;
export type ObjectIcon = (typeof objectIcons)[number];

/** The types a primary field can have: GoHighLevel's "TEXT or NUMERICAL". */
export const primaryFieldTypes = ['text', 'number'] as const;

const keyFormat = /^[a-z][a-z0-9_]{0,62}$/;
const keyError = 'Use a lowercase letter, then lowercase letters, numbers or underscores.';
export const objectKey = z
  .string()
  .regex(keyFormat, { error: keyError })
  .meta({ description: "An object's key, such as contact or pet.", examples: ['pet'] });
const fieldKey = z.string().regex(keyFormat, { error: keyError });

const name = (which: string) =>
  z
    .string()
    .trim()
    .min(1, { error: `Give the object a ${which} name.` })
    .max(60, { error: 'Use at most 60 characters.' });
const description = z.string().trim().max(2000, { error: 'Use at most 2000 characters.' });

/** How GoHighLevel names an object inside: custom_objects.<key>, or a standard one's key. */
export function objectInternalName(kind: string, key: string): string {
  return kind === 'custom' ? `custom_objects.${key}` : key;
}

export const objectPrimaryField = z
  .looseObject({
    id: publicId('field'),
    key: fieldKey,
    label: z.string(),
    valueType: z.enum(primaryFieldTypes),
    unique: z.boolean(),
  })
  .meta({ id: 'ObjectPrimaryField' });

export const objectDefinition = z
  .looseObject({
    id: publicId('object_type'),
    key: objectKey,
    kind: z.enum(objectKinds),
    standard: z.boolean().meta({ description: 'Contacts, companies and deals: not custom.' }),
    internalName: z.string().meta({
      description: "GoHighLevel's name for it: custom_objects.<key>, or a standard object's key.",
      examples: ['custom_objects.pet'],
    }),
    singularLabel: z.string(),
    pluralLabel: z.string(),
    description: z.string(),
    icon: z
      .string()
      .nullable()
      .meta({ description: "A custom object's icon; null for a standard one." }),
    primaryField: objectPrimaryField.nullable().meta({
      description: 'The field whose value names each record. Null for a standard object.',
    }),
    searchableFieldIds: z.array(publicId('field')).meta({
      description: 'The fields searched with its records, beside the primary field.',
    }),
    records: z.int().min(0).nullable().meta({
      description:
        "How many records of a custom object aren't in the trash. Null for a standard object.",
    }),
    source: z.enum(actorKinds).meta({ description: 'Who or what made it.' }),
    createdAt: timestamp,
    revision: z
      .string()
      .meta({ description: 'Send it back with a change: a stale one is refused.' }),
  })
  .meta({ id: 'ObjectDefinition' });
export type ObjectDefinition = z.infer<typeof objectDefinition>;

export const objectList = z
  .looseObject({
    items: z.array(objectDefinition),
    limit: z.int().meta({ description: 'How many custom objects a business may have.' }),
    canManage: z.boolean(),
  })
  .meta({ id: 'ObjectList' });
export type ObjectList = z.infer<typeof objectList>;

export const objectDetail = objectDefinition
  .extend({ fields: z.array(fieldDefinition) })
  .meta({ id: 'ObjectDetail' });
export type ObjectDetail = z.infer<typeof objectDetail>;

export const createObjectInput = z
  .strictObject({
    singularLabel: name('singular'),
    pluralLabel: name('plural'),
    key: objectKey
      .refine((key) => !standardObjectKeys.includes(key), {
        error: 'This key belongs to a standard object.',
      })
      .optional()
      .meta({
        description: 'Left out, it is made from the singular name. It never changes.',
      }),
    description: description.default(''),
    icon: z.enum(objectIcons).nullable().default(null),
    primaryField: z.strictObject({
      label: z
        .string()
        .trim()
        .min(1, { error: 'Give the primary field a name.' })
        .max(80, { error: 'Use at most 80 characters.' }),
      key: fieldKey.optional().meta({ description: 'Left out, it is made from the name.' }),
      valueType: z.enum(primaryFieldTypes),
      unique: z.boolean().default(false).meta({
        description:
          'No two records may have the same value. It can be turned off later, never on.',
      }),
    }),
  })
  .meta({ id: 'CreateObjectInput' });
export type CreateObjectInput = z.infer<typeof createObjectInput>;

export const updateObjectInput = z
  .strictObject({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    singularLabel: name('singular'),
    pluralLabel: name('plural'),
    description,
    icon: z.enum(objectIcons).nullable(),
    searchableFieldIds: z
      .array(publicId('field'))
      .max(MAX_SEARCHABLE_FIELDS, {
        error: `Choose at most ${String(MAX_SEARCHABLE_FIELDS)} searchable fields.`,
      })
      .refine((ids) => new Set(ids).size === ids.length, { error: 'Choose each field once.' }),
  })
  .meta({
    id: 'UpdateObjectInput',
    description:
      "A custom object's names, description, icon and searchable fields. Its key and primary field never change.",
  });

export const deleteObjectInput = z
  .strictObject({
    confirm: z
      .string()
      .trim()
      .max(60)
      .meta({ description: "The object's plural name, typed out." }),
  })
  .meta({ id: 'DeleteObjectInput' });

export const objectKeyInput = z.strictObject({ key: objectKey });

export const listObjects = defineEndpoint({
  operationId: 'listObjects',
  method: 'get',
  path: '/objects',
  group: 'Objects',
  summary: 'List the standard and custom objects',
  response: { status: 200, description: 'Every object, standard ones first.', schema: objectList },
});
export const createObject = defineEndpoint({
  operationId: 'createObject',
  method: 'post',
  path: '/objects',
  group: 'Objects',
  summary: 'Create a custom object with its primary field',
  body: createObjectInput,
  response: { status: 201, description: 'The new object.', schema: objectDefinition },
});
export const getObject = defineEndpoint({
  operationId: 'getObject',
  method: 'get',
  path: '/objects/{key}',
  group: 'Objects',
  summary: 'Read an object with its fields',
  params: objectKeyInput,
  response: { status: 200, description: 'The object and its fields.', schema: objectDetail },
});
export const updateObject = defineEndpoint({
  operationId: 'updateObject',
  method: 'patch',
  path: '/objects/{key}',
  group: 'Objects',
  summary: "Change a custom object's names, icon and searchable fields",
  params: objectKeyInput,
  body: updateObjectInput,
  response: { status: 200, description: 'The changed object.', schema: objectDefinition },
});
export const deleteObject = defineEndpoint({
  operationId: 'deleteObject',
  method: 'delete',
  path: '/objects/{key}',
  group: 'Objects',
  summary: 'Delete a custom object with its records, fields and associations',
  params: objectKeyInput,
  body: deleteObjectInput,
  response: {
    status: 204,
    description:
      'Hidden at once; its records, fields and associations are removed in the background. Refused while a published workflow uses it.',
  },
});

export const objectEndpoints = [
  listObjects,
  createObject,
  getObject,
  updateObject,
  deleteObject,
] as const;
