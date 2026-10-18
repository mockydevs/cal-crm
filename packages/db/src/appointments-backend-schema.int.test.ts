// Migration 0066 (appointments the team books and marks) at the database's own level: the
// sixth status and what it leaves alone, the receipt check that reads it, who booked an
// appointment, and the table's row-level security, which the migration must not have
// loosened. What the calendar module does with the table is its own to prove.
import { randomUUID } from 'node:crypto';

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
  const contact = (await database.fixtures.contact(context)).id;
  const user = (await database.fixtures.user()).id;
  const calendar = await database.withTenant(context, (sql) =>
    sql.one<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
       values (app.business_id(), 'Site visits', 'personal', 'UTC', $1) returning id`,
      [`visits-${randomUUID().slice(0, 8)}`],
    ),
  );
  return { context, contact, user, calendar: calendar.id };
}

const refused = async (work: Promise<unknown>, constraint: string): Promise<void> => {
  await expect(work).rejects.toMatchObject({ constraint });
};

type Place = Awaited<ReturnType<typeof business>>;
const book = (sql: Sql, at: Place, values: { status?: string; createdBy?: string | null } = {}) =>
  sql.one<{ id: string; created_by_user_id: string | null }>(
    `insert into calendar.appointments
       (business_id, calendar_id, contact_id, assigned_user_id, title, starts_at, ends_at,
        status, cancelled_at, source, created_by_user_id)
     values (app.business_id(), $1, $2, $3, 'Site visit', '2026-11-02T06:00:00Z',
             '2026-11-02T07:00:00Z', $4, $5, 'user', $6)
     returning id, created_by_user_id`,
    [
      at.calendar,
      at.contact,
      at.user,
      values.status ?? 'booked',
      values.status === 'cancelled' ? '2026-11-01T00:00:00Z' : null,
      values.createdBy ?? null,
    ],
  );

describe("an appointment's status", () => {
  it('may be invalid, beside the five it could be, and nothing else', async () => {
    const at = await business();
    for (const status of ['confirmed', 'cancelled', 'no_show', 'completed', 'invalid']) {
      const made = await database.withTenant(at.context, (sql) => book(sql, at, { status }));
      expect(made.id).toEqual(expect.any(String));
      await database.withTenant(at.context, (sql) =>
        sql.query(`delete from calendar.appointments where id = $1`, [made.id]),
      );
    }
    await refused(
      database.withTenant(at.context, (sql) => book(sql, at, { status: 'showed' })),
      'appointments_status_valid',
    );
  });

  it('holds nobody’s time when invalid, and still keeps one person out of two live appointments', async () => {
    const at = await business();
    await database.withTenant(at.context, async (sql) => {
      await book(sql, at, { status: 'invalid' });
      await book(sql, at, { status: 'invalid' });
      await book(sql, at, { status: 'confirmed' });
    });
    await refused(
      database.withTenant(at.context, (sql) => book(sql, at)),
      'appointments_no_double_booking',
    );
    // Coming back from invalid onto a taken time is refused by the same rule.
    await refused(
      database.withTenant(at.context, (sql) =>
        sql.query(`update calendar.appointments set status = 'booked' where status = 'invalid'`),
      ),
      'appointments_no_double_booking',
    );
  });

  it('is read back in a booker’s receipt, invalid too, and no other word is', async () => {
    const receipt = (status: string) =>
      database.as('crm_owner', (sql) =>
        sql.one<{ valid: boolean }>(`select util.valid_appointment_receipt($1::jsonb) as valid`, [
          JSON.stringify({
            status,
            startsAt: '2026-11-02T06:00:00Z',
            endsAt: '2026-11-02T07:00:00Z',
          }),
        ]),
      );
    for (const status of ['booked', 'confirmed', 'cancelled', 'completed', 'no_show', 'invalid'])
      expect((await receipt(status)).valid, status).toBe(true);
    expect((await receipt('showed')).valid).toBe(false);
  });
});

describe('who booked an appointment', () => {
  it('is nobody unless said, must be an account, and is forgotten if the account goes', async () => {
    const at = await business();
    const booker = (await database.fixtures.user()).id;
    const [unsaid, said] = await database.withTenant(at.context, async (sql) => [
      await book(sql, at, { status: 'invalid' }),
      await book(sql, at, { status: 'invalid', createdBy: booker }),
    ]);
    expect(unsaid.created_by_user_id).toBeNull();
    expect(said.created_by_user_id).toBe(booker);
    await refused(
      database.withTenant(at.context, (sql) =>
        book(sql, at, { status: 'invalid', createdBy: randomUUID() }),
      ),
      'appointments_created_by_user_id_fkey',
    );
    await database.as('crm_owner', (sql) =>
      sql.query(`delete from auth.users where id = $1`, [booker]),
    );
    const kept = await database.withTenant(at.context, (sql) =>
      sql.one<{ created_by_user_id: string | null }>(
        `select created_by_user_id from calendar.appointments where id = $1`,
        [said.id],
      ),
    );
    expect(kept.created_by_user_id).toBeNull();
  });
});

describe('the appointments table after the migration', () => {
  it('still has forced row-level security and the tenant policy alone', async () => {
    const [table] = await database.as('crm_owner', (sql) =>
      sql.query<{ enabled: boolean; forced: boolean; policies: string[] }>(
        `select c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
                array(select format('%s %s %s', p.policyname, p.permissive, p.cmd)
                      from pg_policies p
                      where p.schemaname = 'calendar' and p.tablename = 'appointments'
                      order by 1) as policies
         from pg_class c where c.oid = 'calendar.appointments'::regclass`,
      ),
    );
    expect(table?.enabled).toBe(true);
    expect(table?.forced).toBe(true);
    expect(table?.policies).toHaveLength(1);
  });

  it('keeps one business’s appointments from another, the new column with them', async () => {
    const [mine, theirs] = [await business(), await business()];
    const made = await database.withTenant(theirs.context, (sql) =>
      book(sql, theirs, { createdBy: theirs.user }),
    );
    const seen = await database.withTenant(mine.context, (sql) =>
      sql.query(`select id, created_by_user_id from calendar.appointments`),
    );
    expect(seen).toEqual([]);
    const changed = await database.withTenant(mine.context, (sql) =>
      sql.query(`update calendar.appointments set status = 'invalid' where id = $1 returning id`, [
        made.id,
      ]),
    );
    expect(changed).toEqual([]);
  });

  it('has the indexes the list and the account reference read', async () => {
    const rows = await database.as('crm_owner', (sql) =>
      sql.query<{ name: string; definition: string }>(
        `select indexname as name, indexdef as definition from pg_indexes
         where schemaname = 'calendar' and tablename = 'appointments'
           and indexname in ('appointments_created_idx', 'appointments_created_by_idx')
         order by 1`,
      ),
    );
    expect(rows.map((row) => row.name)).toEqual([
      'appointments_created_by_idx',
      'appointments_created_idx',
    ]);
    expect(rows[1]?.definition).toContain('(business_id, created_at, id)');
    expect(rows[0]?.definition).toContain('WHERE (created_by_user_id IS NOT NULL)');
  });
});
