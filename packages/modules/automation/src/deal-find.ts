// deal.find: the newest or the oldest of a contact's deals that pass every filter the step
// gives. A deal is the contact's through the CRM's deal_contact link, as the contact's own
// page lists them; one in the trash is not found. One query, read under the tenant's
// row-level security.
import { requireBusiness, type CommandContext } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { sql, type SqlBool } from 'kysely';

/** The CRM's link between a deal and the contacts it is with (crm/deals/link-type.ts). */
const DEAL_CONTACT_LINK = 'deal_contact';

/** A deal.find step's settings, as the validator leaves them: references are ids. */
export interface DealSearch {
  readonly which: 'newest' | 'oldest';
  readonly pipeline?: string | undefined;
  readonly stage?: string | undefined;
  readonly status?: 'open' | 'won' | 'lost' | 'any' | undefined;
  readonly nameContains?: string | undefined;
  readonly value?:
    | { readonly operator: 'equals' | 'greater_than' | 'less_than'; readonly value: number }
    | undefined;
  readonly customField?:
    { readonly field: string; readonly equals: string | number | boolean } | undefined;
}

export interface FoundDeal {
  /** The deal's stored id. */
  readonly id: string;
  readonly name: string;
}

const CUSTOM = 'deal.custom.';

/** The filters in words, for the step's explanation. */
export function searchWords(search: DealSearch): string {
  const filters = [
    search.status === undefined || search.status === 'any' ? undefined : `status ${search.status}`,
    search.pipeline === undefined ? undefined : 'the pipeline',
    search.stage === undefined ? undefined : 'the stage',
    search.nameContains === undefined ? undefined : `a name containing "${search.nameContains}"`,
    search.value === undefined
      ? undefined
      : `a value ${search.value.operator.replace('_', ' ')} ${String(search.value.value)}`,
    search.customField === undefined
      ? undefined
      : `${search.customField.field} equal to ${String(search.customField.equals)}`,
  ].filter((each): each is string => each !== undefined);
  return filters.length === 0 ? 'no filter' : filters.join(', ');
}

/** The deal the step finds for the contact, or nothing when none passes its filters. */
export async function findStepDeal(
  trx: DatabaseTransaction,
  command: Pick<CommandContext, 'context'>,
  contactId: string,
  search: DealSearch,
): Promise<FoundDeal | undefined> {
  const businessId = requireBusiness(command.context);
  // A reference that is not an id of its kind names nothing this business has.
  const pipelineId =
    search.pipeline === undefined ? undefined : parsePublicId('pipeline', search.pipeline);
  const stageId = search.stage === undefined ? undefined : parsePublicId('stage', search.stage);
  if (
    (search.pipeline !== undefined && pipelineId === undefined) ||
    (search.stage !== undefined && stageId === undefined)
  )
    return undefined;
  const custom = search.customField;
  if (custom !== undefined && !custom.field.startsWith(CUSTOM)) return undefined;
  let query = trx
    .selectFrom('crm.record_links as link')
    .innerJoin('crm.link_types as type', (join) =>
      join
        .onRef('type.business_id', '=', 'link.business_id')
        .onRef('type.id', '=', 'link.link_type_id'),
    )
    .innerJoin('crm.deals as deal', (join) =>
      join
        .onRef('deal.business_id', '=', 'link.business_id')
        .onRef('deal.id', '=', 'link.from_record_id'),
    )
    .select(['deal.id', 'deal.name'])
    .where('link.business_id', '=', businessId)
    .where('link.to_record_id', '=', contactId)
    .where('type.key', '=', DEAL_CONTACT_LINK)
    .where('deal.deleted_at', 'is', null);
  if (pipelineId !== undefined) query = query.where('deal.pipeline_id', '=', pipelineId);
  if (stageId !== undefined) query = query.where('deal.stage_id', '=', stageId);
  if (search.status !== undefined && search.status !== 'any')
    query = query.where('deal.status', '=', search.status);
  if (search.nameContains !== undefined)
    query = query.where(
      sql<SqlBool>`position(lower(${search.nameContains}) in lower(deal.name)) > 0`,
    );
  if (search.value !== undefined)
    query = query.where(
      'deal.amount',
      search.value.operator === 'equals'
        ? '='
        : search.value.operator === 'greater_than'
          ? '>'
          : '<',
      String(search.value.value),
    );
  if (custom !== undefined) {
    const key = custom.field.slice(CUSTOM.length);
    const wanted = custom.equals;
    // A value is kept in the column of its field's kind; a choice is kept by its key.
    const holds =
      typeof wanted === 'number'
        ? sql<SqlBool>`held.value_number = ${String(wanted)}::numeric`
        : typeof wanted === 'boolean'
          ? sql<SqlBool>`held.value_bool = ${wanted}`
          : sql<SqlBool>`(held.value_text = ${wanted} or ${wanted} = any(held.value_options)
              or held.value_date::text = ${wanted})`;
    query = query.where(
      sql<SqlBool>`exists (
        select 1 from crm.field_values held
        join crm.field_definitions field
          on field.business_id = held.business_id and field.id = held.field_id
        where held.business_id = deal.business_id and held.record_id = deal.id
          and field.key = ${key} and field.archived_at is null and ${holds})`,
    );
  }
  const direction = search.which === 'oldest' ? 'asc' : 'desc';
  return query
    .orderBy('deal.created_at', direction)
    .orderBy('deal.id', direction)
    .limit(1)
    .executeTakeFirst();
}
