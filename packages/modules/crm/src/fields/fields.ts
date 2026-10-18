import { createHash } from 'node:crypto';
import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  createFieldInput,
  fieldDefinition,
  aiFillable,
  fieldFileOptions,
  fieldMergeKey,
  optionedValueTypes,
  updateFieldInput,
  updateField,
  type FieldConfiguration,
  type FieldDefinition,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction, type DB } from '@repo/db';
import type { Selectable } from 'kysely';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  ValidationError,
  toPublicId,
} from '@repo/kernel';
import { folderOfObject, holdFolder, lastPlaceIn, systemFolderOf } from './folder-access.js';

const uniqueErrors = explainUniqueViolation({
  field_definitions_key_unique: () => invalid('/key', 'This key already belongs to a field.'),
  field_definitions_label_unique_idx: () =>
    invalid('/label', 'A field with this name already exists on this object.'),
});
export const updateFieldCommand = defineCommand({
  name: 'field.update',
  permission: 'fields.manage',
  input: updateFieldInput.extend(updateField.params.shape),
  async handle(trx, input, command): Promise<FieldDefinition> {
    requireBusiness(command.context);
    // The folder before the field: see the lock order in folders.ts.
    const folder = input.folderId === undefined ? undefined : await holdFolder(trx, input.folderId);
    const row = await trx
      .selectFrom('crm.field_definitions as f')
      .innerJoin('crm.object_types as o', (join) =>
        join.onRef('f.business_id', '=', 'o.business_id').onRef('f.object_type_id', '=', 'o.id'),
      )
      .selectAll('f')
      .select([
        'o.key as object_key',
        'o.kind as object_kind',
        'o.primary_field_id as object_primary_field_id',
      ])
      .where('f.id', '=', parsePublicId('field', input.fieldId) ?? '')
      .forUpdate('f')
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Field', input.fieldId);
    // Whatever revision it was sent with: a system field is the product's, and only moved.
    if (row.is_system)
      throw new ValidationError([
        {
          path: '',
          code: 'system_field',
          message: 'A system field can be moved to another folder, not changed.',
        },
      ]);
    const current = asField(row);
    if (current.revision !== input.revision)
      throw new ConflictError('This field changed. Reload the saved version before editing again.');
    if (row.merged_into_field_id !== null)
      throw invalid('/archived', 'A merged field cannot be edited.');
    if (input.archived && row.object_primary_field_id === row.id)
      throw invalid('/archived', 'The primary field names each record, so it can’t be archived.');
    if (current.options.some((option) => !input.options.some((next) => next.key === option.key)))
      throw invalid(
        '/options',
        'Keep existing choice keys. Archive choices instead of removing them.',
      );
    if (optionedValueTypes.includes(current.valueType) !== input.options.length > 0)
      throw invalid(
        '/options',
        current.valueType === 'text_list'
          ? 'A text box list needs at least one box.'
          : 'Choice fields need choices; other types cannot have choices.',
      );
    if (!aiFillable(current.valueType) && input.aiFillSources.length > 0)
      throw invalid(
        '/aiFillSources',
        "The assistant doesn't fill a text box list or a file upload field.",
      );
    if (input.files !== undefined && current.valueType !== 'file')
      throw invalid('/files', 'Only a file upload field takes formats and a number of files.');
    const target =
      input.folderId === undefined ? undefined : folderOfObject(folder, row.object_type_id);
    const saved = await trx
      .updateTable('crm.field_definitions')
      .set({
        label: input.label,
        description: input.description,
        options: JSON.stringify(input.options),
        ai_fill_sources: input.aiFillSources,
        ai_overwrite: input.aiOverwrite,
        archived_at: input.archived ? new Date() : null,
        // Left out, the folder and the placeholder stay as they are. A field that changes
        // folder goes last in the one it arrives in.
        ...(target === undefined || target === row.folder_id
          ? {}
          : { folder_id: target, position: (await lastPlaceIn(trx, target)) + 1 }),
        ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
        // Only ever false: a unique field becomes an ordinary one for good, and its values
        // leave the ledger with it (0128).
        ...(input.unique === undefined ? {} : { is_unique: input.unique }),
        // A lower limit keeps the files a record already has; it holds for new ones.
        ...(input.files === undefined
          ? {}
          : { file_formats: input.files.formats, file_limit: input.files.limit }),
      })
      .where('id', '=', row.id)
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'field.updated',
      subject: { kind: 'field', id: row.id },
      payload: {
        key: current.key,
        objectKey: current.objectKey,
        label: input.label,
        archived: input.archived,
      },
    });
    return asField({
      ...saved,
      object_key: row.object_key,
      object_kind: row.object_kind,
      object_primary_field_id: row.object_primary_field_id,
    });
  },
});
function invalid(path: string, message: string): ValidationError {
  return new ValidationError([{ path, code: 'invalid_field', message }]);
}
export async function readFields(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<FieldConfiguration> {
  requireBusiness(invocation.context);
  const rows = await trx
    .selectFrom('crm.field_definitions as f')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('f.business_id', '=', 'o.business_id').onRef('f.object_type_id', '=', 'o.id'),
    )
    .innerJoin('crm.field_folders as d', (join) =>
      join.onRef('d.business_id', '=', 'f.business_id').onRef('d.id', '=', 'f.folder_id'),
    )
    .selectAll('f')
    .select([
      'o.key as object_key',
      'o.kind as object_kind',
      'o.primary_field_id as object_primary_field_id',
    ])
    // Object by object, folders in their order, each folder's fields in theirs.
    .orderBy('o.key')
    .orderBy('d.position')
    .orderBy('d.created_at')
    .orderBy('d.id')
    .orderBy('f.position')
    .orderBy('f.id')
    .execute();
  const items = rows.map(asField);
  const objects = await trx
    .selectFrom('crm.object_types')
    .select(['key', 'singular_label as label'])
    .where('archived_at', 'is', null)
    .orderBy('key')
    .execute();
  return {
    items,
    objects,
    canManage: invocation.permissions === 'all' || invocation.permissions.has('fields.manage'),
  };
}
/**
 * A field definition's row with its object's key and kind, as every reader selects it, and
 * its object's primary field where the reader says which field that is.
 */
export type FieldRow = Selectable<DB['crm.field_definitions']> & {
  object_key: string;
  object_kind: string;
  object_primary_field_id?: string | null;
};
export function asField(row: FieldRow): FieldDefinition {
  const data = {
    id: toPublicId('field', row.id),
    objectKey: row.object_key,
    key: row.key,
    label: row.label,
    description: row.description,
    valueType: row.value_type,
    currency: row.currency,
    options: row.options,
    aiFillSources: row.ai_fill_sources,
    aiOverwrite: row.ai_overwrite,
    archived: row.archived_at !== null,
    folderId: toPublicId('field_folder', row.folder_id),
    placeholder: row.placeholder,
    mergeKey: fieldMergeKey(row.object_kind, row.key, row.object_key),
    createdAt: row.created_at.toISOString(),
    source: row.created_by_kind,
    // Only a file upload field has these, so every other field's revision is as it was.
    ...(row.value_type === 'file'
      ? { files: fieldFileOptions.parse({ formats: row.file_formats, limit: row.file_limit }) }
      : {}),
  };
  return fieldDefinition.parse({
    files: null,
    ...data,
    system: row.is_system,
    // Not part of the revision either: a field only stops being unique, and the object
    // says which fields are searched, so neither can make a save stale.
    unique: row.is_unique,
    searchable: row.is_searchable,
    // Said of a custom object's fields, by the readers that know its primary field.
    ...(row.object_kind !== 'custom' || row.object_primary_field_id === undefined
      ? {}
      : { primary: row.object_primary_field_id === row.id }),
    // Chosen once, like the type: null for a field that is not a choice.
    display:
      row.value_type === 'single_choice' || row.value_type === 'multi_choice'
        ? (row.choice_display ?? 'dropdown')
        : null,
    // Not part of the revision: putting a folder's fields in another order is no edit of
    // any of them, so a form left open through it still saves.
    position: row.position,
    // Everything a save can change, the folder and placeholder included: a move made
    // while the field's form is open is a stale save, never a silent move back.
    revision: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
  });
}
export const createFieldCommand = defineCommand({
  name: 'field.create',
  permission: 'fields.manage',
  input: createFieldInput,
  // The in-app assistant may add a field for the person it works for, held to the rule for
  // building drafts and to that person's own role.
  delegation: { action: 'build_draft' },
  async handle(trx, input, command): Promise<FieldDefinition> {
    const businessId = requireBusiness(command.context);
    const object = await trx
      .selectFrom('crm.object_types')
      .select(['id', 'kind', 'primary_field_id'])
      .where('key', '=', input.objectKey)
      .where('archived_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (object === undefined) throw invalid('/objectKey', 'Choose an object in this business.');
    // GoHighLevel's unique fields are a custom object's; a contact's email and phone number
    // are unique by their own rule.
    if (input.unique === true && object.kind !== 'custom')
      throw invalid('/unique', "Only a custom object's fields can be unique.");
    const alias = await trx
      .selectFrom('crm.field_key_aliases')
      .select('alias_key')
      .where('object_type_id', '=', object.id)
      .where('alias_key', '=', input.key)
      .executeTakeFirst();
    if (alias !== undefined) throw invalid('/key', 'This key is reserved by an existing field.');
    const folderId =
      input.folderId === undefined
        ? await systemFolderOf(trx, object.id)
        : folderOfObject(await holdFolder(trx, input.folderId), object.id);
    const row = await trx
      .insertInto('crm.field_definitions')
      .values({
        business_id: businessId,
        object_type_id: object.id,
        key: input.key,
        label: input.label,
        description: input.description,
        value_type: input.valueType,
        currency: input.currency,
        options: JSON.stringify(input.options),
        ai_fill_sources: input.aiFillSources,
        ai_overwrite: input.aiOverwrite,
        archived_at: input.archived ? new Date() : null,
        // Stored only when it is not the type's usual control.
        choice_display:
          input.display === undefined || input.display === 'dropdown' ? null : input.display,
        folder_id: folderId,
        // Last in its folder. The object type is held above, so two fields made at once
        // for one object take their places one after the other.
        position: (await lastPlaceIn(trx, folderId)) + 1,
        placeholder: input.placeholder ?? '',
        file_formats: input.files?.formats ?? null,
        file_limit: input.files?.limit ?? null,
        is_unique: input.unique ?? false,
        created_by_kind: command.context.actorKind,
        created_by_id: command.context.actorId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch(uniqueErrors);
    await command.emit({
      type: 'field.created',
      subject: { kind: 'field', id: row.id },
      payload: { key: input.key, objectKey: input.objectKey, label: input.label },
    });
    return asField({
      ...row,
      object_key: input.objectKey,
      object_kind: object.kind,
      object_primary_field_id: object.primary_field_id,
    });
  },
});
