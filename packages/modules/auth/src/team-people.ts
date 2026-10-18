import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

/**
 * Identity stays owned by auth; the caller's tenant transaction/RLS limits visibility. The
 * name is the one the caller's agency keeps for the person (Settings → Users) when it keeps
 * one, else the account's, else the address.
 */
export async function readTeamPeople(
  trx: DatabaseTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, { name: string; email: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('auth.users as person')
    .leftJoin('tenancy.user_profiles as profile', 'profile.user_id', 'person.id')
    .select([
      'person.id',
      'person.email',
      sql<string>`coalesce(
        nullif(btrim(coalesce(profile.first_name, '') || ' ' || coalesce(profile.last_name, '')), ''),
        nullif(btrim(person.name), ''),
        person.email)`.as('name'),
    ])
    .where('person.id', 'in', [...ids])
    .execute();
  return new Map(rows.map((row) => [row.id, { name: row.name, email: row.email }]));
}
