import { requireBusiness, type Invocation } from '@repo/commands';
import type { FieldDefinition } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import type { CountryCode } from 'libphonenumber-js';
import { countryOf } from '../contacts/contacts.js';
import { readFields } from './fields.js';

/** Authoritative tenant metadata; values supplied by a sample cannot replace these rules. */
export interface FieldNormalizationContext {
  readonly definitions: readonly FieldDefinition[];
  readonly aliases: readonly { readonly fieldId: string; readonly key: string }[];
  readonly country: CountryCode | undefined;
}

export async function readFieldNormalizationContext(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<FieldNormalizationContext> {
  const businessId = requireBusiness(invocation.context);
  const merged = await trx
    .selectFrom('crm.field_definitions')
    .select('id')
    .where('business_id', '=', businessId)
    .where('merged_into_field_id', 'is not', null)
    .execute();
  const mergedIds = new Set(merged.map((row) => toPublicId('field', row.id)));
  const definitions = (await readFields(trx, invocation)).items.filter(
    (field) => field.mergeKey?.startsWith('contact.') === true && !mergedIds.has(field.id),
  );
  const aliases =
    definitions.length === 0
      ? []
      : await trx
          .selectFrom('crm.field_key_aliases')
          .select(['alias_key', 'field_id'])
          .where('business_id', '=', businessId)
          .where(
            'field_id',
            'in',
            definitions.map((field) => parsePublicId('field', field.id) ?? ''),
          )
          .execute();
  return {
    definitions,
    aliases: aliases.map((alias) => ({
      fieldId: toPublicId('field', alias.field_id),
      key: alias.alias_key,
    })),
    country: await countryOf(trx, businessId),
  };
}
