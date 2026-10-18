// Records of custom objects, as GoHighLevel's objects records API has them: each is named by
// its object's primary field, keeps its other values in that object's fields, has an owner,
// and goes to the trash when deleted, from where it is restored until it is purged. Values
// are read and changed one field at a time through /records/{id}/fields, as a contact's are.
import * as z from 'zod';

import { contactMember, contactPerson } from './contact-people.js';
import { defineEndpoint } from './endpoints.js';
import { fieldQueryShape, refineFieldQuery } from './field-query.js';
import { publicId } from './ids.js';
import { objectKey } from './objects.js';
import { textListValue } from './record-fields.js';
import { timestamp } from './timestamps.js';

/** How many records a page of an object's list holds unless told, and at most. */
export const CUSTOM_RECORD_PAGE_SIZE = 50;
export const MAX_CUSTOM_RECORD_PAGE_SIZE = 100;

/** A record's name is its primary field's value, kept in a column of this many characters. */
export const MAX_CUSTOM_RECORD_NAME = 200;

/** The most field values one request sets on a new record. */
export const MAX_CUSTOM_RECORD_FIELDS = 100;

/** GoHighLevel's words when a unique field's value belongs to another record already. */
export const DUPLICATE_RECORD_VALUE = 'A record with the same value already exists.';

/** The orders of an object's list: by name, and newest or oldest by either time. */
export const customRecordSorts = ['name', 'created', 'updated'] as const;
export type CustomRecordSort = (typeof customRecordSorts)[number];

/** Which way an order runs when none is given: the two times newest first, the name from A. */
export const customRecordSortDirection = (
  sort: CustomRecordSort,
  direction?: 'asc' | 'desc',
): 'asc' | 'desc' => direction ?? (sort === 'name' ? 'asc' : 'desc');

/** The custom object a record is of, where a list mixes kinds: the trash, search. */
export const recordObject = z
  .looseObject({
    key: objectKey,
    label: z.string().meta({ description: "The object's singular name.", examples: ['Pet'] }),
  })
  .meta({ id: 'RecordObject' });

export const customRecord = z
  .looseObject({
    id: publicId('custom'),
    objectKey,
    name: z.string().meta({ description: "Its primary field's value." }),
    owner: contactPerson.nullable().meta({ description: 'Who owns it. Null for nobody.' }),
    ownerRevision: z.string().meta({
      description: 'Send it back with an owner change: a stale one is refused.',
    }),
    trashedAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    canManage: z.boolean(),
  })
  .meta({ id: 'CustomRecord' });
export type CustomRecord = z.infer<typeof customRecord>;

export const customRecordList = z
  .looseObject({
    items: z.array(customRecord),
    next: publicId('custom')
      .nullable()
      .meta({ description: 'Pass it as after to read the next page. Null on the last page.' }),
    total: z.int().min(0).meta({ description: 'How many records match, the same on every page.' }),
    canManage: z.boolean(),
  })
  .meta({ id: 'CustomRecordList' });
export type CustomRecordList = z.infer<typeof customRecordList>;

export const listCustomRecordsQuery = z
  .strictObject({
    q: z.string().trim().max(200).optional().meta({
      description:
        'Any part of the name or of a searchable field, in either case; a shorter search than three characters matches the start of the name’s words.',
    }),
    after: publicId('custom').optional().meta({
      description: "Start after this record: the previous page's next, with the same order.",
    }),
    limit: z.coerce
      .number()
      .int()
      .min(1, { error: 'Ask for at least 1 record.' })
      .max(MAX_CUSTOM_RECORD_PAGE_SIZE, {
        error: `Ask for at most ${String(MAX_CUSTOM_RECORD_PAGE_SIZE)} records.`,
      })
      .optional()
      .meta({
        description: `How many records a page holds. Left out, ${String(CUSTOM_RECORD_PAGE_SIZE)}.`,
      }),
    sort: z.enum(customRecordSorts).optional().meta({
      description: 'A column to order by. Left out, the most recently changed first.',
    }),
    direction: z.enum(['asc', 'desc']).optional().meta({
      description:
        'Which way the sort runs. Left out: newest first for the times, from A for the name.',
    }),
    ...fieldQueryShape,
  })
  .superRefine((input, context) => {
    refineFieldQuery(input, context);
    if (input.sort !== undefined && input.sortField !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['sortField'],
        message: 'Sort by a column or by a field, not both.',
      });
    if (input.direction !== undefined && input.sort === undefined)
      context.addIssue({
        code: 'custom',
        path: ['direction'],
        message: 'Choose a column to sort by.',
      });
  })
  .meta({ id: 'ListCustomRecordsQuery' });

const fieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, {
  error: 'Use the key of a field of this object.',
});
const fieldValue = z.union([z.string(), z.boolean(), z.array(z.string()), textListValue]);

export const createCustomRecordInput = z
  .strictObject({
    fields: z
      .record(fieldKey, fieldValue)
      .refine((fields) => Object.keys(fields).length <= MAX_CUSTOM_RECORD_FIELDS, {
        error: `Set at most ${String(MAX_CUSTOM_RECORD_FIELDS)} fields at once.`,
      })
      .meta({
        description:
          "Values by field key, as /records/{id}/fields takes them. The primary field's is required.",
        examples: [{ pet_name: 'Buddy' }],
      }),
    owner: contactMember.nullable().default(null).meta({
      description: 'A membership id, "me", or null for no owner.',
    }),
  })
  .meta({ id: 'CreateCustomRecordInput' });
export type CreateCustomRecordInput = z.input<typeof createCustomRecordInput>;

export const updateCustomRecordInput = z
  .strictObject({
    owner: contactMember.nullable().meta({
      description: 'A membership id, "me", or null for no owner.',
    }),
    revision: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .meta({
        description: "The record's ownerRevision as you read it. A stale one returns 409.",
      }),
  })
  .meta({ id: 'UpdateCustomRecordInput' });

export const customRecordsParams = z.strictObject({ key: objectKey });
export const customRecordParams = z.strictObject({ key: objectKey, id: publicId('custom') });

const group = 'Records';

export const listCustomRecords = defineEndpoint({
  operationId: 'listCustomRecords',
  method: 'get',
  path: '/objects/{key}/records',
  group,
  summary: "List and search a custom object's records",
  params: customRecordsParams,
  query: listCustomRecordsQuery,
  response: {
    status: 200,
    description: 'A page of the records outside the trash, with how many match.',
    schema: customRecordList,
  },
});
export const createCustomRecord = defineEndpoint({
  operationId: 'createCustomRecord',
  method: 'post',
  path: '/objects/{key}/records',
  group,
  summary: 'Create a record of a custom object',
  params: customRecordsParams,
  body: createCustomRecordInput,
  response: { status: 201, description: 'The new record.', schema: customRecord },
});
export const getCustomRecord = defineEndpoint({
  operationId: 'getCustomRecord',
  method: 'get',
  path: '/objects/{key}/records/{id}',
  group,
  summary: 'Read a record of a custom object, including one in the trash',
  params: customRecordParams,
  response: { status: 200, description: 'The record.', schema: customRecord },
});
export const updateCustomRecord = defineEndpoint({
  operationId: 'updateCustomRecord',
  method: 'patch',
  path: '/objects/{key}/records/{id}',
  group,
  summary: "Change a record's owner",
  params: customRecordParams,
  body: updateCustomRecordInput,
  response: { status: 200, description: 'The changed record.', schema: customRecord },
});
export const trashCustomRecord = defineEndpoint({
  operationId: 'trashCustomRecord',
  method: 'delete',
  path: '/objects/{key}/records/{id}',
  group,
  summary: 'Move a record of a custom object to the trash',
  params: customRecordParams,
  response: { status: 200, description: 'The record, in the trash.', schema: customRecord },
});
export const restoreCustomRecord = defineEndpoint({
  operationId: 'restoreCustomRecord',
  method: 'post',
  path: '/objects/{key}/records/{id}/restore',
  group,
  summary: 'Restore a record of a custom object from the trash',
  params: customRecordParams,
  response: { status: 200, description: 'The restored record.', schema: customRecord },
});

export const customRecordEndpoints = [
  listCustomRecords,
  createCustomRecord,
  getCustomRecord,
  updateCustomRecord,
  trashCustomRecord,
  restoreCustomRecord,
] as const;
