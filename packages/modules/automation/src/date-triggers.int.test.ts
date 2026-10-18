// The date trigger, in the engine: a contact is enrolled when a date it holds comes round,
// at a time of day in a time zone, once for each occurrence whatever happens to the sweep.
// Real Postgres; every moment is a fixed date passed to the sweep, so nothing depends on
// when this runs.
import type { AutomationDocumentInput } from '@repo/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { startHarness, type Harness, type Tenant } from '../test/workflows.js';
import { sweepDateTriggers } from './date-triggers.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const NAIROBI = 'Africa/Nairobi';
const NEW_YORK = 'America/New_York';
const at = (value: string) => new Date(value);

type DateConfig = Extract<
  AutomationDocumentInput['triggers'][number],
  { type: 'date.reached' }
>['config'];

const reminder = (
  config: DateConfig,
  patch: Partial<AutomationDocumentInput> = {},
): AutomationDocumentInput => ({
  name: 'Reminder',
  triggers: [{ id: 'the_day', type: 'date.reached', config }],
  start: 'pause',
  steps: { pause: { type: 'wait', config: { duration: 'P1D' } } },
  ...patch,
});

/** A business in a time zone with a custom contact field, a date unless said otherwise. */
async function business(
  zone: string,
  valueType: 'date' | 'datetime' = 'date',
): Promise<{ tenant: Tenant; fieldId: string }> {
  const tenant = await h.business();
  await h.database.as('postgres', (sql) =>
    sql.query('update tenancy.businesses set timezone = $2 where id = $1', [
      tenant.businessId,
      zone,
    ]),
  );
  const field = await h.database.withTenant(tenant, (sql) =>
    sql.one<{ id: string }>(
      `insert into crm.field_definitions
         (business_id, object_type_id, key, label, description, value_type, created_by_kind)
       select app.business_id(), id, 'the_date', 'The date', 'A date to remember.', $1, 'system'
       from crm.object_types where kind = 'contact'
       returning id`,
      [valueType],
    ),
  );
  return { tenant, fieldId: field.id };
}

/** A new contact holding the date (YYYY-MM-DD) or the instant in the field. */
async function contactWith(
  scene: { tenant: Tenant; fieldId: string },
  value: string | undefined,
  firstName = 'Ada',
): Promise<string> {
  const { contactId } = await h.contact(scene.tenant, firstName);
  if (value !== undefined) await hold(scene, contactId, value);
  return contactId;
}

async function hold(
  scene: { tenant: Tenant; fieldId: string },
  contactId: string,
  value: string,
): Promise<void> {
  const isDate = value.length === 10;
  await h.database.withTenant(scene.tenant, async (sql) => {
    await sql.query('delete from crm.field_values where record_id = $1 and field_id = $2', [
      contactId,
      scene.fieldId,
    ]);
    await sql.query(
      `insert into crm.field_values
         (business_id, record_id, field_id, value_type, ${isDate ? 'value_date' : 'value_datetime'}, source_kind)
       values (app.business_id(), $2::uuid, $1::uuid, $3, $4::${isDate ? 'date' : 'timestamptz'}, 'system')`,
      [scene.fieldId, contactId, isDate ? 'date' : 'datetime', value],
    );
  });
}

/** The runs of an automation, oldest first, as what started each. */
const runs = (tenant: Tenant, automationId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{
      record_id: string;
      trigger_key: string | null;
      trigger_event_id: string | null;
      date: string | null;
      status: string;
    }>(
      `select record_id, trigger_key, trigger_event_id, state ->> 'date' as date, status
       from automation.enrolments where automation_id = $1 order by started_at, id`,
      [automationId],
    ),
  );

const sweep = (now: string) => sweepDateTriggers(h.services, at(now));

/**
 * Takes every other business's automations out of the sweep, so what a sweep says it did
 * is this business's alone: the sweep counts across the whole database.
 */
const alone = (tenant: Tenant) =>
  h.database.as('postgres', (sql) =>
    sql.query('delete from automation.trigger_subscriptions where business_id <> $1', [
      tenant.businessId,
    ]),
  );

/** Ends every run of the automation, as if each had gone through to its end. */
const finishRuns = (automationId: string) =>
  h.database.as('postgres', (sql) =>
    sql.query(
      `update automation.enrolments
       set status = 'completed', current_step = null, wake_at = null, finished_at = now()
       where automation_id = $1 and status in ('running', 'waiting')`,
      [automationId],
    ),
  );

const cursor = (tenant: Tenant, automationId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ trigger_id: string; swept_through: Date }>(
      `select trigger_id, swept_through from automation.trigger_cursors
       where automation_id = $1 order by trigger_id`,
      [automationId],
    ),
  );

it('enrols the contact at 08:00 business time on the date, once, and nothing behind the first look', async () => {
  const scene = await business(NAIROBI);
  const today = await contactWith(scene, '2026-10-20');
  await contactWith(scene, '2026-10-19', 'Grace');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder({ field: 'contact.custom.the_date', repeat: 'never' }),
  );

  // The first look starts the clock: yesterday's date fires nothing, and nor does today's yet.
  expect(await sweep('2026-10-20T04:00:00Z')).toEqual({ enrolled: 0, late: 0 });
  expect(await sweep('2026-10-20T04:59:00Z')).toEqual({ enrolled: 0, late: 0 });
  expect(await runs(scene.tenant, automationId)).toEqual([]);

  // 08:00 in Nairobi is 05:00 UTC.
  expect(await sweep('2026-10-20T05:00:00Z')).toEqual({ enrolled: 1, late: 0 });
  expect(await runs(scene.tenant, automationId)).toEqual([
    {
      record_id: today,
      trigger_key: 'the_day',
      trigger_event_id: null,
      date: '2026-10-20',
      status: 'running',
    },
  ]);
  expect(await sweep('2026-10-20T05:00:00Z')).toEqual({ enrolled: 0, late: 0 });
  expect(await sweep('2026-10-20T05:01:00Z')).toEqual({ enrolled: 0, late: 0 });
  expect((await runs(scene.tenant, automationId)).map((run) => run.record_id)).toEqual([today]);
  expect(await cursor(scene.tenant, automationId)).toEqual([
    { trigger_id: 'the_day', swept_through: at('2026-10-20T05:01:00Z') },
  ]);
});

it('fires at its own time of day, an offset before the date', async () => {
  const scene = await business(NAIROBI);
  const contact = await contactWith(scene, '2026-10-20');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder({
      field: 'contact.custom.the_date',
      offset: 'P3D',
      direction: 'before',
      time: '09:30',
      repeat: 'never',
    }),
  );
  await sweep('2026-10-17T06:00:00Z');
  // 09:30 in Nairobi on the 17th is 06:30 UTC.
  expect(await sweep('2026-10-17T06:29:00Z')).toEqual({ enrolled: 0, late: 0 });
  expect(await sweep('2026-10-17T06:30:00Z')).toEqual({ enrolled: 1, late: 0 });
  expect(await runs(scene.tenant, automationId)).toMatchObject([
    { record_id: contact, date: '2026-10-20' },
  ]);
});

it('comes round every year from the year the date is in, for a contact who may go through again', async () => {
  const scene = await business(NAIROBI);
  const born = await contactWith(scene, '1990-10-20');
  const ahead = await contactWith(scene, '2027-10-20', 'Grace');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder(
      { field: 'contact.custom.the_date' },
      { settings: { reEnrollment: 'after_finished' } },
    ),
  );
  await sweep('2026-10-20T04:59:00Z');
  expect(await sweep('2026-10-20T05:00:00Z')).toMatchObject({ enrolled: 1 });
  expect(await runs(scene.tenant, automationId)).toMatchObject([
    { record_id: born, date: '2026-10-20' },
  ]);
  await finishRuns(automationId);

  await sweep('2027-10-20T04:59:00Z');
  expect(await sweep('2027-10-20T05:00:00Z')).toMatchObject({ enrolled: 2 });
  expect(
    (await runs(scene.tenant, automationId)).map((run) => [run.record_id, run.date]).toSorted(),
  ).toEqual(
    [
      [born, '2026-10-20'],
      [born, '2027-10-20'],
      [ahead, '2027-10-20'],
    ].toSorted(),
  );
});

it('enrols a contact once ever in an automation that never takes a contact twice', async () => {
  const scene = await business(NAIROBI);
  const born = await contactWith(scene, '1990-10-20');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder({ field: 'contact.custom.the_date' }),
  );
  await sweep('2026-10-20T04:59:00Z');
  expect(await sweep('2026-10-20T05:00:00Z')).toMatchObject({ enrolled: 1 });
  await finishRuns(automationId);
  await sweep('2027-10-20T04:59:00Z');
  expect(await sweep('2027-10-20T05:00:00Z')).toMatchObject({ enrolled: 0 });
  expect(await runs(scene.tenant, automationId)).toMatchObject([
    { record_id: born, date: '2026-10-20', status: 'completed' },
  ]);
});

it('fires for the date itself only when it does not repeat', async () => {
  const scene = await business(NAIROBI);
  await contactWith(scene, '2026-10-20');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder(
      { field: 'contact.custom.the_date', repeat: 'never' },
      { settings: { reEnrollment: 'after_finished' } },
    ),
  );
  await sweep('2026-10-20T04:59:00Z');
  expect(await sweep('2026-10-20T05:00:00Z')).toMatchObject({ enrolled: 1 });
  await finishRuns(automationId);
  await sweep('2027-10-20T04:59:00Z');
  expect(await sweep('2027-10-20T05:00:00Z')).toMatchObject({ enrolled: 0 });
  expect(await runs(scene.tenant, automationId)).toHaveLength(1);
});

it('brings 29 February round on the 28th of a year without one, and on the 29th of a year with', async () => {
  const scene = await business(NAIROBI);
  const leapling = await contactWith(scene, '2024-02-29');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder(
      { field: 'contact.custom.the_date' },
      { settings: { reEnrollment: 'after_finished' } },
    ),
  );
  await sweep('2027-02-28T04:59:00Z');
  expect(await sweep('2027-02-28T05:00:00Z')).toMatchObject({ enrolled: 1 });
  await finishRuns(automationId);

  await sweep('2028-02-28T04:59:00Z');
  expect(await sweep('2028-02-28T05:00:00Z')).toMatchObject({ enrolled: 0 });
  expect(await sweep('2028-02-29T05:00:00Z')).toMatchObject({ enrolled: 1 });
  expect(await runs(scene.tenant, automationId)).toMatchObject([
    { record_id: leapling, date: '2027-02-28' },
    { record_id: leapling, date: '2028-02-29' },
  ]);
});

it('skips a contact with no date, a contact in the trash, and a field that was archived', async () => {
  const scene = await business(NAIROBI);
  await contactWith(scene, undefined, 'No date');
  const trashed = await contactWith(scene, '2026-10-20', 'Trashed');
  const kept = await contactWith(scene, '2026-10-20', 'Kept');
  await h.database.as('postgres', (sql) =>
    sql.query('update crm.contacts set deleted_at = now() where id = $1', [trashed]),
  );
  const { automationId } = await h.publish(
    scene.tenant,
    reminder({ field: 'contact.custom.the_date', repeat: 'never' }),
  );
  await sweep('2026-10-20T04:59:00Z');
  expect(await sweep('2026-10-20T05:00:00Z')).toMatchObject({ enrolled: 1 });
  expect((await runs(scene.tenant, automationId)).map((run) => run.record_id)).toEqual([kept]);

  // The field archived: the same date a day on, for another contact, fires nothing.
  await contactWith(scene, '2026-10-21', 'Later');
  await h.database.as('postgres', (sql) =>
    sql.query('update crm.field_definitions set archived_at = now() where id = $1', [
      scene.fieldId,
    ]),
  );
  expect(await sweep('2026-10-21T05:00:00Z')).toMatchObject({ enrolled: 0 });
  expect(await runs(scene.tenant, automationId)).toHaveLength(1);
});

it("enrols only the contacts the trigger's own condition holds for, and does not come back for the others", async () => {
  const scene = await business(NAIROBI);
  const ada = await contactWith(scene, '2026-10-20', 'Ada');
  const grace = await contactWith(scene, '2026-10-20', 'Grace');
  const { automationId } = await h.publish(scene.tenant, {
    ...reminder({ field: 'contact.custom.the_date', repeat: 'never' }),
    triggers: [
      {
        id: 'the_day',
        type: 'date.reached',
        config: { field: 'contact.custom.the_date', repeat: 'never' },
        if: { field: 'contact.firstName', operator: 'equals', value: 'Ada' },
      },
    ],
  });
  await sweep('2026-10-20T04:59:00Z');
  expect(await sweep('2026-10-20T05:00:00Z')).toMatchObject({ enrolled: 1 });
  // Renamed after the moment has passed: the date came round while the condition did not hold.
  await h.database.as('postgres', (sql) =>
    sql.query(`update crm.contacts set first_name = 'Ada' where id = $1`, [grace]),
  );
  expect(await sweep('2026-10-20T05:01:00Z')).toMatchObject({ enrolled: 0 });
  expect((await runs(scene.tenant, automationId)).map((run) => run.record_id)).toEqual([ada]);
});

it("uses each contact's own time zone when the automation says so, and the business's otherwise", async () => {
  const scene = await business(NAIROBI);
  const local = await contactWith(scene, '2026-10-20', 'Local');
  const abroad = await contactWith(scene, '2026-10-20', 'Abroad');
  await h.database.as('postgres', (sql) =>
    sql.query(`update crm.contacts set timezone = $2 where id = $1`, [abroad, NEW_YORK]),
  );
  const config: DateConfig = { field: 'contact.custom.the_date', repeat: 'never' };
  const own = await h.publish(
    scene.tenant,
    reminder(config, { settings: { timezone: 'contact' } }),
  );
  const shared = await h.publish(scene.tenant, reminder(config));
  await sweep('2026-10-20T04:59:00Z');

  // 08:00 in Nairobi: the contact without a zone in one, and everyone in the other.
  await sweep('2026-10-20T05:00:00Z');
  expect((await runs(scene.tenant, own.automationId)).map((run) => run.record_id)).toEqual([local]);
  expect(
    (await runs(scene.tenant, shared.automationId)).map((run) => run.record_id).toSorted(),
  ).toEqual([local, abroad].toSorted());

  // 08:00 in New York is 12:00 UTC on that day.
  await sweep('2026-10-20T11:59:00Z');
  expect(await runs(scene.tenant, own.automationId)).toHaveLength(1);
  await sweep('2026-10-20T12:00:00Z');
  expect((await runs(scene.tenant, own.automationId)).map((run) => run.record_id)).toEqual([
    local,
    abroad,
  ]);
});

it('keeps the time of day across the days the clocks change', async () => {
  const scene = await business(NEW_YORK);
  const spring = await contactWith(scene, '2026-03-09', 'Spring');
  const autumn = await contactWith(scene, '2026-11-02', 'Autumn');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder({
      field: 'contact.custom.the_date',
      offset: 'P2D',
      direction: 'before',
      repeat: 'never',
    }),
  );
  // Two days before 9 March is the 7th, before the clocks went forward: 08:00 is 13:00 UTC.
  await sweep('2026-03-07T11:59:00Z');
  expect(await sweep('2026-03-07T12:00:00Z')).toMatchObject({ enrolled: 0 });
  expect(await sweep('2026-03-07T13:00:00Z')).toMatchObject({ enrolled: 1 });
  // Two days before 2 November is 31 October, before the clocks went back: 12:00 UTC.
  await sweep('2026-10-31T11:59:00Z');
  expect(await sweep('2026-10-31T12:00:00Z')).toMatchObject({ enrolled: 1 });
  expect(await runs(scene.tenant, automationId)).toMatchObject([
    { record_id: spring, date: '2026-03-09' },
    { record_id: autumn, date: '2026-11-02' },
  ]);
});

it('fires a date and time at its own instant, moved by the offset', async () => {
  const scene = await business(NAIROBI, 'datetime');
  const contact = await contactWith(scene, '2026-10-20T15:00:00Z');
  await contactWith(scene, '2026-10-21T15:00:00Z', 'Tomorrow');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder({ field: 'contact.custom.the_date', offset: 'PT2H', direction: 'before' }),
  );
  await sweep('2026-10-20T12:59:00Z');
  expect(await sweep('2026-10-20T13:00:00Z')).toMatchObject({ enrolled: 1 });
  expect(await runs(scene.tenant, automationId)).toMatchObject([
    { record_id: contact, date: '2026-10-20' },
  ]);
});

it('fires a time after the contact was created', async () => {
  const scene = await business(NAIROBI);
  const contact = await contactWith(scene, undefined);
  await h.database.as('postgres', (sql) =>
    sql.query(`update crm.contacts set created_at = '2026-10-19T10:30:00Z' where id = $1`, [
      contact,
    ]),
  );
  const { automationId } = await h.publish(
    scene.tenant,
    reminder({ field: 'contact.createdAt', offset: 'P1D', direction: 'after' }),
  );
  await sweep('2026-10-20T10:29:00Z');
  expect(await sweep('2026-10-20T10:30:00Z')).toMatchObject({ enrolled: 1 });
  expect(await runs(scene.tenant, automationId)).toMatchObject([
    { record_id: contact, date: '2026-10-19' },
  ]);
});

it('lets the dates of a paused automation pass, and does not catch up when it runs again', async () => {
  const scene = await business(NAIROBI);
  await contactWith(scene, '2026-10-20');
  await alone(scene.tenant);
  const later = await contactWith(scene, '2026-10-21', 'Later');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder({ field: 'contact.custom.the_date', repeat: 'never' }),
  );
  await sweep('2026-10-20T04:59:00Z');
  const set = (status: 'paused' | 'active') =>
    h.database.as('postgres', (sql) =>
      sql.query('update automation.automations set status = $2 where id = $1', [
        automationId,
        status,
      ]),
    );
  await set('paused');
  expect(await sweep('2026-10-20T05:00:00Z')).toEqual({ enrolled: 0, late: 0 });
  await set('active');
  expect(await sweep('2026-10-20T05:30:00Z')).toEqual({ enrolled: 0, late: 0 });
  expect(await runs(scene.tenant, automationId)).toEqual([]);
  // The next date fires as usual.
  expect(await sweep('2026-10-21T05:00:00Z')).toMatchObject({ enrolled: 1 });
  expect((await runs(scene.tenant, automationId)).map((run) => run.record_id)).toEqual([later]);
});

it('fires up to a day late after the worker was down, and skips what is older', async () => {
  const scene = await business(NAIROBI);
  await alone(scene.tenant);
  const recent = await contactWith(scene, '2026-10-22', 'Recent');
  await contactWith(scene, '2026-10-21', 'Too old');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder({ field: 'contact.custom.the_date', repeat: 'never' }),
  );
  await sweep('2026-10-21T04:00:00Z');
  // Down from 07:00 on the 21st until 11:00 on the 22nd, Nairobi time: twenty-eight hours.
  expect(await sweep('2026-10-22T08:00:00Z')).toEqual({ enrolled: 1, late: 1 });
  expect((await runs(scene.tenant, automationId)).map((run) => run.record_id)).toEqual([recent]);
  expect(await sweep('2026-10-22T08:01:00Z')).toEqual({ enrolled: 0, late: 0 });
});

it('enrols a contact once when two sweeps run at the same moment', async () => {
  const scene = await business(NAIROBI);
  const contacts = [
    await contactWith(scene, '2026-10-20', 'One'),
    await contactWith(scene, '2026-10-20', 'Two'),
    await contactWith(scene, '2026-10-20', 'Three'),
  ];
  const { automationId } = await h.publish(
    scene.tenant,
    reminder({ field: 'contact.custom.the_date', repeat: 'never' }),
  );
  await sweep('2026-10-20T04:59:00Z');
  const done = await Promise.all([
    sweep('2026-10-20T05:00:00Z'),
    sweep('2026-10-20T05:00:00Z'),
    sweep('2026-10-20T05:00:00Z'),
  ]);
  expect(done.reduce((sum, each) => sum + each.enrolled, 0)).toBe(3);
  expect((await runs(scene.tenant, automationId)).map((run) => run.record_id).toSorted()).toEqual(
    contacts.toSorted(),
  );
});

it('does not enrol again when a sweep that died is run again over the same time', async () => {
  const scene = await business(NAIROBI);
  await contactWith(scene, '2026-10-20');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder(
      { field: 'contact.custom.the_date', repeat: 'never' },
      { settings: { reEnrollment: 'after_finished' } },
    ),
  );
  await sweep('2026-10-20T04:59:00Z');
  expect(await sweep('2026-10-20T05:00:00Z')).toMatchObject({ enrolled: 1 });
  // As a sweep leaves things when it dies after enrolling and before moving its cursor; the
  // run has since ended, so only the firing stands between the contact and a second run.
  await finishRuns(automationId);
  await h.database.as('postgres', (sql) =>
    sql.query(
      `update automation.trigger_cursors set swept_through = '2026-10-20T04:59:00Z'
       where automation_id = $1`,
      [automationId],
    ),
  );
  expect(await sweep('2026-10-20T05:00:00Z')).toMatchObject({ enrolled: 0 });
  expect(await sweep('2026-10-20T05:02:00Z')).toMatchObject({ enrolled: 0 });
  expect(await runs(scene.tenant, automationId)).toHaveLength(1);
});

it('does not enrol again when a date is changed and changed back', async () => {
  const scene = await business(NAIROBI);
  const contact = await contactWith(scene, '2026-10-20');
  const { automationId } = await h.publish(
    scene.tenant,
    reminder(
      { field: 'contact.custom.the_date', repeat: 'never' },
      { settings: { reEnrollment: 'after_finished' } },
    ),
  );
  await sweep('2026-10-20T04:59:00Z');
  expect(await sweep('2026-10-20T05:00:00Z')).toMatchObject({ enrolled: 1 });
  await finishRuns(automationId);
  await hold(scene, contact, '2026-12-01');
  expect(await sweep('2026-10-20T05:01:00Z')).toMatchObject({ enrolled: 0 });
  await hold(scene, contact, '2026-10-20');
  expect(await sweep('2026-10-20T05:02:00Z')).toMatchObject({ enrolled: 0 });
  expect(await runs(scene.tenant, automationId)).toHaveLength(1);
});

it('leaves a contact who is already in the automation where they are', async () => {
  const scene = await business(NAIROBI);
  const contact = await contactWith(scene, '2026-10-20');
  const { automationId } = await h.publish(scene.tenant, {
    ...reminder({ field: 'contact.custom.the_date', repeat: 'never' }),
    triggers: [
      {
        id: 'week_before',
        type: 'date.reached',
        config: { field: 'contact.custom.the_date', offset: 'P7D', repeat: 'never' },
      },
      {
        id: 'the_day',
        type: 'date.reached',
        config: { field: 'contact.custom.the_date', repeat: 'never' },
      },
    ],
  });
  await sweep('2026-10-13T04:59:00Z');
  expect(await sweep('2026-10-13T05:00:00Z')).toMatchObject({ enrolled: 1 });
  // Still in the run the first trigger started when the day itself comes.
  expect(await sweep('2026-10-20T05:00:00Z')).toMatchObject({ enrolled: 0 });
  expect(await runs(scene.tenant, automationId)).toMatchObject([
    { record_id: contact, trigger_key: 'week_before', date: '2026-10-20' },
  ]);
});

it('drops the cursor of a trigger a new version no longer has', async () => {
  const scene = await business(NAIROBI);
  const published = await h.publish(
    scene.tenant,
    reminder({ field: 'contact.custom.the_date', repeat: 'never' }),
  );
  await sweep('2026-10-20T04:59:00Z');
  expect(await cursor(scene.tenant, published.automationId)).toHaveLength(1);
  await h.publish(
    scene.tenant,
    {
      ...reminder({ field: 'contact.custom.the_date' }),
      triggers: [
        { id: 'other_day', type: 'date.reached', config: { field: 'contact.custom.the_date' } },
      ],
    },
    published.automationId,
  );
  await sweep('2026-10-20T05:00:00Z');
  expect(await cursor(scene.tenant, published.automationId)).toEqual([
    { trigger_id: 'other_day', swept_through: at('2026-10-20T05:00:00Z') },
  ]);
});

it('starts the clock afresh for a date trigger removed and added back under the same id', async () => {
  const scene = await business(NAIROBI);
  await contactWith(scene, '2026-10-20');
  const document = reminder({ field: 'contact.custom.the_date', repeat: 'never' });
  const { automationId } = await h.publish(scene.tenant, document);
  await alone(scene.tenant);
  await sweep('2026-10-19T00:00:00Z');
  // Removed, then added back, with no sweep between: its old cursor must not come back.
  await h.publish(scene.tenant, { ...document, triggers: [] }, automationId);
  await h.publish(scene.tenant, document, automationId);
  await alone(scene.tenant);
  // 08:00 in Nairobi on the 20th came after the old cursor, but before the trigger was back.
  expect(await sweep('2026-10-20T06:00:00Z')).toEqual({ enrolled: 0, late: 0 });
  expect(await runs(scene.tenant, automationId)).toEqual([]);
});
