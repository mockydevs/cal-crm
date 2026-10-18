import { requireBusiness, type Invocation } from '@repo/commands';
import type { TenantContext } from '@repo/kernel';
import type { RecordField } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

import { requireRecord } from '../records/access.js';
import { asField } from './fields.js';
import { presentValue } from './value-presenter.js';
import { requireValueDefinition } from './value-writes.js';

/**
 * Nobody in particular: a value's revision leaves out what depends on the viewer, so a
 * reader that only wants the revision needs no viewer.
 */
const NOBODY: TenantContext = { agencyId: '', actorKind: 'system', correlationId: '' };

/**
 * A saved value as the record editor would be given it, for no viewer in particular, read
 * in the caller's tenant transaction (which is what holds it to the one business).
 */
export async function readSavedRecordField(
  trx: DatabaseTransaction,
  recordId: string,
  fieldId: string,
): Promise<RecordField> {
  const record = await requireRecord(trx, recordId);
  const definition = await requireValueDefinition(trx, record.objectTypeId, fieldId);
  const row = await trx
    .selectFrom('crm.field_values')
    .selectAll()
    .select(sql<string | null>`value_date::text`.as('date_text'))
    .where('record_id', '=', record.id)
    .where('field_id', '=', definition.id)
    .executeTakeFirst();
  return presentValue(asField(definition), row, { context: NOBODY, permissions: new Set() });
}

/** Reads the same value and revision as the record editor, inside the caller's tenant transaction. */
export async function readRecordField(
  trx: DatabaseTransaction,
  invocation: Invocation,
  recordId: string,
  fieldId: string,
): Promise<RecordField> {
  requireBusiness(invocation.context);
  const record = await requireRecord(trx, recordId);
  const definition = await requireValueDefinition(trx, record.objectTypeId, fieldId);
  const row = await trx
    .selectFrom('crm.field_values')
    .selectAll()
    .select(sql<string | null>`value_date::text`.as('date_text'))
    .where('record_id', '=', record.id)
    .where('field_id', '=', definition.id)
    .executeTakeFirst();
  return presentValue(asField(definition), row, invocation);
}
