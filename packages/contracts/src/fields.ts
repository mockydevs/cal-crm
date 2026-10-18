import { actorKinds } from '@repo/kernel';
import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { documentFormats, MAX_FIELD_FILES } from './document-formats.js';
import { timestamp } from './timestamps.js';

export const fieldValueTypes = [
  'text',
  'long_text',
  'number',
  'money',
  'date',
  'datetime',
  'boolean',
  'single_choice',
  'multi_choice',
  'email',
  'phone',
  'url',
  // GoHighLevel's Text Box List: one text box for each option the field defines, filled in
  // separately, kept as text by option key.
  'text_list',
  // GoHighLevel's File Upload: files kept on the record, at most the field's limit.
  'file',
] as const;
/** The types whose definition lists options: choices, or a text box list's boxes. */
export const optionedValueTypes: readonly (typeof fieldValueTypes)[number][] = [
  'single_choice',
  'multi_choice',
  'text_list',
];
/** The types a field can be unique in: GoHighLevel's single line, multi line, number and phone. */
export const uniqueValueTypes: readonly (typeof fieldValueTypes)[number][] = [
  'text',
  'long_text',
  'number',
  'phone',
];
/** Whether the assistant may fill a field of this type from what it reads. */
export const aiFillable = (type: (typeof fieldValueTypes)[number]): boolean =>
  type !== 'text_list' && type !== 'file';
export const fieldAiSources = ['conversations', 'forms', 'call_notes'] as const;
/**
 * How a choice field is shown. GoHighLevel's Radio Select is a single choice shown as radio
 * buttons, and its Checkbox a multiple choice shown as checkboxes: the same values,
 * validated, filtered, sorted, filled into messages and imported the same way.
 */
export const fieldChoiceDisplays = ['dropdown', 'radio', 'checkbox'] as const;
export type FieldChoiceDisplay = (typeof fieldChoiceDisplays)[number];
/** The control each choice type may be shown as; the first is the one it has unless said. */
export const choiceDisplaysOf: Readonly<
  Record<'single_choice' | 'multi_choice', readonly FieldChoiceDisplay[]>
> = {
  single_choice: ['dropdown', 'radio'],
  multi_choice: ['dropdown', 'checkbox'],
};
const key = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, {
  error: 'Use a lowercase letter, then lowercase letters, numbers or underscores.',
});
export const fieldOption = z.strictObject({
  key,
  label: z.string().trim().min(1, { error: 'Give the choice a name.' }).max(80),
  description: z.string().trim().max(2000),
  archived: z.boolean(),
});
const editable = z.strictObject({
  label: z.string().trim().min(1, { error: 'Give the field a name.' }).max(80),
  description: z.string().trim().min(1, { error: 'Explain what this field means.' }).max(2000),
  options: z
    .array(fieldOption)
    .max(100)
    .superRefine((options, context) => {
      const keys = new Set<string>();
      const labels = new Set<string>();
      options.forEach((option, index) => {
        if (keys.has(option.key))
          context.addIssue({
            code: 'custom',
            path: [index, 'key'],
            message: 'Choice keys must be unique.',
          });
        if (!option.archived && labels.has(option.label.toLowerCase()))
          context.addIssue({
            code: 'custom',
            path: [index, 'label'],
            message: 'Active choice names must be unique.',
          });
        keys.add(option.key);
        if (!option.archived) labels.add(option.label.toLowerCase());
      });
    }),
  aiFillSources: z
    .array(z.enum(fieldAiSources))
    .max(3)
    .refine((sources) => new Set(sources).size === sources.length, {
      error: 'Use each source only once.',
    }),
  aiOverwrite: z.enum(['ask', 'allow', 'never']),
  archived: z.boolean(),
});
/** What a file upload field takes: which formats, and how many files on one record. */
export const fieldFileOptions = z
  .strictObject({
    formats: z
      .array(z.enum(documentFormats))
      .min(1, { error: 'Allow at least one format.' })
      .max(documentFormats.length)
      .refine((formats) => new Set(formats).size === formats.length, {
        error: 'Name each format once.',
      }),
    limit: z
      .int()
      .min(1)
      .max(MAX_FIELD_FILES, { error: `A field holds at most ${String(MAX_FIELD_FILES)} files.` })
      .meta({ description: 'How many files the field holds on one record: 1 for a single file.' }),
  })
  .meta({ id: 'FieldFileOptions' });
export type FieldFileOptions = z.infer<typeof fieldFileOptions>;
/** The hint an empty input shows. Display text only: it is never stored as a value. */
const placeholder = z.string().trim().max(200, { error: 'Use at most 200 characters.' });
/** What a save may also say about a field. Left out, each stays as it is. */
const placement = {
  folderId: publicId('field_folder').optional().meta({
    description:
      "The folder the field is in: one of its own object's. Left out, a new field goes to the object's system folder and a saved one stays where it is.",
  }),
  placeholder: placeholder.optional(),
  files: fieldFileOptions.optional().meta({
    description:
      'For a file upload field only: the formats it takes and how many files it holds. Required when one is made; left out of a save, it stays as it is.',
  }),
};
export const createFieldInput = editable
  .extend({
    objectKey: key,
    key,
    valueType: z.enum(fieldValueTypes),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    display: z.enum(fieldChoiceDisplays).optional().meta({
      description:
        'For a choice field only: dropdown (the default), radio for a single choice, checkbox for a multiple choice. Like the type, it is chosen once.',
    }),
    unique: z.boolean().optional().meta({
      description:
        "For a custom object's single line, multi line, number or phone field: no two records may have the same value. Chosen when the field is made.",
    }),
    ...placement,
  })
  .superRefine((input, context) => {
    if (input.unique === true && !uniqueValueTypes.includes(input.valueType))
      context.addIssue({
        code: 'custom',
        path: ['unique'],
        message: 'Only a single line, multi line, number or phone field can be unique.',
      });
    if ((input.valueType === 'money') !== (input.currency !== null))
      context.addIssue({
        code: 'custom',
        path: ['currency'],
        message: 'Set a currency only for a money field.',
      });
    if (optionedValueTypes.includes(input.valueType) !== input.options.length > 0)
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message:
          input.valueType === 'text_list'
            ? 'A text box list needs at least one box.'
            : 'Choice fields need choices; other types cannot have choices.',
      });
    if (!aiFillable(input.valueType) && input.aiFillSources.length > 0)
      context.addIssue({
        code: 'custom',
        path: ['aiFillSources'],
        message: "The assistant doesn't fill a text box list or a file upload field.",
      });
    if ((input.valueType === 'file') !== (input.files !== undefined))
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message:
          'Set the formats and the number of files for a file upload field, and only for one.',
      });
    const displays =
      input.valueType === 'single_choice' || input.valueType === 'multi_choice'
        ? choiceDisplaysOf[input.valueType]
        : [];
    if (input.display !== undefined && !displays.includes(input.display))
      context.addIssue({
        code: 'custom',
        path: ['display'],
        message:
          'Radio buttons show a single choice field and checkboxes a multiple choice field; other types have no such setting.',
      });
  })
  .meta({ id: 'CreateFieldInput' });
export type CreateFieldInput = z.infer<typeof createFieldInput>;
export const updateFieldInput = editable
  .extend({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    ...placement,
    unique: z.literal(false).optional().meta({
      description:
        'False turns a unique field into an ordinary one, for good. Left out, it stays as it is.',
    }),
  })
  .meta({
    id: 'UpdateFieldInput',
    description:
      'Keys, object and value type are immutable. Retain existing choices and archive them instead of removing them. A stale revision returns 409.',
  });
export type UpdateFieldInput = z.infer<typeof updateFieldInput>;
export const fieldDefinition = editable
  .extend({
    id: publicId('field'),
    objectKey: key,
    key,
    valueType: z.enum(fieldValueTypes),
    currency: z.string().nullable(),
    revision: z.string(),
    // Every answer of this server carries the eight below. They are optional here only so
    // that an answer saved before they existed still reads.
    folderId: publicId('field_folder').optional(),
    placeholder: z.string().optional(),
    mergeKey: z.string().nullable().optional().meta({
      description:
        'The path that fills this field into a message, written inside {{ }}: contact.<key>, opportunity.<key> for a deal field, business.<key> for a company field, custom_objects.<object>.<key> for a custom object field. It never changes.',
    }),
    createdAt: timestamp.optional(),
    source: z.enum(actorKinds).optional().meta({ description: 'Who or what created the field.' }),
    system: z.boolean().optional().meta({
      description:
        'A field the product owns. It can be moved to another folder and reordered; it cannot be edited, archived or deleted.',
    }),
    position: z
      .int()
      .optional()
      .meta({ description: 'Where the field comes in its folder, from 0.' }),
    display: z.enum(fieldChoiceDisplays).nullable().optional().meta({
      description:
        'How a choice field is shown: dropdown, radio or checkbox. Null for a field that is not a choice.',
    }),
    files: fieldFileOptions.nullable().optional().meta({
      description:
        'What a file upload field takes: its formats and how many files. Null for any other field.',
    }),
    primary: z.boolean().optional().meta({
      description:
        "A custom object's primary field: its value names each record. It is required, and can't be archived or deleted.",
    }),
    unique: z.boolean().optional().meta({
      description:
        'No two records of its object have the same value. It can be turned off, never back on, and a unique field cannot be deleted.',
    }),
    searchable: z.boolean().optional().meta({
      description: "Searched with its object's records: chosen on the object.",
    }),
  })
  .loose()
  .meta({ id: 'FieldDefinition' });
export type FieldDefinition = z.infer<typeof fieldDefinition>;
export const fieldConfiguration = z
  .looseObject({
    items: z.array(fieldDefinition),
    objects: z.array(z.looseObject({ key, label: z.string() })),
    canManage: z.boolean(),
  })
  .meta({ id: 'FieldConfiguration' });
export type FieldConfiguration = z.infer<typeof fieldConfiguration>;
export const getFields = defineEndpoint({
  operationId: 'getFields',
  method: 'get',
  path: '/fields',
  group: 'Fields',
  summary: 'Read field definitions, including archived fields',
  response: {
    status: 200,
    description: 'Fields, available objects and editing permission.',
    schema: fieldConfiguration,
  },
});
export const createField = defineEndpoint({
  operationId: 'createField',
  method: 'post',
  path: '/fields',
  group: 'Fields',
  summary: 'Create a field with a permanent key and type',
  body: createFieldInput,
  response: { status: 201, description: 'The created field.', schema: fieldDefinition },
});
export const updateField = defineEndpoint({
  operationId: 'updateField',
  method: 'put',
  path: '/fields/{fieldId}',
  group: 'Fields',
  summary: 'Update a field without changing its key, object or type',
  params: z.strictObject({ fieldId: publicId('field') }),
  body: updateFieldInput,
  response: { status: 200, description: 'The saved field and revision.', schema: fieldDefinition },
});

const confirmation = z.string().regex(/^[a-f0-9]{64}$/);
/** What a field's deletion would lose, and the token that stands for exactly that. */
export const fieldDeletion = z
  .looseObject({
    field: z.looseObject({
      id: publicId('field'),
      objectKey: key,
      key,
      label: z.string(),
      mergeKey: z.string().nullable(),
    }),
    values: z.int().min(0).meta({
      description: 'How many records hold a value of this field. Every one is deleted with it.',
    }),
    templates: z.array(z.looseObject({ id: publicId('template'), name: z.string() })).meta({
      description:
        'Message templates whose subject or body uses the field. Each will name it as a merge field no send can fill in.',
    }),
    automations: z.array(z.looseObject({ id: publicId('automation'), name: z.string() })).meta({
      description:
        'Automations, deleted ones left out, whose draft or published version uses the field. A step that needs it will stop.',
    }),
    canDelete: z.boolean().meta({
      description:
        'False for a system field, for a field other fields were merged into, and for a role that may not delete fields.',
    }),
    confirmation: confirmation.meta({
      description:
        'Send it back to delete the field. It stands for the field as it is now and everything listed here; once any of that changes it is refused with 409.',
    }),
  })
  .meta({ id: 'FieldDeletion' });
export type FieldDeletion = z.infer<typeof fieldDeletion>;
export const deleteFieldInput = z.strictObject({ confirmation }).meta({
  id: 'DeleteFieldInput',
  description:
    "The confirmation read from the field's deletion. Deleting is permanent: the field and every value of it are gone, and nothing restores them.",
});
const fieldParams = z.strictObject({ fieldId: publicId('field') });
export const getFieldDeletion = defineEndpoint({
  operationId: 'getFieldDeletion',
  method: 'get',
  path: '/fields/{fieldId}/deletion',
  group: 'Fields',
  summary: 'Read what deleting a field for good would lose',
  params: fieldParams,
  response: {
    status: 200,
    description: 'The values, templates and automations the field is in, and a confirmation.',
    schema: fieldDeletion,
  },
});
export const deleteField = defineEndpoint({
  operationId: 'deleteField',
  method: 'post',
  path: '/fields/{fieldId}/delete',
  group: 'Fields',
  summary: 'Delete a field and every value of it, for good',
  params: fieldParams,
  body: deleteFieldInput,
  response: {
    status: 204,
    description:
      'The field and its values are gone. 409 when the confirmation no longer describes the field; 422 for a system field or a field others were merged into.',
  },
});
