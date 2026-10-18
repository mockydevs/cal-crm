// Custom fields as columns of the contact list. A page names the fields its table shows;
// their values are one read for the whole page, by the page's ids and those fields alone,
// so a page costs what its visible columns need and no more. A value is answered as the
// record's own field list answers it.
import { textListValue, type ContactSummary } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError, type Issue } from '@repo/kernel';
import { sql } from 'kysely';

type Values = NonNullable<ContactSummary['fields']>;
type Value = Values[string];

interface ValueRow {
  readonly value_type: string;
  readonly value_text: string | null;
  readonly value_number: string | null;
  readonly date_text: string | null;
  readonly value_datetime: Date | null;
  readonly value_bool: boolean | null;
  readonly value_options: string[] | null;
  readonly value_json: unknown;
}

/** A stored value as the API shows it (the same forms as fields/value-presenter.ts). */
function valueOf(row: ValueRow): Value {
  switch (row.value_type) {
    case 'number':
    case 'money':
      return row.value_number;
    case 'date':
      return row.date_text;
    case 'datetime':
      return row.value_datetime?.toISOString() ?? null;
    case 'boolean':
      return row.value_bool;
    case 'single_choice':
      return row.value_options?.[0] ?? null;
    case 'multi_choice':
      return row.value_options;
    case 'text_list':
      return textListValue.parse(row.value_json);
    case 'file':
      return row.value_options?.map((id) => toPublicId('file', id)) ?? null;
    default:
      return row.value_text;
  }
}

/**
 * Checks the fields a page names, and answers a reader of their values for a page's
 * contacts. A field that is not a contact field of this business is refused, each with its
 * place in `fields`. With no field named, a row gains nothing.
 */
export async function readListFields(
  trx: DatabaseTransaction,
  businessId: string,
  named: readonly string[],
): Promise<(ids: readonly string[]) => Promise<(id: string) => Pick<ContactSummary, 'fields'>>> {
  if (named.length === 0) return () => Promise.resolve(() => ({}));
  const fieldIds = named.map((id) => parsePublicId('field', id) ?? '');
  const known = await trx
    .selectFrom('crm.field_definitions as f')
    .innerJoin('crm.object_types as o', (join) =>
      join.onRef('o.id', '=', 'f.object_type_id').onRef('o.business_id', '=', 'f.business_id'),
    )
    .select('f.id')
    .where('f.business_id', '=', businessId)
    .where('f.id', 'in', fieldIds)
    .where('o.kind', '=', 'contact')
    .where('f.merged_into_field_id', 'is', null)
    .execute();
  const have = new Set(known.map((row) => row.id));
  const issues = fieldIds.flatMap((id, index): Issue[] =>
    have.has(id)
      ? []
      : [
          {
            path: '/fields',
            code: 'unknown_field',
            message: `Field ${String(index + 1)} is not a field of contacts in this business.`,
          },
        ],
  );
  const [first, ...rest] = issues;
  if (first !== undefined) throw new ValidationError([first, ...rest]);

  return async (ids) => {
    const byContact = new Map<string, Values>();
    if (ids.length > 0) {
      const rows = await trx
        .selectFrom('crm.field_values as fv')
        .select([
          'fv.record_id',
          'fv.field_id',
          'fv.value_type',
          'fv.value_text',
          'fv.value_number',
          'fv.value_datetime',
          'fv.value_bool',
          'fv.value_options',
          'fv.value_json',
        ])
        .select(sql<string | null>`fv.value_date::text`.as('date_text'))
        .where('fv.business_id', '=', businessId)
        .where('fv.record_id', 'in', [...ids])
        .where('fv.field_id', 'in', fieldIds)
        .execute();
      for (const row of rows) {
        const values = byContact.get(row.record_id) ?? {};
        values[toPublicId('field', row.field_id)] = valueOf(row);
        byContact.set(row.record_id, values);
      }
    }
    return (id) => ({
      fields: Object.fromEntries(named.map((field) => [field, byContact.get(id)?.[field] ?? null])),
    });
  };
}
