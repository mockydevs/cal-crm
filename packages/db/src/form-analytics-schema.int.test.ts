// Migration 0078 (a form's numbers) at the database's own level: forms.daily_stats, its
// grants and policy, what it refuses, and that a form's rows go with the form. What the
// module counts into it is the forms package's to prove (packages/modules/forms).
import { randomBytes, randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';
import { testDatabase, type Sql, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

let database: TestDatabase;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
});
afterAll(async () => {
  await database.close();
});

async function business() {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...created.context, correlationId: randomUUID() };
  return { business: created, context };
}
const form = (sql: Sql): Promise<{ id: string }> =>
  sql.one<{ id: string }>(
    `insert into forms.forms (business_id, name, definition, public_key)
     values (app.business_id(), 'Enquiry', '{"fields": []}', $1) returning id`,
    [randomBytes(24).toString('base64url')],
  );
const COUNT = `
  insert into forms.daily_stats (business_id, form_id, day, views, timed_submissions, fill_seconds)
  values (app.business_id(), $1, $2, $3, $4, $5)
  on conflict (business_id, form_id, day) do update
    set views = forms.daily_stats.views + excluded.views,
        timed_submissions = forms.daily_stats.timed_submissions + excluded.timed_submissions,
        fill_seconds = forms.daily_stats.fill_seconds + excluded.fill_seconds
  returning views, timed_submissions, fill_seconds`;
const count = (sql: Sql, formId: string, day: string, views = 1, timed = 0, seconds = 0) =>
  sql.one<{ views: number; timed_submissions: number; fill_seconds: number }>(COUNT, [
    formId,
    day,
    views,
    timed,
    seconds,
  ]);
const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};

describe('the table', () => {
  it('has forced row-level security and the tenant policy', async () => {
    const [row] = await database.as('crm_owner', (sql) =>
      sql.query<{ enabled: boolean; forced: boolean; policies: string[] }>(
        `select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
                array(select format('%s %s %s', p.policyname, p.permissive, p.cmd)
                      from pg_policies p
                      where p.schemaname = 'forms' and p.tablename = 'daily_stats'
                      order by 1) as policies
         from pg_class c where c.oid = 'forms.daily_stats'::regclass`,
      ),
    );
    expect(row).toEqual({
      enabled: true,
      forced: true,
      policies: ['tenant_isolation PERMISSIVE ALL'],
    });
  });

  it('grants crm_app reading and counting, no deleting, and nothing to the other runtime roles', async () => {
    const grants = await database.as('crm_owner', (sql) =>
      sql.query<{ grantee: string; privileges: string[] }>(
        `select grantee::text, array_agg(privilege_type::text order by privilege_type) as privileges
         from information_schema.role_table_grants
         where table_schema = 'forms' and table_name = 'daily_stats'
           and grantee in ('crm_app', 'crm_auth', 'crm_worker', 'PUBLIC')
         group by 1 order by 1`,
      ),
    );
    expect(grants).toEqual([{ grantee: 'crm_app', privileges: ['INSERT', 'SELECT', 'UPDATE'] }]);
    const { context } = await business();
    await expect(
      database.withTenant(context, (sql) => sql.query('delete from forms.daily_stats')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('reads as empty with no tenant context', async () => {
    const { context } = await business();
    await database.withTenant(context, async (sql) => {
      await count(sql, (await form(sql)).id, '2026-10-10');
    });
    expect(
      await database.as('crm_app', (sql) => sql.query('select 1 from forms.daily_stats')),
    ).toEqual([]);
  });
});

describe("a form's numbers", () => {
  it('are one row for each form and day, added to as they are counted', async () => {
    const { context } = await business();
    await database.withTenant(context, async (sql) => {
      const first = await form(sql);
      const second = await form(sql);
      expect(await count(sql, first.id, '2026-10-10')).toEqual({
        views: 1,
        timed_submissions: 0,
        fill_seconds: 0,
      });
      await count(sql, first.id, '2026-10-10');
      expect(await count(sql, first.id, '2026-10-10', 0, 1, 42)).toEqual({
        views: 2,
        timed_submissions: 1,
        fill_seconds: 42,
      });
      await count(sql, first.id, '2026-10-11');
      await count(sql, second.id, '2026-10-10');
      expect(
        await sql.query(
          `select form_id, day::text, views from forms.daily_stats order by form_id, day`,
        ),
      ).toEqual([
        { form_id: first.id, day: '2026-10-10', views: 2 },
        { form_id: first.id, day: '2026-10-11', views: 1 },
        { form_id: second.id, day: '2026-10-10', views: 1 },
      ]);
    });
  });

  it('are never negative, and hold no seconds without a submission that was timed', async () => {
    const { context } = await business();
    const made = await database.withTenant(context, (sql) => form(sql));
    const attempt = (views: number, timed: number, seconds: number) =>
      database.withTenant(context, (sql) =>
        count(sql, made.id, '2026-10-10', views, timed, seconds),
      );
    await refused(attempt(-1, 0, 0), 'daily_stats_views_nonnegative');
    await refused(attempt(0, -1, 0), 'daily_stats_timed_nonnegative');
    await refused(attempt(0, 1, -5), 'daily_stats_fill_seconds_valid');
    await refused(attempt(0, 0, 30), 'daily_stats_fill_seconds_valid');
    // A submission sent the instant the wait was over took no whole second.
    expect(await attempt(0, 1, 0)).toEqual({ views: 0, timed_submissions: 1, fill_seconds: 0 });
  });

  it('belong to a form of the same business, and go when the form does', async () => {
    const mine = await business();
    const theirs = await business();
    const made = await database.withTenant(mine.context, async (sql) => {
      const created = await form(sql);
      await count(sql, created.id, '2026-10-10');
      return created;
    });
    await database.withTenant(theirs.context, async (sql) => {
      expect(await sql.query('select 1 from forms.daily_stats')).toEqual([]);
      expect(
        await sql.query('update forms.daily_stats set views = 99 where form_id = $1 returning 1', [
          made.id,
        ]),
      ).toEqual([]);
    });
    // Another business cannot count into this one's form: there is no such form for it.
    await refused(
      database.withTenant(theirs.context, (sql) => count(sql, made.id, '2026-10-10')),
      'daily_stats_business_id_form_id_fkey',
    );
    await expect(
      database.withTenant(theirs.context, (sql) =>
        sql.query(
          `insert into forms.daily_stats (business_id, form_id, day, views) values ($1, $2, $3, 1)`,
          [mine.business.id, made.id, '2026-10-12'],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await database.withTenant(mine.context, async (sql) => {
      expect(await sql.query('select views from forms.daily_stats')).toEqual([{ views: 1 }]);
      await sql.query('delete from forms.forms where id = $1', [made.id]);
      expect(await sql.query('select 1 from forms.daily_stats')).toEqual([]);
    });
  });
});
