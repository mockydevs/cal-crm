// Migration 0074: calendar groups, the wider set of calendar types, and the settings the
// "New calendar" editor holds.
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

type Business = Awaited<ReturnType<TestDatabase['fixtures']['business']>>;

const calendar = (business: Business, columns = '', values = '') =>
  database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug${columns})
       values ($1, 'Consultations', 'personal', 'UTC', $2${values}) returning id`,
      [business.id, `c-${randomUUID()}`],
    ),
  );

it('gives a calendar the defaults the form starts from', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const { id } = await calendar(business);
  expect(
    await database.withTenant(business.context, (sql) =>
      sql.query(
        `select group_id, invite_title, slot_interval_minutes, extra_duration_minutes, max_per_day,
                max_per_slot, count_available_days_only, look_busy_percent, consent_enabled,
                assign_contact_to_member, skip_assign_if_owned, allow_reschedule,
                reschedule_cutoff_minutes, allow_cancel, cancel_cutoff_minutes, widget_style,
                primary_color, background_color, button_text
         from calendar.calendars where id = $1`,
        [id],
      ),
    ),
  ).toEqual([
    {
      group_id: null,
      invite_title: '{{contact.name}}',
      slot_interval_minutes: null,
      extra_duration_minutes: [],
      max_per_day: null,
      // Empty: one booking per free host.
      max_per_slot: null,
      count_available_days_only: false,
      look_busy_percent: 0,
      consent_enabled: true,
      assign_contact_to_member: true,
      skip_assign_if_owned: false,
      allow_reschedule: true,
      reschedule_cutoff_minutes: null,
      allow_cancel: true,
      cancel_cutoff_minutes: null,
      widget_style: 'neo',
      primary_color: '#178af6',
      background_color: '#ffffff',
      button_text: '',
    },
  ]);
});

it('stores every calendar type, and no other', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const { id } = await calendar(business);
  const set = (kind: string) =>
    database.withTenant(business.context, (sql) =>
      sql.query('update calendar.calendars set kind = $2 where id = $1', [id, kind]),
    );
  for (const kind of ['round_robin', 'collective', 'class', 'service', 'event', 'personal'])
    await set(kind);
  await expect(set('rental')).rejects.toMatchObject({ code: '23514' });
});

it('refuses settings outside their bounds', async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  for (const [column, value] of [
    ['slot_interval_minutes', '4'],
    ['slot_interval_minutes', '481'],
    ['extra_duration_minutes', "'{15,30,45,60,90,120}'"],
    ['extra_duration_minutes', "'{4}'"],
    ['max_per_day', '0'],
    ['max_per_slot', '0'],
    ['look_busy_percent', '101'],
    ['reschedule_cutoff_minutes', '-1'],
    ['cancel_cutoff_minutes', '525601'],
    ['widget_style', "'modern'"],
    ['primary_color', "'blue'"],
    ['background_color', "'#FFF'"],
    ['invite_title', "' '"],
    ['button_text', "repeat('a', 41)"],
    ['consent_text', "repeat('a', 1001)"],
  ] as const)
    await expect(
      calendar(business, `, ${column}`, `, ${value}`),
      `${column} = ${value}`,
    ).rejects.toMatchObject({ code: '23514' });
  await calendar(
    business,
    ', slot_interval_minutes, extra_duration_minutes, max_per_day, look_busy_percent, primary_color',
    ", 15, '{45,60}', 8, 100, '#178af6ff'",
  );
});

it('keeps a group inside its business, with one name once, and lets its calendars go when it is deleted', async () => {
  const agency = await database.fixtures.agency();
  const first = await database.fixtures.business(agency.id);
  const second = await database.fixtures.business(agency.id);
  const group = (business: Business, name: string) =>
    database.withTenant(business.context, (sql) =>
      sql.one<{ id: string }>(
        'insert into calendar.calendar_groups (business_id, name) values ($1, $2) returning id',
        [business.id, name],
      ),
    );
  const sales = await group(first, 'Sales calls');
  await expect(group(first, ' sales CALLS ')).rejects.toMatchObject({ code: '23505' });
  await expect(group(first, ' ')).rejects.toMatchObject({ code: '23514' });
  await group(second, 'Sales calls');
  expect(
    await database.withTenant(second.context, (sql) =>
      sql.query('select id from calendar.calendar_groups where id = $1', [sales.id]),
    ),
  ).toEqual([]);

  const { id } = await calendar(first, ', group_id', `, '${sales.id}'`);
  // Another business's group is not this calendar's to join.
  await expect(calendar(second, ', group_id', `, '${sales.id}'`)).rejects.toMatchObject({
    code: '23503',
  });
  await database.withTenant(first.context, (sql) =>
    sql.query('delete from calendar.calendar_groups where id = $1', [sales.id]),
  );
  expect(
    await database.withTenant(first.context, (sql) =>
      sql.query('select business_id, group_id from calendar.calendars where id = $1', [id]),
    ),
  ).toEqual([{ business_id: first.id, group_id: null }]);
});

it("keeps a member's meeting locations as a short list", async () => {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const { id } = await calendar(business);
  const user = await database.fixtures.user();
  const add = (locations: string) =>
    database.as('postgres', (sql) =>
      sql.query<{ locations: unknown }>(
        `insert into calendar.calendar_members (business_id, calendar_id, user_id, locations)
         values ($1, $2, $3, $4::jsonb)
         on conflict (business_id, calendar_id, user_id) do update set locations = excluded.locations
         returning locations`,
        [business.id, id, user.id, locations],
      ),
    );
  expect(await add('[{"kind": "custom", "value": "12 Harbor Road", "label": "Studio"}]')).toEqual([
    { locations: [{ kind: 'custom', value: '12 Harbor Road', label: 'Studio' }] },
  ]);
  await expect(add('{"kind": "custom"}')).rejects.toMatchObject({ code: '23514' });
  await expect(add(JSON.stringify(Array.from({ length: 6 }, () => ({}))))).rejects.toMatchObject({
    code: '23514',
  });
});
