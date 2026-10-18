import { createHash } from 'node:crypto';
import type { Invocation } from '@repo/commands';
import {
  recordField,
  textListValue,
  type RecordField,
  type FieldDefinition,
} from '@repo/contracts';
import type { DB } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import type { Selectable } from 'kysely';

export type ValueRow = Selectable<DB['crm.field_values']> & { date_text: string | null };
function valueOf(row: ValueRow): RecordField['value'] {
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
    // The files' ids, as the API names files.
    case 'file':
      return row.value_options?.map((id) => toPublicId('file', id)) ?? null;
    default:
      return row.value_text;
  }
}

export function presentValue(
  definition: FieldDefinition,
  row: ValueRow | undefined,
  invocation: Invocation,
  names: ReadonlyMap<string, string> = new Map(),
): RecordField {
  const data = {
    definition,
    value: row === undefined ? null : valueOf(row),
    source:
      row === undefined
        ? null
        : {
            kind: row.source_kind,
            name: names.get(`${row.source_kind}:${row.source_id ?? ''}`) ?? null,
            eventId: row.source_event_id === null ? null : toPublicId('event', row.source_event_id),
            you:
              row.source_kind === 'user' &&
              invocation.context.userId !== undefined &&
              row.source_id === invocation.context.userId,
          },
    updatedAt: row?.updated_at.toISOString() ?? null,
    confidence: row?.confidence ?? null,
    confirmedAt: row?.confirmed_at?.toISOString() ?? null,
    confirmedBy:
      row?.confirmed_by_id === null || row?.confirmed_by_id === undefined
        ? null
        : {
            name: names.get(`user:${row.confirmed_by_id}`) ?? null,
            you: row.confirmed_by_id === invocation.context.userId,
          },
  };
  // Exclude viewer-specific `you`; bind revisions to saved configuration and provenance.
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        definition: definition.revision,
        value: data.value,
        sourceKind: row?.source_kind ?? null,
        sourceId: row?.source_id ?? null,
        eventId: row?.source_event_id ?? null,
        updatedAt: data.updatedAt,
        confidence: data.confidence,
        confirmedAt: data.confirmedAt,
        confirmedBy: row?.confirmed_by_id ?? null,
      }),
    )
    .digest('hex');
  return recordField.parse({ ...data, revision });
}
