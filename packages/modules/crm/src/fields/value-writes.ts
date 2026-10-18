import { defineCommand, requireBusiness } from '@repo/commands';
import {
  setRecordField,
  setRecordFieldInput,
  confirmRecordField,
  confirmRecordFieldInput,
  type RecordField,
  type FieldDefinition,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  ValidationError,
} from '@repo/kernel';
import { sql } from 'kysely';
import { requireRecord } from '../records/access.js';
import { asField, type FieldRow } from './fields.js';
import { presentValue } from './value-presenter.js';
import { validateFieldValue } from './value-validation.js';

type FieldValue = RecordField['value'];
function semanticValue(definition: FieldDefinition, value: FieldValue): unknown {
  if (
    typeof value === 'string' &&
    (definition.valueType === 'number' || definition.valueType === 'money')
  ) {
    const [integer = '', fraction = ''] = value.replace(/^-/, '').split('.');
    const whole = integer.replace(/^0+(?=\d)/, '');
    const decimal = fraction.replace(/0+$/, '');
    const magnitude = `${whole}${decimal === '' ? '' : `.${decimal}`}`;
    return value.startsWith('-') && magnitude !== '0' ? `-${magnitude}` : magnitude;
  }
  if (typeof value === 'string' && definition.valueType === 'datetime')
    return new Date(value).toISOString();
  if (Array.isArray(value)) return [...value].sort();
  // A text box list's boxes in key order, so the same text is the same value.
  if (value !== null && typeof value === 'object')
    return Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return value;
}
function valueColumns(definition: FieldDefinition, value: FieldValue) {
  const columns: {
    value_text: string | null;
    value_number: string | null;
    value_date: string | null;
    value_datetime: Date | null;
    value_bool: boolean | null;
    value_options: string[] | null;
    value_json: string | null;
  } = {
    value_text: null,
    value_number: null,
    value_date: null,
    value_datetime: null,
    value_bool: null,
    value_options: null,
    value_json: null,
  };
  switch (definition.valueType) {
    case 'number':
    case 'money':
      if (typeof value === 'string') columns.value_number = value;
      break;
    case 'date':
      if (typeof value === 'string') columns.value_date = value;
      break;
    case 'datetime':
      if (typeof value === 'string') columns.value_datetime = new Date(value);
      break;
    case 'boolean':
      if (typeof value === 'boolean') columns.value_bool = value;
      break;
    case 'single_choice':
      if (typeof value === 'string') columns.value_options = [value];
      break;
    case 'multi_choice':
      if (Array.isArray(value)) columns.value_options = value;
      break;
    case 'text_list':
      if (value !== null && typeof value === 'object' && !Array.isArray(value))
        columns.value_json = JSON.stringify(value);
      break;
    // A file upload field's value is kept by the record's files (record-files.ts), and
    // validation refuses it here before anything is written.
    case 'file':
      break;
    case 'email':
    case 'long_text':
    case 'phone':
    case 'text':
    case 'url':
      if (typeof value === 'string') columns.value_text = value;
  }
  return columns;
}

export async function requireValueDefinition(
  trx: DatabaseTransaction,
  objectTypeId: string,
  fieldId: string,
  lock = false,
): Promise<FieldRow> {
  let query = trx
    .selectFrom('crm.field_definitions as f')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('o.business_id', '=', 'f.business_id').onRef('o.id', '=', 'f.object_type_id'),
    )
    .selectAll('f')
    .select(['o.key as object_key', 'o.kind as object_kind'])
    .where('f.object_type_id', '=', objectTypeId)
    .where('f.id', '=', parsePublicId('field', fieldId) ?? '')
    .where('f.merged_into_field_id', 'is', null);
  if (lock) query = query.forShare('f');
  const row = await query.executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Field', fieldId);
  return row;
}
export const setRecordFieldCommand = defineCommand({
  name: 'field.value.set',
  permission: 'fields.values',
  input: setRecordFieldInput.extend(setRecordField.params.shape),
  audit: ({ id, fieldId }) => ({ id, fieldId }),
  ownAssistantRule:
    'An assistant fills a field only from an AI source the field has enabled, and replaces a value only as the field’s overwrite setting allows. A person who approves an assistant’s proposal is held to the same source rule, and to "never".',
  async handle(trx, input, command): Promise<RecordField> {
    const businessId = requireBusiness(command.context);
    const record = await requireRecord(trx, input.id, true);
    const definition = asField(
      await requireValueDefinition(trx, record.objectTypeId, input.fieldId, true),
    );
    const fieldId = parsePublicId('field', input.fieldId) ?? '';
    const existing = await trx
      .selectFrom('crm.field_values')
      .selectAll()
      .select(sql<string | null>`value_date::text`.as('date_text'))
      .where('record_id', '=', record.id)
      .where('field_id', '=', fieldId)
      .executeTakeFirst();
    const current = presentValue(definition, existing, command);
    if (current.revision !== input.revision)
      throw new ConflictError('This value changed. Reload the saved version before editing again.');
    if (definition.archived)
      throw new ConflictError('Restore this field before changing its value.');
    const ai = command.context.actorKind === 'ai_agent';
    // A person applying what an assistant proposed: the value is still the assistant's
    // reading of an AI source, so the field must still allow that source, and the person's
    // approval is what confirms it. Only a proposal's run can say so: the command layer
    // sets `proposal`, never a request.
    const approved = !ai && command.proposal !== undefined && input.aiSource !== undefined;
    if (
      (ai || approved) &&
      (input.aiSource === undefined || !definition.aiFillSources.includes(input.aiSource))
    )
      throw new ValidationError([
        {
          path: '/aiSource',
          code: 'ai_source_disabled',
          message: 'Choose an AI source enabled for this field.',
        },
      ]);
    if (!ai && !approved && (input.aiSource !== undefined || input.confidence !== undefined))
      throw new ValidationError([
        {
          path: '/confidence',
          code: 'trusted_ai_only',
          message: 'Only the acting AI agent can supply extraction metadata.',
        },
      ]);
    const value = await validateFieldValue(trx, definition, input.value, current.value, businessId);
    if (
      JSON.stringify(semanticValue(definition, value)) ===
      JSON.stringify(semanticValue(definition, current.value))
    )
      return current;
    if (
      ai &&
      current.value !== null &&
      (definition.aiOverwrite === 'never' ||
        (definition.aiOverwrite === 'ask' &&
          (current.source?.kind !== 'ai_agent' || current.confirmedAt !== null)))
    )
      throw new ConflictError('This value needs human approval before AI can replace it.');
    // "Never" holds for an approved proposal too: no approval lets AI's reading replace a
    // value a person entered or confirmed there. A person can still type the value in.
    if (
      approved &&
      current.value !== null &&
      definition.aiOverwrite === 'never' &&
      (current.source?.kind !== 'ai_agent' || current.confirmedAt !== null)
    )
      throw new ConflictError(
        'This field never takes a value from AI over one a person entered. Type the value in instead.',
      );
    // The assistant's value, confirmed by the person who approved it. Whoever else applies
    // a proposal (an API key) sets the value as their own.
    const approver =
      approved && command.context.actorKind === 'user' ? command.context.userId : undefined;
    const eventId = await command.emit({
      type: value === null ? 'field.value_cleared' : 'field.value_set',
      subject: { kind: record.kind, id: record.id },
      records: [record.id],
      payload: { recordId: input.id, fieldId: input.fieldId },
    });
    if (value === null) {
      await trx
        .deleteFrom('crm.field_values')
        .where('record_id', '=', record.id)
        .where('field_id', '=', fieldId)
        .execute();
      return presentValue(definition, undefined, command);
    }
    const values = {
      ...valueColumns(definition, value),
      source_kind: approver === undefined ? command.context.actorKind : 'ai_agent',
      source_id: approver === undefined ? (command.context.actorId ?? null) : null,
      source_event_id: eventId,
      updated_at: new Date(),
      confidence: ai || approver !== undefined ? (input.confidence ?? null) : null,
      confirmed_at: approver === undefined ? null : new Date(),
      confirmed_by_id: approver ?? null,
    };
    await trx
      .insertInto('crm.field_values')
      .values({
        business_id: businessId,
        record_id: record.id,
        field_id: fieldId,
        value_type: definition.valueType,
        ...values,
      })
      .onConflict((conflict) =>
        conflict.columns(['business_id', 'record_id', 'field_id']).doUpdateSet(values),
      )
      .execute();
    return presentValue(
      definition,
      await trx
        .selectFrom('crm.field_values')
        .selectAll()
        .select(sql<string | null>`value_date::text`.as('date_text'))
        .where('record_id', '=', record.id)
        .where('field_id', '=', fieldId)
        .executeTakeFirstOrThrow(),
      command,
    );
  },
});

export const confirmRecordFieldCommand = defineCommand({
  name: 'field.value.confirm',
  permission: 'fields.values',
  input: confirmRecordFieldInput.extend(confirmRecordField.params.shape),
  audit: ({ id, fieldId }) => ({ id, fieldId }),
  async handle(trx, input, command): Promise<RecordField> {
    requireBusiness(command.context);
    const userId = command.context.userId;
    if (
      command.context.actorKind !== 'user' ||
      userId === undefined ||
      command.context.actorId !== userId
    )
      throw new ForbiddenError('Only a signed-in person can confirm an AI-filled value.');
    const record = await requireRecord(trx, input.id, true);
    const definition = asField(
      await requireValueDefinition(trx, record.objectTypeId, input.fieldId, true),
    );
    const fieldId = parsePublicId('field', input.fieldId) ?? '';
    const existing = await trx
      .selectFrom('crm.field_values')
      .selectAll()
      .select(sql<string | null>`value_date::text`.as('date_text'))
      .where('record_id', '=', record.id)
      .where('field_id', '=', fieldId)
      .executeTakeFirst();
    const current = presentValue(definition, existing, command);
    if (current.revision !== input.revision)
      throw new ConflictError('This value changed. Reload the saved version before confirming it.');
    if (definition.archived)
      throw new ConflictError('Restore this field before confirming its value.');
    if (existing === undefined || current.source?.kind !== 'ai_agent')
      throw new ConflictError('Only a saved AI-filled value can be confirmed.');
    if (current.confirmedAt !== null) return current;
    await command.emit({
      type: 'field.value_confirmed',
      subject: { kind: record.kind, id: record.id },
      records: [record.id],
      payload: { recordId: input.id, fieldId: input.fieldId },
    });
    await trx
      .updateTable('crm.field_values')
      .set({ confirmed_at: new Date(), confirmed_by_id: userId })
      .where('record_id', '=', record.id)
      .where('field_id', '=', fieldId)
      .execute();
    return presentValue(
      definition,
      await trx
        .selectFrom('crm.field_values')
        .selectAll()
        .select(sql<string | null>`value_date::text`.as('date_text'))
        .where('record_id', '=', record.id)
        .where('field_id', '=', fieldId)
        .executeTakeFirstOrThrow(),
      command,
    );
  },
});
