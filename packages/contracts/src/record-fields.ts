import { actorKinds } from '@repo/kernel';
import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { fieldAiSources, fieldDefinition, type FieldDefinition } from './fields.js';
import { publicId, recordId } from './ids.js';
import { timestamp } from './timestamps.js';

const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
/** A text box list's value: each box's text by its option key. */
export const textListValue = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), z.string());
const scalar = z.union([z.string(), z.boolean(), z.array(z.string()), textListValue]);
function valueSchema(type: FieldDefinition['valueType']) {
  switch (type) {
    case 'number':
    case 'money':
      return decimal;
    case 'date':
      return z.iso.date();
    case 'datetime':
      return timestamp;
    case 'boolean':
      return z.boolean();
    case 'multi_choice':
      return z.array(z.string());
    case 'text_list':
      return textListValue;
    case 'file':
      return z.array(publicId('file'));
    case 'email':
    case 'long_text':
    case 'phone':
    case 'single_choice':
    case 'text':
    case 'url':
      return z.string();
  }
}
export const recordField = z
  .looseObject({
    definition: fieldDefinition,
    value: scalar.nullable().meta({
      description:
        "Null means unset. Numbers and money use exact decimal strings. Choice values are permanent option keys. A text box list's value is each box's text by its option key. A file upload field's value is its files' ids, oldest first: its files are uploaded and deleted through the record's files, never set here.",
    }),
    source: z
      .looseObject({
        kind: z.enum(actorKinds),
        eventId: publicId('event').nullable(),
        you: z.boolean(),
        name: z.string().nullable().optional(),
      })
      .nullable(),
    updatedAt: timestamp.nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    confirmedAt: timestamp.nullable(),
    confirmedBy: z
      .looseObject({ name: z.string().nullable(), you: z.boolean() })
      .nullable()
      .optional(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((field, context) => {
    if (
      field.value !== null &&
      !valueSchema(field.definition.valueType).safeParse(field.value).success
    )
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'The value must match the field type.',
      });
    if (
      (field.value === null) !== (field.source === null) ||
      (field.value === null) !== (field.updatedAt === null)
    )
      context.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'A saved value must have its source and update time.',
      });
  })
  .meta({ id: 'RecordField' });
export type RecordField = z.infer<typeof recordField>;
export const recordFields = z
  .looseObject({
    items: z.array(recordField),
    canManage: z.boolean().default(false),
    canConfirm: z.boolean().default(false),
  })
  .meta({ id: 'RecordFields' });
export type RecordFields = z.infer<typeof recordFields>;
export const getRecordFields = defineEndpoint({
  operationId: 'getRecordFields',
  method: 'get',
  path: '/records/{id}/fields',
  group: 'Fields',
  summary: 'Read a record’s fields and saved value sources',
  params: z.strictObject({ id: recordId }),
  response: {
    status: 200,
    description:
      'Live fields and retained archived values, in field order. Merged definitions are omitted.',
    schema: recordFields,
  },
});

export const setRecordFieldInput = z
  .strictObject({
    value: scalar.nullable(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    aiSource: z.enum(fieldAiSources).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .meta({ id: 'SetRecordFieldInput' });
export const setRecordField = defineEndpoint({
  operationId: 'setRecordField',
  method: 'put',
  path: '/records/{id}/fields/{fieldId}',
  group: 'Fields',
  summary: 'Set or clear a typed record field value',
  params: z.strictObject({ id: recordId, fieldId: publicId('field') }),
  body: setRecordFieldInput,
  response: {
    status: 200,
    description: 'Saved value and trusted provenance.',
    schema: recordField,
  },
});
export const confirmRecordFieldInput = z
  .strictObject({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
  .meta({ id: 'ConfirmRecordFieldInput' });
export const confirmRecordField = defineEndpoint({
  operationId: 'confirmRecordField',
  method: 'post',
  path: '/records/{id}/fields/{fieldId}/confirm',
  group: 'Fields',
  summary: 'Confirm an AI-filled value as the signed-in person',
  params: setRecordField.params,
  body: confirmRecordFieldInput,
  response: {
    status: 200,
    description: 'The value with its original source and human confirmation.',
    schema: recordField,
  },
});
