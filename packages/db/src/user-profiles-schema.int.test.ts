// Migration 0073: what an agency keeps about a person on its team, the details an
// invitation carries, and a membership's default calendar.
import { randomUUID } from 'node:crypto';

import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

const person = async (): Promise<string> => {
  const { id } = await database.as('postgres', (sql) =>
    sql.one<{ id: string }>(
      `insert into auth.users (email, name) values ($1, 'Ada Lovelace') returning id`,
      [`${randomUUID()}@example.test`],
    ),
  );
  return id;
};

it("keeps a person's profile inside the agency that wrote it", async () => {
  const first = await database.fixtures.agency();
  const second = await database.fixtures.agency();
  const firstBusiness = await database.fixtures.business(first.id);
  const secondBusiness = await database.fixtures.business(second.id);
  const user = await person();
  await database.withTenant(firstBusiness.context, (sql) =>
    sql.query(
      `insert into tenancy.user_profiles (agency_id, user_id, first_name, last_name, phone_e164)
       values ($1, $2, 'Ada', 'Lovelace', '+254712345678')`,
      [first.id, user],
    ),
  );
  expect(
    await database.withTenant(secondBusiness.context, (sql) =>
      sql.query('select first_name from tenancy.user_profiles'),
    ),
  ).toEqual([]);
  // The other agency keeps its own, and cannot write the first one's.
  await database.withTenant(secondBusiness.context, (sql) =>
    sql.query(
      `insert into tenancy.user_profiles (agency_id, user_id, first_name) values ($1, $2, 'A.')`,
      [second.id, user],
    ),
  );
  const stranger = await person();
  await expect(
    database.withTenant(secondBusiness.context, (sql) =>
      sql.query(
        `insert into tenancy.user_profiles (agency_id, user_id, first_name) values ($1, $2, 'X')`,
        [first.id, stranger],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  expect(
    await database.withTenant(firstBusiness.context, (sql) =>
      sql.query('select first_name, phone_e164 from tenancy.user_profiles'),
    ),
  ).toEqual([{ first_name: 'Ada', phone_e164: '+254712345678' }]);
  await expect(
    database.withTenant(firstBusiness.context, (sql) =>
      sql.query(
        `insert into tenancy.user_profiles (agency_id, user_id, first_name) values ($1, $2, 'Again')`,
        [first.id, user],
      ),
    ),
  ).rejects.toMatchObject({ code: '23505' });
});

it('refuses a phone that is not E.164, an extension without a phone, and overlong names', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const write = async (columns: string, values: string) => {
    const user = await person();
    return database.withTenant(business.context, (sql) =>
      sql.query(
        `insert into tenancy.user_profiles (agency_id, user_id, ${columns}) values ($1, $2, ${values})`,
        [agency.id, user],
      ),
    );
  };
  for (const phone of ["'0712345678'", "'+0712345678'", "'+1 305 555 0123'", "'+12'"])
    await expect(write('phone_e164', phone)).rejects.toMatchObject({ code: '23514' });
  await expect(write('phone_extension', "'204'")).rejects.toMatchObject({ code: '23514' });
  await expect(
    write('phone_e164, phone_extension', "'+13055550123', 'x204'"),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(write('first_name', "repeat('a', 101)")).rejects.toMatchObject({ code: '23514' });
  await expect(write('signature', `'[]'::jsonb`)).rejects.toMatchObject({ code: '23514' });
  await write('phone_e164, phone_extension', "'+13055550123', '204'");
});

/** A business role of the agency: the fixtures make an agency without its roles. */
const memberRole = async (agencyId: string): Promise<string> => {
  const { id } = await database.as('postgres', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name)
       values ($1, 'business', 'member', 'Member') returning id`,
      [agencyId],
    ),
  );
  return id;
};

it('lets go of a profile image when its file is removed, and refuses another agency’s file', async () => {
  const agency = await database.fixtures.agency();
  const other = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const file = (agencyId: string) =>
    database.as('postgres', (sql) =>
      sql.one<{ id: string }>(
        `insert into files.files
           (agency_id, storage, storage_key, filename, content_type, size_bytes, sha256, uploaded_by_kind)
         values ($1, 'local', $2::text, 'ada.png', 'image/png', 1024, sha256($2::text::bytea), 'system')
         returning id`,
        [agencyId, randomUUID()],
      ),
    );
  const mine = await file(agency.id);
  const theirs = await file(other.id);
  const user = await person();
  await expect(
    database.as('postgres', (sql) =>
      sql.query(
        `insert into tenancy.user_profiles (agency_id, user_id, avatar_file_id) values ($1, $2, $3)`,
        [agency.id, user, theirs.id],
      ),
    ),
  ).rejects.toMatchObject({ code: '23503' });
  await database.withTenant(business.context, (sql) =>
    sql.query(
      `insert into tenancy.user_profiles (agency_id, user_id, first_name, avatar_file_id)
       values ($1, $2, 'Ada', $3)`,
      [agency.id, user, mine.id],
    ),
  );
  await database.as('postgres', (sql) =>
    sql.query('delete from files.files where id = $1', [mine.id]),
  );
  expect(
    await database.withTenant(business.context, (sql) =>
      sql.query('select first_name, avatar_file_id from tenancy.user_profiles where user_id = $1', [
        user,
      ]),
    ),
  ).toEqual([{ first_name: 'Ada', avatar_file_id: null }]);
});

it('carries a person’s details on an invitation, as an object', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const role = await memberRole(agency.id);
  const invite = (profile: string) =>
    database.withTenant(business.context, (sql) =>
      sql.query<{ profile: unknown }>(
        `insert into tenancy.invitations
           (agency_id, business_id, email, role_id, token_hash, expires_at, profile)
         values ($1, $2, $3::text, $5, sha256($3::text::bytea), now() + interval '7 days', $4::jsonb)
         returning profile`,
        [agency.id, business.id, `${randomUUID()}@example.test`, profile, role],
      ),
    );
  expect(await invite('{"firstName": "Ada", "lastName": "Lovelace"}')).toEqual([
    { profile: { firstName: 'Ada', lastName: 'Lovelace' } },
  ]);
  await expect(invite('["Ada"]')).rejects.toMatchObject({ code: '23514' });
});

it('gives a membership a default calendar of its own business, and forgets one that is deleted', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const elsewhere = await database.fixtures.business(agency.id);
  const user = await person();
  const calendar = (businessId: string) =>
    database.as('postgres', (sql) =>
      sql.one<{ id: string }>(
        `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug, is_active)
         values ($1, 'Consultations', 'personal', 'UTC', $2, true) returning id`,
        [businessId, `c-${randomUUID()}`],
      ),
    );
  const mine = await calendar(business.id);
  const theirs = await calendar(elsewhere.id);
  const role = await memberRole(agency.id);
  const { id: membership } = await database.as('postgres', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.memberships (user_id, agency_id, business_id, role_id)
       values ($1, $2, $3, $4) returning id`,
      [user, agency.id, business.id, role],
    ),
  );
  const set = (calendarId: string) =>
    database.as('postgres', (sql) =>
      sql.query('update tenancy.memberships set default_calendar_id = $2 where id = $1', [
        membership,
        calendarId,
      ]),
    );
  await expect(set(theirs.id)).rejects.toMatchObject({ code: '23503' });
  await set(mine.id);
  await database.as('postgres', (sql) =>
    sql.query('delete from calendar.calendars where id = $1', [mine.id]),
  );
  expect(
    await database.as('postgres', (sql) =>
      sql.query('select business_id, default_calendar_id from tenancy.memberships where id = $1', [
        membership,
      ]),
    ),
  ).toEqual([{ business_id: business.id, default_calendar_id: null }]);
});
