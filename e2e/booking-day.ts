// What the "Booking day" tests (tests/checkpoint-1d.spec.ts) use on their own install
// (global-setup.ts): its database, for what the product does not show, and people to sign
// in as. The mail server is the test run's own (inbox-day.ts).
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { address, bookingDay } from './servers.js';
import type { Person } from './signing-in.js';

/** Reads or writes the "Booking day" install's database as crm_owner. */
export async function stayQuery<Row extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: address('bookingDayDatabase') });
  await client.connect();
  try {
    return (await client.query<Row>(text, [...values])).rows;
  } finally {
    await client.end();
  }
}

/** The dashboard's address for a page of the business, such as stay('/calendar'). */
export function stay(path = ''): string {
  return `${address('bookingDay')}/b/${bookingDay.business.slug}${path}`;
}

/**
 * Someone new who works where the owner does, with the owner's role and no password yet.
 * Each has their own address, so two tests never wait for the same sign-in link.
 */
export async function newTeamMember(): Promise<Person & { readonly name: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [person] = await stayQuery<{ id: string; email: string; name: string }>(
    `with person as (
       insert into auth.users (email, name) values ($1, $2) returning id, email, name
     ), membership as (
       insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       select person.id, m.agency_id, m.business_id, m.role_id
       from person, tenancy.memberships m join auth.users u on u.id = m.user_id
       where u.email = $3
     )
     select id, email, name from person`,
    [`robin-${suffix}@juniperhall.example`, `Robin ${suffix}`, bookingDay.owner.email],
  );
  if (person === undefined) throw new Error('Making a person returned no row.');
  return person;
}
