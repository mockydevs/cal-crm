// The simplest part a module plays in a contact merge: rows that name a contact in one
// column, with nothing about them that can clash, move to the contact kept with one UPDATE
// each. Forms, calendar and commerce are only that; messaging, automation and ai use it for
// their plain tables beside the ones they combine.
import { requireBusiness } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

import type { ContactMergeParticipant, MergeCounts } from './merge.js';

/** A column that names a contact (by its database id), as schema.table and column. */
export interface ContactColumn {
  readonly table: string;
  readonly column: string;
}

/** Columns by the kind of row they hold, as a participant names its counts. */
export type ContactColumns = Readonly<Record<string, ContactColumn>>;

/**
 * How many rows of these contacts each column holds, counting each past `atMost` no further.
 * One statement for every kind.
 */
export async function countContactRows(
  trx: DatabaseTransaction,
  businessId: string,
  columns: ContactColumns,
  contactIds: readonly string[],
  atMost: number,
): Promise<MergeCounts> {
  const kinds = Object.entries(columns);
  if (kinds.length === 0) return {};
  const ids = sql.val(contactIds);
  const counts = kinds.map(
    ([kind, { table, column }]) => sql`(select count(*)::int from (
      select 1 from ${sql.table(table)}
      where business_id = ${businessId} and ${sql.ref(column)} = any (${ids}::uuid[])
      limit ${atMost + 1}) as rows) as ${sql.ref(kind)}`,
  );
  const { rows } = await sql<Record<string, number>>`select ${sql.join(counts)}`.execute(trx);
  return rows[0] ?? {};
}

/** Moves every row of contact `from` in each column to contact `into`. Gives how many. */
export async function moveContactRows(
  trx: DatabaseTransaction,
  businessId: string,
  columns: ContactColumns,
  move: { readonly from: string; readonly into: string },
): Promise<MergeCounts> {
  const moved: Record<string, number> = {};
  for (const [kind, { table, column }] of Object.entries(columns)) {
    const result = await sql`
      update ${sql.table(table)} set ${sql.ref(column)} = ${move.into}
      where business_id = ${businessId} and ${sql.ref(column)} = ${move.from}
    `.execute(trx);
    moved[kind] = Number(result.numAffectedRows ?? 0n);
  }
  return moved;
}

/** A module's whole part in a merge, when all it has is rows that move as they are. */
export function contactRowsParticipant(
  name: string,
  columns: ContactColumns,
): ContactMergeParticipant {
  return {
    name,
    count: (trx, invocation, contactIds, atMost) =>
      countContactRows(trx, requireBusiness(invocation.context), columns, contactIds, atMost),
    merge: (trx, command, move) =>
      moveContactRows(trx, requireBusiness(command.context), columns, move),
  };
}
