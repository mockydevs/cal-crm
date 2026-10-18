import type { FieldDefinition, FieldListOptions, RecordKind } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, ValidationError } from '@repo/kernel';
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { requireRecord } from '../records/access.js';
import { asField } from './fields.js';
import { validateFieldValue } from './value-validation.js';

async function definitionFor(
  trx: DatabaseTransaction,
  kind: RecordKind,
  id: string,
  path: string,
): Promise<FieldDefinition> {
  const definition = await trx
    .selectFrom('crm.field_definitions as f')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('o.id', '=', 'f.object_type_id').onRef('o.business_id', '=', 'f.business_id'),
    )
    .selectAll('f')
    .select(['o.key as object_key', 'o.kind as object_kind'])
    .where('f.id', '=', parsePublicId('field', id) ?? '')
    .where('o.kind', '=', kind)
    .where('f.merged_into_field_id', 'is', null)
    .executeTakeFirst();
  if (definition === undefined)
    throw new ValidationError([
      { path, code: 'unknown_field', message: 'Choose a field on this object in this business.' },
    ]);
  return asField(definition);
}
function expression(definition: FieldDefinition, alias: string): RawBuilder<unknown> {
  switch (definition.valueType) {
    case 'number':
    case 'money':
      return sql`${sql.ref(`${alias}.value_number`)}`;
    case 'date':
      return sql`${sql.ref(`${alias}.value_date`)}`;
    case 'datetime':
      return sql`${sql.ref(`${alias}.value_datetime`)}`;
    case 'boolean':
      return sql`${sql.ref(`${alias}.value_bool`)}`;
    case 'single_choice':
    case 'multi_choice':
    case 'file':
      return sql`${sql.ref(`${alias}.value_options`)}`;
    case 'text_list':
      return sql`${sql.ref(`${alias}.value_json`)}`;
    case 'email':
    case 'long_text':
    case 'phone':
    case 'text':
    case 'url':
      return sql`lower(${sql.ref(`${alias}.value_text`)})`;
  }
}
/**
 * A text box list (several texts) and a file upload field (files) have no one value to
 * compare or sort by: a list asks only whether they are set.
 */
const unmatched = (definition: FieldDefinition): boolean =>
  definition.valueType === 'text_list' || definition.valueType === 'file';
export interface FieldListPlan {
  readonly sortId: string | undefined;
  readonly order: RawBuilder<unknown> | undefined;
  readonly filter: RawBuilder<SqlBool> | undefined;
  readonly after: RawBuilder<SqlBool> | undefined;
}
export async function planFieldList(
  trx: DatabaseTransaction,
  businessId: string,
  kind: RecordKind,
  alias: string,
  input: FieldListOptions & { after?: string | undefined },
): Promise<FieldListPlan> {
  const recordId = sql.ref(`${alias}.id`);
  let filter: RawBuilder<SqlBool> | undefined;
  if (input.fieldId !== undefined) {
    const definition = await definitionFor(trx, kind, input.fieldId, '/fieldId');
    const fieldId = parsePublicId('field', definition.id);
    const exists = sql<SqlBool>`exists (select 1 from crm.field_values fv where fv.business_id = ${businessId} and fv.record_id = ${recordId} and fv.field_id = ${fieldId})`;
    if (input.fieldOperator === 'is_set') filter = exists;
    else if (input.fieldOperator === 'is_unset') filter = sql`not (${exists})`;
    else if (unmatched(definition))
      throw new ValidationError([
        {
          path: '/fieldOperator',
          code: 'invalid_operator',
          message: 'This field can be filtered by whether it is set or not.',
        },
      ]);
    else {
      const comparable = ['number', 'money', 'date', 'datetime'].includes(definition.valueType);
      if (!comparable && ['gt', 'gte', 'lt', 'lte'].includes(input.fieldOperator ?? ''))
        throw new ValidationError([
          {
            path: '/fieldOperator',
            code: 'invalid_operator',
            message: 'This field supports equality or text/choice matching.',
          },
        ]);
      if (input.fieldOperator === 'contains' && (comparable || definition.valueType === 'boolean'))
        throw new ValidationError([
          {
            path: '/fieldOperator',
            code: 'invalid_operator',
            message: 'Choose a comparison supported by this field type.',
          },
        ]);
      const choices =
        definition.valueType === 'single_choice' || definition.valueType === 'multi_choice';
      const raw =
        definition.valueType === 'boolean'
          ? input.fieldValue === 'true'
            ? true
            : input.fieldValue === 'false'
              ? false
              : (input.fieldValue ?? '')
          : definition.valueType === 'multi_choice'
            ? [input.fieldValue ?? '']
            : (input.fieldValue ?? '');
      let value;
      try {
        value = await validateFieldValue(
          trx,
          definition,
          raw,
          definition.options.map((option) => option.key),
          businessId,
        );
      } catch (error: unknown) {
        if (!(error instanceof ValidationError)) throw error;
        const issues = error.issues.map((issue) => ({
          ...issue,
          path: issue.path.replace(/^\/value/, '/fieldValue'),
        }));
        const [first, ...rest] = issues;
        if (first === undefined) throw error;
        throw new ValidationError([first, ...rest]);
      }
      const column = expression(definition, 'fv');
      const comparison = choices
        ? sql`${sql.ref('fv.value_options')} @> ${[input.fieldValue]}::text[]`
        : input.fieldOperator === 'contains'
          ? sql`${column} like ${`%${(typeof value === 'string' ? value : '')
              .toLowerCase()
              .replace(/[\\%_]/g, (character) => `\\${character}`)}%`}`
          : input.fieldOperator === 'gt'
            ? sql`${column} > ${value}`
            : input.fieldOperator === 'gte'
              ? sql`${column} >= ${value}`
              : input.fieldOperator === 'lt'
                ? sql`${column} < ${value}`
                : input.fieldOperator === 'lte'
                  ? sql`${column} <= ${value}`
                  : sql`${column} = ${typeof value === 'string' && !comparable ? value.toLowerCase() : value}`;
      filter = sql`exists (select 1 from crm.field_values fv where fv.business_id = ${businessId} and fv.record_id = ${recordId} and fv.field_id = ${fieldId} and (${comparison}))`;
    }
  }
  let sortId: string | undefined;
  let order: RawBuilder<unknown> | undefined;
  let after: RawBuilder<SqlBool> | undefined;
  if (input.sortField !== undefined) {
    const definition = await definitionFor(trx, kind, input.sortField, '/sortField');
    if (unmatched(definition))
      throw new ValidationError([
        {
          path: '/sortField',
          code: 'unsortable_field',
          message: "A text box list or a file upload field can't be sorted on.",
        },
      ]);
    sortId = parsePublicId('field', definition.id);
    const sorted = expression(definition, 'field_sort');
    order =
      input.fieldOrder === 'desc' ? sql`${sorted} desc nulls last` : sql`${sorted} asc nulls last`;
    if (input.after !== undefined) {
      const anchor = await requireRecord(trx, input.after);
      if (anchor.kind !== kind)
        throw new ValidationError([
          {
            path: '/after',
            code: 'unknown_record',
            message: 'Start after a record in this business.',
          },
        ]);
      const previous = sql`(select ${expression(definition, 'av')} from crm.field_values av where av.business_id = ${businessId} and av.record_id = ${anchor.id} and av.field_id = ${sortId})`;
      const different =
        input.fieldOrder === 'desc' ? sql`${sorted} < ${previous}` : sql`${sorted} > ${previous}`;
      after = sql`((${sorted} is null and ${previous} is not null) or (${different}) or (${sorted} is not distinct from ${previous} and ${recordId} > ${anchor.id}::uuid))`;
    }
  }
  return { sortId, order, filter, after };
}
