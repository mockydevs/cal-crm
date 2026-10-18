// What the "Model day" tests (tests/ai-models.spec.ts) use on their own install
// (global-setup.ts): its database, for what the product does not show, and people to sign
// in as. Its providers are local stand-ins; no test reaches a real one.
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { address, modelDay } from './servers.js';
import type { Person } from './signing-in.js';

/** Reads or writes the "Model day" install's database as crm_owner. */
export async function modelQuery<Row extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: address('modelDayDatabase') });
  await client.connect();
  try {
    return (await client.query<Row>(text, [...values])).rows;
  } finally {
    await client.end();
  }
}

/** The dashboard's address for a page of the business, such as models('/settings/ai-models'). */
export function models(path = ''): string {
  return `${address('modelDay')}/b/${modelDay.business.slug}${path}`;
}

/**
 * Someone new who works where the owner does, with the owner's role and no password yet.
 * Each has their own address, so two tests never wait for the same sign-in link.
 */
export async function newTeamMember(): Promise<Person & { readonly name: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [person] = await modelQuery<{ id: string; email: string; name: string }>(
    `with person as (
       insert into auth.users (email, name) values ($1, $2) returning id, email, name
     ), membership as (
       insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       select person.id, m.agency_id, m.business_id, m.role_id
       from person, tenancy.memberships m join auth.users u on u.id = m.user_id
       where u.email = $3
     )
     select id, email, name from person`,
    [`kai-${suffix}@fernbank.example`, `Kai ${suffix}`, modelDay.owner.email],
  );
  if (person === undefined) throw new Error('Making a person returned no row.');
  return person;
}

/**
 * Someone new on the agency's own team: agency staff, a member of the agency itself rather
 * than of one of its businesses, as whoever runs the install for its clients is.
 */
export async function newStaff(): Promise<Person> {
  const suffix = randomUUID().slice(0, 8);
  const [person] = await modelQuery<{ id: string; email: string }>(
    `with person as (
       insert into auth.users (email, name) values ($1, $2) returning id, email
     ), role as (
       insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
       select m.agency_id, 'agency', 'admin', 'Admin', true
       from tenancy.memberships m join auth.users u on u.id = m.user_id
       where u.email = $3
       on conflict (agency_id, scope, key) do update set name = excluded.name
       returning id, agency_id
     ), membership as (
       insert into tenancy.memberships (user_id, agency_id, role_id)
       select person.id, role.agency_id, role.id from person, role
     )
     select id, email from person`,
    [`staff-${suffix}@bluebird.example`, `Staff ${suffix}`, modelDay.owner.email],
  );
  if (person === undefined) throw new Error('Making a member of staff returned no row.');
  return person;
}
