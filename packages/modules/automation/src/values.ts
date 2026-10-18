// A contact's current values by canonical path (contact.firstName, contact.custom.<key>),
// as conditions read them. Field values keep their stored type; dates become ISO strings.
// Where the contact came from is among them: its first and latest touch, as
// contact.attribution.first.* and contact.attribution.latest.* (attribution-values.ts).
// A custom field is also under its merge key (contact.<key>), and the business's custom
// values are under theirs (custom_values.<key>, values.<key>): what a message fills in.
import {
  contactFieldPaths,
  customValuePaths,
  type ConditionValue,
  type ConditionValues,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { emailVerificationState } from '@repo/module-messaging';
import { sql } from 'kysely';

import { contactAttributionValues } from './attribution-values.js';

/** A record's current values by canonical path, for trigger conditions. */
export type ValuesOf = (trx: DatabaseTransaction, recordId: string) => Promise<ConditionValues>;

/**
 * The business's custom values by every path a message may write them under. A value with
 * nothing in it is left out: a send that uses it stops, as for any field without a value,
 * and readTemplateFields names it as one no send can fill in.
 */
export async function customValuesByPath(
  trx: DatabaseTransaction,
): Promise<Record<string, string>> {
  const rows = await trx.selectFrom('crm.custom_values').select(['key', 'value']).execute();
  const values: Record<string, string> = {};
  for (const row of rows)
    if (row.value.trim() !== '')
      for (const path of customValuePaths(row.key)) values[path] = row.value;
  return values;
}

/** A custom field's stored value, of whichever type the field keeps. */
export function storedFieldValue(row: {
  readonly value_text: string | null;
  readonly value_number: string | number | null;
  /** The day as YYYY-MM-DD, read as text so no time zone moves it. */
  readonly value_date: string | null;
  readonly value_datetime: Date | null;
  readonly value_bool: boolean | null;
  readonly value_options: readonly string[] | null;
}): ConditionValue {
  return (
    row.value_text ??
    (row.value_number === null ? null : Number(row.value_number)) ??
    row.value_date ??
    row.value_datetime?.toISOString() ??
    row.value_bool ??
    row.value_options
  );
}

/** The paths of a deal's own values, each null for a run with no deal in hand. */
export const NO_DEAL: Readonly<Record<string, ConditionValue>> = {
  'deal.name': null,
  'deal.status': null,
  'deal.pipeline': null,
  'deal.stage': null,
  'deal.value': null,
  'deal.amount': null,
  'deal.currency': null,
  'deal.source': null,
  'deal.expectedCloseDate': null,
  'deal.createdAt': null,
  'deal.closedAt': null,
};

/**
 * A deal's current values by path, as conditions and merge fields read the deal a run has
 * in hand: deal.name, deal.status (open, won or lost), deal.pipeline and deal.stage by
 * name, deal.value (and deal.amount, the same number), and its custom fields as
 * deal.custom.<key>. Nothing for a record that is not a deal, or one in the trash.
 */
export async function dealValues(
  trx: DatabaseTransaction,
  dealId: string,
): Promise<Record<string, ConditionValue>> {
  const deal = await trx
    .selectFrom('crm.deals as deal')
    .innerJoin('crm.pipelines as pipeline', (join) =>
      join
        .onRef('pipeline.business_id', '=', 'deal.business_id')
        .onRef('pipeline.id', '=', 'deal.pipeline_id'),
    )
    .innerJoin('crm.pipeline_stages as stage', (join) =>
      join
        .onRef('stage.business_id', '=', 'deal.business_id')
        .onRef('stage.id', '=', 'deal.stage_id'),
    )
    .select([
      'deal.name',
      'deal.status',
      'deal.amount',
      'deal.currency',
      'deal.source',
      'deal.created_at',
      'deal.closed_at',
      'pipeline.name as pipeline_name',
      'stage.name as stage_name',
      sql<string | null>`to_char(deal.expected_close_date, 'YYYY-MM-DD')`.as('expected_close_date'),
    ])
    .where('deal.id', '=', dealId)
    .where('deal.deleted_at', 'is', null)
    .executeTakeFirst();
  if (deal === undefined) return {};
  const amount = deal.amount === null ? null : Number(deal.amount);
  const values: Record<string, ConditionValue> = {
    'deal.name': deal.name,
    'deal.status': deal.status,
    'deal.pipeline': deal.pipeline_name,
    'deal.stage': deal.stage_name,
    'deal.value': amount,
    'deal.amount': amount,
    'deal.currency': deal.currency,
    'deal.source': deal.source,
    'deal.expectedCloseDate': deal.expected_close_date,
    'deal.createdAt': deal.created_at.toISOString(),
    'deal.closedAt': deal.closed_at?.toISOString() ?? null,
  };
  const custom = await trx
    .selectFrom('crm.field_values as value')
    .innerJoin('crm.field_definitions as field', 'field.id', 'value.field_id')
    .select([
      'field.key',
      'value.value_text',
      'value.value_number',
      sql<string | null>`to_char(value.value_date, 'YYYY-MM-DD')`.as('value_date'),
      'value.value_datetime',
      'value.value_bool',
      'value.value_options',
    ])
    .where('value.record_id', '=', dealId)
    .where('field.archived_at', 'is', null)
    .execute();
  for (const row of custom) values[`deal.custom.${row.key}`] = storedFieldValue(row);
  return values;
}

export async function contactValues(
  trx: DatabaseTransaction,
  recordId: string,
): Promise<ConditionValues> {
  const contact = await trx
    .selectFrom('crm.contacts')
    .select([
      'first_name',
      'last_name',
      'display_name',
      'source',
      'contact_type',
      'created_at',
      'updated_at',
    ])
    .where('id', '=', recordId)
    .executeTakeFirst();
  // Custom values are the business's, whatever the record is; a deal has its own values
  // besides, as a run that is for a deal reads them (deal.name, deal.stage and the rest).
  if (contact === undefined)
    return { ...(await customValuesByPath(trx)), ...(await dealValues(trx, recordId)) };
  const identities = await trx
    .selectFrom('crm.contact_identities')
    .select(['kind', 'value_normalized'])
    .where('contact_id', '=', recordId)
    .where('is_primary', '=', true)
    .execute();
  const tags = await trx
    .selectFrom('crm.record_tags as assigned')
    .innerJoin('crm.tags as tag', 'tag.id', 'assigned.tag_id')
    .select('tag.name')
    .where('assigned.record_id', '=', recordId)
    .execute();
  const custom = await trx
    .selectFrom('crm.field_values as value')
    .innerJoin('crm.field_definitions as field', 'field.id', 'value.field_id')
    .select([
      'field.id',
      'field.key',
      'value.value_text',
      'value.value_number',
      sql<string | null>`to_char(value.value_date, 'YYYY-MM-DD')`.as('value_date'),
      'value.value_datetime',
      'value.value_bool',
      'value.value_options',
    ])
    .where('value.record_id', '=', recordId)
    .where('field.archived_at', 'is', null)
    .execute();
  const email = identities.find((each) => each.kind === 'email')?.value_normalized ?? null;
  // What email verification found of the primary address (GoHighLevel's isEmailVerified):
  // nothing without an address, unchecked before any check, excluded when left out.
  const verification = email === null ? null : await emailVerificationState(trx, email);
  const values: Record<string, ConditionValue> = {
    'contact.firstName': contact.first_name,
    'contact.lastName': contact.last_name,
    'contact.name': contact.display_name,
    'contact.email': email,
    'contact.emailVerification': verification,
    'contact.emailVerified': email === null ? null : verification === 'valid',
    'contact.phone': identities.find((each) => each.kind === 'phone')?.value_normalized ?? null,
    'contact.tags': tags.map((tag) => tag.name),
    // Where the contact came from, in the business's own words, and lead or customer.
    'contact.source': contact.source,
    'contact.type': contact.contact_type,
    'contact.createdAt': contact.created_at.toISOString(),
    'contact.updatedAt': contact.updated_at.toISOString(),
  };
  // A key a merged field left behind reads the field that survived it (DATABASE.md 6.2).
  const aliases =
    custom.length === 0
      ? []
      : await trx
          .selectFrom('crm.field_key_aliases')
          .select(['alias_key', 'field_id'])
          .where(
            'field_id',
            'in',
            custom.map((row) => row.id),
          )
          .execute();
  const stored = new Map<string, ConditionValue>();
  for (const row of custom) stored.set(row.id, storedFieldValue(row));
  // Aliases first, so that a field's own key is never read as another field's old one.
  for (const alias of aliases)
    for (const path of contactFieldPaths(alias.alias_key))
      values[path] = stored.get(alias.field_id) ?? null;
  for (const row of custom)
    for (const path of contactFieldPaths(row.key)) values[path] = stored.get(row.id) ?? null;
  return {
    ...(await customValuesByPath(trx)),
    ...(await contactAttributionValues(trx, recordId)),
    ...values,
  };
}
