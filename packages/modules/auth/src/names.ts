// People's names, for whatever shows who did something, such as a record's activity. The
// auth module owns auth.users, so other modules name people through this.
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

/**
 * Each person's name, or their email address when they've given no name, by id. The name
 * the reader's agency keeps for the person (Settings → Users) comes first: row-level
 * security shows this agency's profile and no other's. Run in the reader's tenant
 * transaction: people the reader can't see (row-level security on auth.users) are left out.
 */
export async function readUserNames(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await trx
    .selectFrom('auth.users as person')
    .leftJoin('tenancy.user_profiles as profile', 'profile.user_id', 'person.id')
    .select([
      'person.id',
      sql<string>`coalesce(
        nullif(btrim(coalesce(profile.first_name, '') || ' ' || coalesce(profile.last_name, '')), ''),
        nullif(btrim(person.name), ''),
        person.email)`.as('name'),
    ])
    .where('person.id', '=', sql<string>`any(${[...ids]}::uuid[])`)
    .execute();
  return new Map(rows.map((row) => [row.id, row.name]));
}
