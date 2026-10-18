// What the task commands and recurring series both read: the options the server supplies,
// a stored task as read with its version, and the records tasks belong to, by name.
import { recordKinds, type Task } from '@repo/contracts';
import type { DatabaseTransaction, DB } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { sql, type Selectable } from 'kysely';
import type { ActorNames } from '../activity/activity.js';

/** Public dependencies supplied by the modules that own memberships and actor names. */
export interface TaskOptions {
  readonly actorNames: ActorNames;
  readonly assignees: {
    readonly resolve: (
      trx: DatabaseTransaction,
      context: TenantContext,
      selection: string | null,
    ) => Promise<string | null>;
    readonly read: (
      trx: DatabaseTransaction,
      context: TenantContext,
      after?: string,
    ) => Promise<{
      readonly items: readonly { readonly id: string; readonly userId: string }[];
      readonly nextCursor: string | null;
    }>;
    readonly memberships: (
      trx: DatabaseTransaction,
      context: TenantContext,
      userIds: readonly string[],
    ) => Promise<ReadonlyMap<string, string>>;
  };
}

export type TaskRow = Selectable<DB['crm.tasks']> & { version: string };
export const version = sql<string>`extract(epoch from updated_at)::text`.as('version');
/**
 * Contacts, companies and deals by id, as far as the reader sees them: the kind, the name
 * now (null for one that has none) and whether it is in the trash.
 */
export function recordNames(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<
  {
    readonly id: string;
    readonly kind: string;
    readonly name: string | null;
    readonly trashed: boolean;
  }[]
> {
  return trx
    .selectFrom('crm.records as r')
    .leftJoin('crm.contacts as c', (join) =>
      join.onRef('c.business_id', '=', 'r.business_id').onRef('c.id', '=', 'r.id'),
    )
    .leftJoin('crm.companies as company', (join) =>
      join.onRef('company.business_id', '=', 'r.business_id').onRef('company.id', '=', 'r.id'),
    )
    .leftJoin('crm.deals as d', (join) =>
      join.onRef('d.business_id', '=', 'r.business_id').onRef('d.id', '=', 'r.id'),
    )
    .select(['r.id', 'r.kind'])
    .select(
      sql<string | null>`case r.kind when 'contact' then coalesce(c.display_name, (
        select i.value_normalized from crm.contact_identities i
        where i.business_id = c.business_id and i.contact_id = c.id and i.is_primary
        order by i.kind limit 1))
        when 'company' then company.name when 'deal' then d.name end`.as('name'),
    )
    .select(
      sql<boolean>`case r.kind when 'contact' then c.deleted_at is not null
        when 'company' then company.deleted_at is not null
        when 'deal' then d.deleted_at is not null else true end`.as('trashed'),
    )
    .where('r.id', 'in', [...ids])
    .execute();
}

/** Each task's record as the list shows it: its id, its name now and whether it is in the trash. */
export async function recordsOf(
  trx: DatabaseTransaction,
  rows: readonly Pick<TaskRow, 'record_id'>[],
): Promise<Map<string, NonNullable<Task['record']>>> {
  const ids = [...new Set(rows.flatMap((row) => (row.record_id === null ? [] : [row.record_id])))];
  const records = new Map<string, NonNullable<Task['record']>>();
  if (ids.length === 0) return records;
  const found = await recordNames(trx, ids);
  for (const row of found) {
    const kind = recordKinds.find((each) => each === row.kind);
    if (kind === undefined || row.name === null) throw new TypeError('Unsupported task record.');
    records.set(row.id, { id: toPublicId(kind, row.id), name: row.name, trashed: row.trashed });
  }
  return records;
}
