// Which fields a stored event changed, and what each holds now, for the field.changed
// trigger, a goal's field.changed event and the stops and waits that listen for one. The
// CRM's events name the field and never its value (events can't be erased, DATABASE.md
// section 10), so both are read here, once, when the event is matched.
import type { ConditionValues } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { contactFieldsChanged, FIELD_CHANGE_EVENTS, type FieldChange } from './triggers.js';
import { storedFieldValue } from './values.js';

/** Whether an event of this type is one that says a field changed. */
export const isFieldChangeEvent = (type: string): boolean =>
  (FIELD_CHANGE_EVENTS as readonly string[]).includes(type);

/** The event as the reader needs it: the stored row's own columns. */
export interface FieldChangeEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The record whose field changed: the event's subject. */
  readonly subject_id: string;
}

/**
 * The fields the event changed, by every path a document may name each with. None for an
 * event that changed nothing a document can name: a field of a company or a custom object, a
 * field that is gone, or a contact's time zone.
 */
export async function readFieldChanges(
  trx: DatabaseTransaction,
  event: FieldChangeEvent,
  /** The record's current values, read only for a contact's own fields. */
  valuesOf: (recordId: string) => Promise<ConditionValues>,
): Promise<readonly FieldChange[]> {
  if (event.type === 'contact.updated') {
    const paths = contactFieldsChanged(event.payload['changed']);
    if (paths.length === 0) return [];
    // The contact's row keeps no word of which event wrote it, so the value is the one the
    // contact has now: an update made since, and not yet matched, is already in it.
    const values = await valuesOf(event.subject_id);
    return paths.map((field) => ({ field, value: values[field] ?? null }));
  }
  const given = event.payload['fieldId'];
  const fieldId = typeof given === 'string' ? parsePublicId('field', given) : undefined;
  if (fieldId === undefined) return [];
  const field = await trx
    .selectFrom('crm.field_definitions as field')
    .innerJoin('crm.object_types as type', 'type.id', 'field.object_type_id')
    .select(['field.key', 'type.kind'])
    .where('field.id', '=', fieldId)
    .where('type.kind', 'in', ['contact', 'deal'])
    .executeTakeFirst();
  if (field === undefined) return [];
  // A key a merged field left behind names the field that survived it (DATABASE.md 6.2).
  const aliases = await trx
    .selectFrom('crm.field_key_aliases')
    .select('alias_key')
    .where('field_id', '=', fieldId)
    .orderBy('alias_key')
    .execute();
  const paths = [field.key, ...aliases.map((alias) => alias.alias_key)].map(
    (key) => `${field.kind}.custom.${key}`,
  );
  if (event.type === 'field.value_cleared')
    return paths.map((path) => ({ field: path, value: null }));
  // A value names the event that wrote it. One written since by a later event is not this
  // event's, and what this event set is then no longer known.
  const stored = await trx
    .selectFrom('crm.field_values')
    .select([
      'value_text',
      'value_number',
      sql<string | null>`to_char(value_date, 'YYYY-MM-DD')`.as('value_date'),
      'value_datetime',
      'value_bool',
      'value_options',
    ])
    .where('record_id', '=', event.subject_id)
    .where('field_id', '=', fieldId)
    .where('source_event_id', '=', event.id)
    .executeTakeFirst();
  return paths.map((path) =>
    stored === undefined ? { field: path } : { field: path, value: storedFieldValue(stored) },
  );
}
