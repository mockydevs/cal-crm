import { randomUUID } from 'node:crypto';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  createSealingVault,
  newSecretsKey,
  parseSecretsPublicKey,
  type SealingVault,
} from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

let database: TestDatabase;
let db: Database;
let vault: SealingVault;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const keys = await newSecretsKey(1);
  vault = await createSealingVault(parseSecretsPublicKey(keys.publicKey));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function fixture() {
  const agencySlug = `scope-${randomUUID().slice(0, 8)}`;
  const agency = await database.fixtures.agency({ slug: agencySlug });
  const business = await database.fixtures.business(agency.id, { slug: 'events' });
  const user = await database.fixtures.user();
  const secretId = await withTenant(db, business.context, (trx) =>
    vault.store(
      trx,
      { agencyId: agency.id, businessId: business.id, purpose: 'mailbox.credentials' },
      'sealed fixture; never dispatched',
    ),
  );
  const account = await database.withTenant(business.context, async (sql) => {
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts(business_id,channel,name) values(app.business_id(),'email','Bookings') returning id",
    );
    await sql.query(
      `insert into messaging.mailboxes(business_id,id,email_address,auth_method,smtp_host,smtp_port,smtp_security,smtp_username,secret_id,use_for_conversations)
      values(app.business_id(),$1,'bookings@example.test','password','localhost',1025,'none','fixture',$2,true)`,
      [account.id, secretId],
    );
    return account;
  });
  const role = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      "insert into tenancy.roles(agency_id,scope,key,name) values(app.agency_id(),'business','scheduler','Scheduler') returning id",
    ),
  );
  const membership = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      'insert into tenancy.memberships(agency_id,business_id,user_id,role_id) values(app.agency_id(),app.business_id(),$1,$2) returning id',
      [user.id, role.id],
    ),
  );
  const calendar = await database.withTenant(business.context, async (sql) => {
    const calendar = await sql.one<{ id: string }>(
      "insert into calendar.calendars(business_id,name,kind,timezone,booking_slug,confirmation_account_id) values(app.business_id(),'Consultation','personal','UTC','consultation',$1) returning id",
      [account.id],
    );
    await sql.query(
      'insert into calendar.calendar_members(business_id,calendar_id,user_id) values(app.business_id(),$1,$2)',
      [calendar.id, user.id],
    );
    return calendar;
  });
  return { agency, agencySlug, business, user, membership, calendar, account, role };
}
const resolve = (agency: string) =>
  database.as('crm_app', (sql) =>
    sql.query<{ agency_id: string; business_id: string; calendar_id: string }>(
      "select * from private.resolve_calendar($1,'events','consultation')",
      [agency],
    ),
  );

it('resolves only minimal IDs for active bookable calendars and rechecks member/user eligibility, with or without a sender', async () => {
  const f = await fixture();
  const other = await fixture();
  expect(await resolve(f.agencySlug)).toEqual([
    { agency_id: f.agency.id, business_id: f.business.id, calendar_id: f.calendar.id },
  ]);
  expect(await resolve(other.agencySlug)).toEqual([
    { agency_id: other.agency.id, business_id: other.business.id, calendar_id: other.calendar.id },
  ]);
  expect(await resolve('missing')).toEqual([]);
  for (const agencySlug of ['', 'Ｃonsultation', 'a'.repeat(64)])
    expect(await resolve(agencySlug)).toEqual([]);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update calendar.calendars set confirmation_account_id=null where id=$1', [
      f.calendar.id,
    ]),
  );
  // A calendar without a mailbox still takes bookings; none is emailed.
  expect(await resolve(f.agencySlug)).toEqual([
    { agency_id: f.agency.id, business_id: f.business.id, calendar_id: f.calendar.id },
  ]);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update calendar.calendars set confirmation_account_id=$1 where id=$2', [
      f.account.id,
      f.calendar.id,
    ]),
  );
  for (const [change, restore] of [
    [
      "update tenancy.businesses set status='suspended' where id=$1",
      "update tenancy.businesses set status='active' where id=$1",
    ],
    [
      'update calendar.calendars set is_active=false where business_id=$1',
      'update calendar.calendars set is_active=true where business_id=$1',
    ],
    [
      "update calendar.calendars set kind='collective' where business_id=$1",
      "update calendar.calendars set kind='personal' where business_id=$1",
    ],
  ] as const) {
    await database.withTenant(f.business.context, (sql) => sql.query(change, [f.business.id]));
    expect(await resolve(f.agencySlug)).toEqual([]);
    await database.withTenant(f.business.context, (sql) => sql.query(restore, [f.business.id]));
  }
  await database.as('crm_auth', (sql) =>
    sql.query('update auth.users set disabled_at=now() where id=$1', [f.user.id]),
  );
  expect(await resolve(f.agencySlug)).toEqual([]);
  await database.as('crm_auth', (sql) =>
    sql.query('update auth.users set disabled_at=null where id=$1', [f.user.id]),
  );
  const second = await database.fixtures.user();
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      'insert into tenancy.memberships(agency_id,business_id,user_id,role_id) values(app.agency_id(),app.business_id(),$1,$2)',
      [second.id, f.role.id],
    ),
  );
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      'insert into calendar.calendar_members(business_id,calendar_id,user_id) values(app.business_id(),$1,$2)',
      [f.calendar.id, second.id],
    ),
  );
  expect(await resolve(f.agencySlug)).toEqual([]);
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update calendar.calendars set kind='round_robin' where id=$1", [f.calendar.id]),
  );
  expect(await resolve(f.agencySlug)).toEqual([
    { agency_id: f.agency.id, business_id: f.business.id, calendar_id: f.calendar.id },
  ]);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('delete from calendar.calendar_members where user_id=$1', [second.id]),
  );
  await database.withTenant(f.business.context, (sql) =>
    sql.query('delete from tenancy.memberships where id=$1', [f.membership.id]),
  );
  expect(await resolve(f.agencySlug)).toEqual([]);
});

it('keeps a round-robin calendar resolvable while one member is still on the team, and a personal one only with its own', async () => {
  const f = await fixture();
  const second = await database.fixtures.user();
  const secondMembership = await database.withTenant(f.business.context, async (sql) => {
    const membership = await sql.one<{ id: string }>(
      'insert into tenancy.memberships(agency_id,business_id,user_id,role_id) values(app.agency_id(),app.business_id(),$1,$2) returning id',
      [second.id, f.role.id],
    );
    await sql.query(
      'insert into calendar.calendar_members(business_id,calendar_id,user_id) values(app.business_id(),$1,$2)',
      [f.calendar.id, second.id],
    );
    await sql.query("update calendar.calendars set kind='round_robin' where id=$1", [
      f.calendar.id,
    ]);
    return membership;
  });
  const scope = [
    { agency_id: f.agency.id, business_id: f.business.id, calendar_id: f.calendar.id },
  ];
  expect(await resolve(f.agencySlug)).toEqual(scope);
  // One of the two leaves the team: the other still takes bookings.
  await database.withTenant(f.business.context, (sql) =>
    sql.query('delete from tenancy.memberships where id=$1', [f.membership.id]),
  );
  expect(await resolve(f.agencySlug)).toEqual(scope);
  // The one who is left is disabled: nobody can take a booking.
  await database.as('crm_auth', (sql) =>
    sql.query('update auth.users set disabled_at=now() where id=$1', [second.id]),
  );
  expect(await resolve(f.agencySlug)).toEqual([]);
  await database.as('crm_auth', (sql) =>
    sql.query('update auth.users set disabled_at=null where id=$1', [second.id]),
  );
  expect(await resolve(f.agencySlug)).toEqual(scope);
  // A personal calendar is one person: a second stored member, or its own gone, refuses.
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update calendar.calendars set kind='personal' where id=$1", [f.calendar.id]),
  );
  expect(await resolve(f.agencySlug)).toEqual([]);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('delete from calendar.calendar_members where user_id=$1', [second.id]),
  );
  expect(await resolve(f.agencySlug)).toEqual([]);
  // A round-robin calendar whose every member has left has nobody either.
  await database.withTenant(f.business.context, async (sql) => {
    await sql.query("update calendar.calendars set kind='round_robin' where id=$1", [
      f.calendar.id,
    ]);
    await sql.query('delete from tenancy.memberships where id=$1', [secondMembership.id]);
  });
  expect(await resolve(f.agencySlug)).toEqual([]);
});

it('keeps management scope available on disabled calendars but refuses expired/inactive-business capabilities', async () => {
  const f = await fixture();
  const contact = await database.fixtures.contact(f.business.context);
  const digest = 'a'.repeat(64);
  const appointment = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>(
      `insert into calendar.appointments(business_id,calendar_id,contact_id,title,starts_at,ends_at,source,management_digest,management_expires_at)
    values(app.business_id(),$1,$2,'Consultation','2026-10-10T10:00:00Z','2026-10-10T10:30:00Z','booking_page',$3,now()+interval '1 hour') returning id`,
      [f.calendar.id, contact.id, digest],
    ),
  );
  const scope = () =>
    database.as('crm_app', (sql) =>
      sql.query('select * from private.appointment_scope($1)', [digest]),
    );
  const expected = [
    { agency_id: f.agency.id, business_id: f.business.id, appointment_id: appointment.id },
  ];
  expect(await scope()).toEqual(expected);
  expect(
    await database.as('crm_app', (sql) =>
      sql.query('select * from private.appointment_scope($1)', ['b'.repeat(64)]),
    ),
  ).toEqual([]);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update calendar.calendars set is_active=false where id=$1', [f.calendar.id]),
  );
  expect(await scope()).toEqual(expected);
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update tenancy.businesses set status='suspended' where id=$1", [f.business.id]),
  );
  expect(await scope()).toEqual([]);
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update tenancy.businesses set status='active' where id=$1", [f.business.id]),
  );
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      "update calendar.appointments set management_expires_at=now()-interval '1 second' where id=$1",
      [appointment.id],
    ),
  );
  expect(await scope()).toEqual([]);
});

it('grants only narrow crm_app scope execution and leaves ordinary tenant tables protected', async () => {
  const f = await fixture();
  for (const role of ['crm_auth', 'crm_worker'] as const)
    await expect(
      database.as(role, (sql) =>
        sql.query("select * from private.resolve_calendar($1,'events','consultation')", [
          f.agencySlug,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  expect(
    await database.as('crm_app', (sql) => sql.query('select id from calendar.calendars')),
  ).toEqual([]);
  const metadata = await database.as('crm_owner', (sql) =>
    sql.one<{
      definer: boolean;
      path: string[];
      public_execution: boolean;
    }>(`select p.prosecdef as definer,p.proconfig as path,
    exists(select from pg_catalog.aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execution
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='resolve_calendar'`),
  );
  expect(metadata).toEqual({ definer: true, path: ['search_path=""'], public_execution: false });
});
