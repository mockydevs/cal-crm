import type { DatabaseTransaction } from '@repo/db';

/**
 * Each person's shown name, by user id: the account's name, else its address. The auth
 * module's own port (readUserNames) also reads a profile's first and last name; this
 * module's tests only need a name that comes from the person.
 */
export async function readTestNames(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('auth.users')
    .select(['id', 'name', 'email'])
    .where('id', 'in', [...ids])
    .execute();
  return new Map(rows.map((row) => [row.id, row.name.trim() === '' ? row.email : row.name]));
}
