// Database-level schema seam only. Manager authorization and slot filtering require
// their own domain/API vertical after the schema has been reviewed.

import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

const TABLES = ['blocked_slots', 'user_date_overrides', 'user_schedules', 'user_weekly_hours'];

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});

afterAll(async () => {
  await database.close();
});

async function profile(timezone = 'UTC') {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  await database.withTenant(business.context, (sql) =>
    sql.query(
      `insert into calendar.user_schedules(business_id,user_id,timezone)
       values(app.business_id(),$1,$2)`,
      [user.id, timezone],
    ),
  );
  return { business, user };
}

describe('business-scoped user availability storage', () => {
  it('protects all four relations with forced tenant isolation', async () => {
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; enabled: boolean; forced: boolean; policies: string[] }>(
        `select c.relname::text as name, c.relrowsecurity as enabled,
                c.relforcerowsecurity as forced,
                array(select p.polname::text from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'calendar' and c.relname = any($1::text[])
         order by c.relname`,
        [TABLES],
      ),
    );
    expect(rows).toEqual(
      TABLES.map((name) => ({ name, enabled: true, forced: true, policies: ['tenant_isolation'] })),
    );
  });

  it.each(['Not/A_Zone', '+03:00', '-05:00'])('refuses timezone %s', async (timezone) => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const user = await database.fixtures.user();
    await expect(
      database.withTenant(business.context, (sql) =>
        sql.query(
          `insert into calendar.user_schedules(business_id,user_id,timezone)
           values(app.business_id(),$1,$2)`,
          [user.id, timezone],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'user_schedules_timezone_valid' });
  });

  it.each([
    'UTC',
    'utc',
    'Africa/Nairobi',
    'America/New_York',
    'Europe/London',
    'Australia/Lord_Howe',
  ])('stores recognized timezone %s with independent empty hours', async (timezone) => {
    const { business, user } = await profile(timezone);
    const rows = await database.withTenant(business.context, (sql) =>
      sql.query<{ timezone: string; inherit: boolean }>(
        `select timezone,inherit_calendar_hours as inherit from calendar.user_schedules
           where user_id=$1`,
        [user.id],
      ),
    );
    expect(rows).toEqual([{ timezone, inherit: false }]);
  });

  it.each([
    [-1, 540, 600],
    [7, 540, 600],
    [1, -1, 600],
    [1, 1440, 1441],
    [1, 540, 1441],
    [1, 600, 600],
    [1, 600, 540],
  ])('refuses invalid weekday/minute interval %j', async (weekday, start, end) => {
    const { business, user } = await profile();
    await expect(
      database.withTenant(business.context, (sql) =>
        sql.query(`insert into calendar.user_weekly_hours values(app.business_id(),$1,$2,$3,$4)`, [
          user.id,
          weekday,
          start,
          end,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses overlapping weekly hours while allowing adjacent ranges through midnight', async () => {
    const { business, user } = await profile();
    await database.withTenant(business.context, (sql) =>
      sql.query(
        `insert into calendar.user_weekly_hours values
          (app.business_id(),$1,1,0,600),(app.business_id(),$1,1,600,1440)`,
        [user.id],
      ),
    );
    await expect(
      database.withTenant(business.context, (sql) =>
        sql.query(`insert into calendar.user_weekly_hours values(app.business_id(),$1,1,540,660)`, [
          user.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23P01', constraint: 'user_weekly_hours_no_overlap' });
  });

  it.each([
    ['2026-10-09', null, 600],
    ['2026-10-09', 540, null],
    ['2026-10-09', -1, 600],
    ['2026-10-09', 540, 1441],
    ['2026-10-09', 600, 600],
    ['infinity', null, null],
    ['0001-01-01 BC', null, null],
  ])('refuses malformed date override %j', async (date, start, end) => {
    const { business, user } = await profile();
    await expect(
      database.withTenant(business.context, (sql) =>
        sql.query(
          `insert into calendar.user_date_overrides(business_id,user_id,on_date,start_minute,end_minute)
           values(app.business_id(),$1,$2,$3,$4)`,
          [user.id, date, start, end],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows adjacent date openings but prevents a conflicting closed date', async () => {
    const { business, user } = await profile();
    await database.withTenant(business.context, (sql) =>
      sql.query(
        `insert into calendar.user_date_overrides(business_id,user_id,on_date,start_minute,end_minute)
         values(app.business_id(),$1,'2026-10-09',0,600),(app.business_id(),$1,'2026-10-09',600,1440)`,
        [user.id],
      ),
    );
    await expect(
      database.withTenant(business.context, (sql) =>
        sql.query(
          `insert into calendar.user_date_overrides(business_id,user_id,on_date)
           values(app.business_id(),$1,'2026-10-09')`,
          [user.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23P01', constraint: 'user_date_overrides_no_overlap' });
  });

  it('prevents opening a closed date or storing overlapping date openings', async () => {
    const { business, user } = await profile();
    await database.withTenant(business.context, (sql) =>
      sql.query(
        `insert into calendar.user_date_overrides(business_id,user_id,on_date,start_minute,end_minute)
         values(app.business_id(),$1,'2026-10-09',null,null),(app.business_id(),$1,'2026-10-10',540,600)`,
        [user.id],
      ),
    );
    for (const date of ['2026-10-09', '2026-10-10']) {
      await expect(
        database.withTenant(business.context, (sql) =>
          sql.query(
            `insert into calendar.user_date_overrides(business_id,user_id,on_date,start_minute,end_minute)
             values(app.business_id(),$1,$2,570,630)`,
            [user.id, date],
          ),
        ),
      ).rejects.toMatchObject({ code: '23P01', constraint: 'user_date_overrides_no_overlap' });
    }
  });

  it.each([
    ['infinity', '2026-10-09T12:00:00Z', ''],
    ['2026-10-09T11:00:00Z', 'infinity', ''],
    ['-infinity', '2026-10-09T12:00:00Z', ''],
    ['2026-10-09T11:00:00Z', '2026-10-09T11:00:00Z', ''],
    ['2026-10-09T12:00:00Z', '2026-10-09T11:00:00Z', ''],
    ['2026-10-09T11:00:00Z', '2026-10-09T12:00:00Z', 'x'.repeat(1001)],
  ])('refuses malformed absence %j', async (start, end, reason) => {
    const { business, user } = await profile();
    await expect(
      database.withTenant(business.context, (sql) =>
        sql.query(
          `insert into calendar.blocked_slots(business_id,user_id,starts_at,ends_at,title) values(app.business_id(),$1,$2,$3,$4)`,
          [user.id, start, end, reason],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('grants only the application tenant CRUD permissions', async () => {
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; grantee: string; privileges: string[] }>(
        `select table_name::text as name,grantee::text,
          array_agg(privilege_type::text order by privilege_type) as privileges
         from information_schema.role_table_grants where table_schema='calendar'
         and table_name=any($1::text[]) and grantee in ('crm_app','crm_auth','crm_worker','PUBLIC')
         group by 1,2 order by 1,2`,
        [TABLES],
      ),
    );
    expect(grants).toEqual(
      TABLES.map((name) => ({
        name,
        grantee: 'crm_app',
        privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
      })),
    );
  });

  it('hides populated schedules and all children outside their business and without tenant context', async () => {
    const { business, user } = await profile();
    const other = await profile();
    await database.withTenant(business.context, async (sql) => {
      await sql.query(
        `insert into calendar.user_weekly_hours values(app.business_id(),$1,1,0,1440)`,
        [user.id],
      );
      await sql.query(
        `insert into calendar.user_date_overrides(business_id,user_id,on_date)
        values(app.business_id(),$1,'2026-10-09')`,
        [user.id],
      );
      await sql.query(
        `insert into calendar.blocked_slots(business_id,user_id,starts_at,ends_at,title) values(app.business_id(),$1,
        '2026-10-09T11:00:00Z','2026-10-09T12:00:00Z','Private absence')`,
        [user.id],
      );
    });
    for (const table of TABLES) {
      expect(
        await database.as('crm_app', (sql) => sql.query(`select 1 from calendar.${table}`)),
      ).toEqual([]);
      expect(
        await database.withTenant(other.business.context, (sql) =>
          sql.query(`select 1 from calendar.${table} where user_id=$1`, [user.id]),
        ),
      ).toEqual([]);
      expect(
        await database.withTenant(business.context, (sql) =>
          sql.query(`select 1 from calendar.${table} where user_id=$1`, [user.id]),
        ),
      ).toHaveLength(1);
    }
  });

  it('refuses a child borrowing another business profile', async () => {
    const mine = await profile();
    const theirs = await profile();
    await expect(
      database.withTenant(mine.business.context, (sql) =>
        sql.query(`insert into calendar.user_weekly_hours values(app.business_id(),$1,1,540,600)`, [
          theirs.user.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('supports explicit inheritance and removes children when a profile is deleted', async () => {
    const { business, user } = await profile();
    await database.withTenant(business.context, async (sql) => {
      await sql.query(
        `update calendar.user_schedules set inherit_calendar_hours=true where user_id=$1`,
        [user.id],
      );
      const rows = await sql.query<{ inherit: boolean }>(
        `select inherit_calendar_hours as inherit from calendar.user_schedules where user_id=$1`,
        [user.id],
      );
      expect(rows).toEqual([{ inherit: true }]);
      await sql.query(
        `insert into calendar.user_weekly_hours values(app.business_id(),$1,1,0,1440)`,
        [user.id],
      );
      await sql.query(
        `insert into calendar.user_date_overrides(business_id,user_id,on_date)
        values(app.business_id(),$1,'2026-10-09')`,
        [user.id],
      );
      await sql.query(
        `insert into calendar.blocked_slots(business_id,user_id,starts_at,ends_at,title) values(app.business_id(),$1,
        '2026-10-09T11:00:00Z','2026-10-09T12:00:00Z','')`,
        [user.id],
      );
      await sql.query(`delete from calendar.user_schedules where user_id=$1`, [user.id]);
      for (const table of TABLES.filter((name) => name !== 'blocked_slots'))
        expect(
          await sql.query(`select 1 from calendar.${table} where user_id=$1`, [user.id]),
        ).toEqual([]);
      // A blocked slot is the person's time off, not part of their hours.
      expect(
        await sql.query(`select 1 from calendar.blocked_slots where user_id=$1`, [user.id]),
      ).toHaveLength(1);
    });
  });

  it('blocks a person, a calendar or both, never nobody, and a calendar of this business only', async () => {
    const { business, user } = await profile();
    const other = await profile();
    const calendarOf = (context: typeof business.context) =>
      database.withTenant(context, (sql) =>
        sql.one<{ id: string }>(
          `insert into calendar.calendars(business_id,name,kind,timezone,booking_slug)
           values(app.business_id(),'Consults','personal','UTC','consults-' || left(gen_random_uuid()::text,8))
           returning id`,
        ),
      );
    const mine = await calendarOf(business.context);
    const theirs = await calendarOf(other.business.context);
    const insert = (userId: string | null, calendarId: string | null) =>
      database.withTenant(business.context, (sql) =>
        sql.query(
          `insert into calendar.blocked_slots(business_id,user_id,calendar_id,starts_at,ends_at)
           values(app.business_id(),$1,$2,'2026-10-09T11:00:00Z','2026-10-09T12:00:00Z')`,
          [userId, calendarId],
        ),
      );
    await insert(user.id, null);
    await insert(null, mine.id);
    await insert(user.id, mine.id);
    await expect(insert(null, null)).rejects.toMatchObject({
      code: '23514',
      constraint: 'blocked_slots_whom',
    });
    await expect(insert(user.id, theirs.id)).rejects.toMatchObject({
      code: '23503',
      constraint: 'blocked_slots_calendar_fkey',
    });
    // Deleting the calendar takes its own blocks with it, and leaves the person's.
    await database.withTenant(business.context, async (sql) => {
      await sql.query('delete from calendar.calendars where id=$1', [mine.id]);
      expect(
        await sql.query<{ calendar_id: string | null }>(
          'select calendar_id from calendar.blocked_slots',
        ),
      ).toEqual([{ calendar_id: null }]);
    });
  });

  it.each(['Not/A_Zone', '+03:00'])(
    'refuses changing a valid profile to timezone %s',
    async (timezone) => {
      const { business, user } = await profile();
      await expect(
        database.withTenant(business.context, (sql) =>
          sql.query('update calendar.user_schedules set timezone=$1 where user_id=$2', [
            timezone,
            user.id,
          ]),
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'user_schedules_timezone_valid' });
      expect(
        await database.withTenant(business.context, (sql) =>
          sql.query<{ timezone: string }>(
            'select timezone from calendar.user_schedules where user_id=$1',
            [user.id],
          ),
        ),
      ).toEqual([{ timezone: 'UTC' }]);
    },
  );

  it('supports every profile and child foreign key with a leading index', async () => {
    const missing = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string }>(
        `with fks as (
         select k.conrelid,k.conname,k.conkey from pg_constraint k
         join pg_class t on t.oid=k.conrelid join pg_namespace n on n.oid=t.relnamespace
         where k.contype='f' and n.nspname='calendar' and t.relname=any($1::text[])
       ), indexes as (
         select i.indrelid,i.indisunique,string_to_array(i.indkey::text,' ')::int2[] as cols from pg_index i
       ) select f.conname::text as name from fks f where not exists (
         select 1 from indexes i where i.indrelid=f.conrelid and (
           (select array_agg(c order by c) from unnest(i.cols[1:cardinality(f.conkey)]) c)
           = (select array_agg(c order by c) from unnest(f.conkey) c)
           or (i.indisunique and i.cols <@ f.conkey)
         )
       )`,
        [TABLES],
      ),
    );
    expect(missing).toEqual([]);
  });

  it.each(['business', 'user'] as const)(
    'cascades all schedule data when its %s is deleted',
    async (kind) => {
      const { business, user } = await profile();
      await database.withTenant(business.context, async (sql) => {
        await sql.query(
          `insert into calendar.user_weekly_hours values(app.business_id(),$1,1,0,1440)`,
          [user.id],
        );
        await sql.query(
          `insert into calendar.user_date_overrides(business_id,user_id,on_date)
        values(app.business_id(),$1,'2026-10-09')`,
          [user.id],
        );
        await sql.query(
          `insert into calendar.blocked_slots(business_id,user_id,starts_at,ends_at,title) values(app.business_id(),$1,
        '2026-10-09T11:00:00Z','2026-10-09T12:00:00Z','')`,
          [user.id],
        );
      });
      await database.as('crm_owner', async (sql) => {
        if (kind === 'business')
          await sql.query('delete from tenancy.businesses where id=$1', [business.id]);
        else await sql.query('delete from auth.users where id=$1', [user.id]);
        for (const table of TABLES)
          expect(
            await sql.query(`select 1 from calendar.${table} where business_id=$1 and user_id=$2`, [
              business.id,
              user.id,
            ]),
          ).toEqual([]);
      });
    },
  );

  it('retains private schedule configuration when business membership is revoked', async () => {
    const { business, user } = await profile();
    await database.as('crm_owner', async (sql) => {
      const role = await sql.one<{ id: string }>(
        `insert into tenancy.roles(agency_id,scope,key,name)
         values($1,'business','schedule_host','Schedule host') returning id`,
        [business.context.agencyId],
      );
      const membership = await sql.one<{ id: string }>(
        `insert into tenancy.memberships(agency_id,business_id,user_id,role_id)
         values($1,$2,$3,$4) returning id`,
        [business.context.agencyId, business.id, user.id, role.id],
      );
      await sql.query('delete from tenancy.memberships where id=$1', [membership.id]);
      expect(
        await sql.query('select 1 from tenancy.memberships where id=$1', [membership.id]),
      ).toEqual([]);
    });
    expect(
      await database.withTenant(business.context, (sql) =>
        sql.query<{ timezone: string }>(
          'select timezone from calendar.user_schedules where user_id=$1',
          [user.id],
        ),
      ),
    ).toEqual([{ timezone: 'UTC' }]);
  });
});
