import { randomBytes, randomUUID } from 'node:crypto';
import { allowEveryone, defineCommand, runCommand } from '@repo/commands';
import type { Database } from '@repo/db';
import { ConflictError, NotFoundError, toPublicId } from '@repo/kernel';
import { updateContactCommand } from '@repo/module-crm';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';
import { bookingFixtureSuite, request } from '../test/booking-fixtures.js';

const suite = bookingFixtureSuite();
const { fixture, handlers, managedFixture } = suite;
let database: TestDatabase;
let db: Database;
beforeAll(() => {
  database = suite.database;
  db = suite.db;
});
it('reads minimal capability details after calendar deactivation and refuses expired capabilities', async () => {
  const f = await fixture();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const booked = await handlers().book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${date}T10:00:00Z`,
      contact: { email: 'attendee@example.test' },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  const token = booked.managementUrl?.split('/').at(-1);
  if (token === undefined) throw new Error('New booking did not return its capability.');
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update calendar.calendars set is_active=false'),
  );
  const managed = await handlers().appointment(token, request());
  expect(managed).toMatchObject({
    status: 'booked',
    startsAt: `${date}T10:00:00.000Z`,
    endsAt: `${date}T10:30:00.000Z`,
    calendarName: 'Venue tour',
    timezone: 'UTC',
  });
  expect(managed.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(managed).sort()).toEqual([
    'calendarName',
    'endsAt',
    'revision',
    'startsAt',
    'status',
    'timezone',
  ]);
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update calendar.appointments set management_expires_at=now()-interval '1 second'"),
  );
  await expect(handlers().appointment(token, request())).rejects.toBeInstanceOf(NotFoundError);
});

it('records cancellation with unavailable confirmation and replays the durable receipt before stale revision checks', async () => {
  const f = await fixture();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const booked = await handlers().book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${date}T10:00:00Z`,
      contact: { email: 'attendee@example.test' },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  const token = booked.managementUrl?.split('/').at(-1);
  if (token === undefined) throw new Error('New booking did not return its capability.');
  const before = await handlers().appointment(token, request());
  const input = { operationRequestId: randomUUID(), revision: before.revision };
  await database.withTenant(f.business.context, async (sql) => {
    await sql.query('update calendar.calendars set is_active=false');
    await sql.query("update messaging.channel_accounts set status='paused'");
  });
  const cancelled = await handlers().cancel(token, input, request());
  expect(cancelled).toEqual({
    status: 'cancelled',
    startsAt: `${date}T10:00:00.000Z`,
    endsAt: `${date}T10:30:00.000Z`,
  });
  expect(await handlers().cancel(token, input, request())).toEqual(cancelled);
  await expect(
    handlers().cancel(token, { ...input, revision: '0'.repeat(64) }, request()),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        'select operation,confirmation_status,receipt from calendar.appointment_operations',
      ),
    ),
  ).toEqual([{ operation: 'cancel', confirmation_status: 'unavailable', receipt: cancelled }]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select status from calendar.appointments'),
    ),
  ).toEqual([{ status: 'cancelled' }]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from messaging.messages'),
    ),
  ).toHaveLength(1);
  await database.withTenant(f.business.context, async (sql) => {
    await sql.query('update calendar.calendars set is_active=true');
    await sql.query("update messaging.channel_accounts set status='active'");
  });
  expect((await handlers().slots(f.params, { date }, request())).slots).toHaveLength(16);
});

it.each(['queued', 'refused'] as const)(
  'records cancellation with its actual %s confirmation result without selecting a new primary recipient',
  async (outcome) => {
    const f = await fixture();
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const booked = await handlers().book(
      f.params,
      {
        bookingRequestId: randomUUID(),
        startsAt: `${date}T10:00:00Z`,
        contact: { email: 'attendee@example.test' },
        notificationConsent: true,
        contactTimezone: 'UTC',
      },
      request(),
    );
    const token = booked.managementUrl?.split('/').at(-1);
    if (token === undefined) throw new Error('New booking did not return its capability.');
    const contact = await database.withTenant(f.business.context, (sql) =>
      sql.one<{ id: string }>('select id from crm.contacts'),
    );
    await runCommand(
      { db, authorize: allowEveryone },
      updateContactCommand,
      {
        id: toPublicId('contact', contact.id),
        emails: ['new-primary@example.test', 'attendee@example.test'],
      },
      { context: { ...f.business.context, correlationId: randomUUID() }, permissions: 'all' },
    );
    if (outcome === 'refused')
      await database.withTenant(f.business.context, (sql) =>
        sql.query('update crm.contacts set do_not_contact=true'),
      );
    const before = await handlers().appointment(token, request());
    const input = { operationRequestId: randomUUID(), revision: before.revision };
    const receipt = await handlers().cancel(token, input, request());
    expect(receipt.status).toBe('cancelled');
    expect(await handlers().cancel(token, input, request())).toEqual(receipt);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select confirmation_status from calendar.appointment_operations'),
      ),
    ).toEqual([{ confirmation_status: outcome }]);
    const messages = await database.withTenant(f.business.context, (sql) =>
      sql.query<{
        channel_account_id: string;
        to_addresses: string[];
        status: string;
        idempotency_key: string;
      }>(
        'select channel_account_id,to_addresses,status,idempotency_key from messaging.messages order by created_at,id',
      ),
    );
    expect(messages).toHaveLength(outcome === 'queued' ? 2 : 1);
    for (const message of messages) {
      expect(message.channel_account_id).toBe(f.account.id);
      expect(message.to_addresses).toEqual(['attendee@example.test']);
      expect(message.status).toBe('queued');
    }
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query("select type from events.events where type='appointment.cancelled'"),
      ),
    ).toEqual([{ type: 'appointment.cancelled' }]);
  },
);
it('lets canonical contact updates commit before cancellation acquires the contact and upgrades its confirmation lock', async () => {
  const f = await fixture();
  const api = handlers();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const booked = await api.book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${date}T10:00:00Z`,
      contact: { email: 'attendee@example.test' },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  const token = booked.managementUrl?.split('/').at(-1);
  if (token === undefined) throw new Error('New booking did not return its capability.');
  const before = await api.appointment(token, request());
  const contact = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>('select id from crm.contacts'),
  );
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const updateRequestId = randomUUID();
  const cancelRequest = request();
  const ordinary = defineCommand({
    ...updateContactCommand,
    name: 'test.contact.update_before_cancellation',
    async handle(trx, input, command) {
      return updateContactCommand.handle(trx, input, {
        ...command,
        async emit(event) {
          ready.resolve(undefined);
          await proceed.promise;
          return command.emit(event);
        },
      });
    },
  });
  const updating = runCommand(
    { db, authorize: allowEveryone },
    ordinary,
    { id: toPublicId('contact', contact.id), firstName: 'Updated' },
    { context: { ...f.business.context, correlationId: updateRequestId }, permissions: 'all' },
  ).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await ready.promise;
  const cancellation = api
    .cancel(token, { operationRequestId: randomUUID(), revision: before.revision }, cancelRequest)
    .then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  try {
    await expect
      .poll(
        async () =>
          database.as(
            'crm_app',
            async (sql) =>
              (
                await sql.one<{ waiting: boolean }>(
                  "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%crm%contacts%for%update%') as waiting",
                )
              ).waiting,
          ),
        { timeout: 5000 },
      )
      .toBe(true);
  } finally {
    proceed.resolve(undefined);
  }
  const [updated, cancelled] = await Promise.all([updating, cancellation]);
  if (!updated.ok) throw updated.error;
  if (!cancelled.ok) throw cancelled.error;
  expect(updated.result.firstName).toBe('Updated');
  expect(cancelled.result.status).toBe('cancelled');
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        "select type from events.events where type in ('contact.updated','appointment.cancelled') and correlation_id in ($1,$2) order by type",
        [updateRequestId, cancelRequest.requestId],
      ),
    ),
  ).toEqual([{ type: 'appointment.cancelled' }, { type: 'contact.updated' }]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select confirmation_status from calendar.appointment_operations'),
    ),
  ).toEqual([{ confirmation_status: 'queued' }]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from messaging.messages'),
    ),
  ).toHaveLength(2);
});
it('reschedules atomically and replays an earlier durable receipt without undoing a later change', async () => {
  const f = await fixture();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const api = handlers();
  const booked = await api.book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${date}T10:00:00Z`,
      contact: { email: 'attendee@example.test' },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  const token = booked.managementUrl?.split('/').at(-1);
  if (token === undefined) throw new Error('New booking did not return its capability.');
  const before = await api.appointment(token, request());
  const firstInput = {
    operationRequestId: randomUUID(),
    revision: before.revision,
    startsAt: `${date}T11:00:00Z`,
  };
  const first = await api.reschedule(token, firstInput, request());
  expect(first).toEqual({
    status: 'booked',
    startsAt: `${date}T11:00:00.000Z`,
    endsAt: `${date}T11:30:00.000Z`,
  });
  const afterFirst = await api.appointment(token, request());
  expect(afterFirst.revision).not.toBe(before.revision);
  const second = await api.reschedule(
    token,
    {
      operationRequestId: randomUUID(),
      revision: afterFirst.revision,
      startsAt: `${date}T12:00:00Z`,
    },
    request(),
  );
  expect(second.startsAt).toBe(`${date}T12:00:00.000Z`);
  expect(await api.reschedule(token, firstInput, request())).toEqual(first);
  expect((await api.appointment(token, request())).startsAt).toBe(`${date}T12:00:00.000Z`);
  await expect(
    api.reschedule(token, { ...firstInput, startsAt: `${date}T13:00:00Z` }, request()),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        'select operation,confirmation_status from calendar.appointment_operations order by created_at',
      ),
    ),
  ).toEqual([
    { operation: 'reschedule', confirmation_status: 'queued' },
    { operation: 'reschedule', confirmation_status: 'queued' },
  ]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from messaging.messages'),
    ),
  ).toHaveLength(3);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select type from events.events where type='appointment.rescheduled'"),
    ),
  ).toEqual([{ type: 'appointment.rescheduled' }, { type: 'appointment.rescheduled' }]);
  expect((await api.slots(f.params, { date }, request())).slots).toHaveLength(15);
});

it('rolls back the reschedule and its occupied range when canonical confirmation policy refuses', async () => {
  const f = await fixture();
  const api = handlers();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const booked = await api.book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${date}T10:00:00Z`,
      contact: { email: 'attendee@example.test' },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  const token = booked.managementUrl?.split('/').at(-1);
  if (token === undefined) throw new Error('New booking did not return its capability.');
  const before = await api.appointment(token, request());
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update crm.contacts set do_not_contact=true'),
  );
  await expect(
    api.reschedule(
      token,
      {
        operationRequestId: randomUUID(),
        revision: before.revision,
        startsAt: `${date}T11:00:00Z`,
      },
      request(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(await api.appointment(token, request())).toEqual(before);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        'select starts_at,ends_at,occupied_starts_at,occupied_ends_at from calendar.appointments',
      ),
    ),
  ).toEqual([
    {
      starts_at: new Date(`${date}T10:00:00Z`),
      ends_at: new Date(`${date}T10:30:00Z`),
      occupied_starts_at: new Date(`${date}T10:00:00Z`),
      occupied_ends_at: new Date(`${date}T10:30:00Z`),
    },
  ]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select operation from calendar.appointment_operations'),
    ),
  ).toEqual([]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select type from events.events where type='appointment.rescheduled'"),
    ),
  ).toEqual([]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from messaging.messages'),
    ),
  ).toHaveLength(1);
});

it('excludes its own reservation and snapshots current elapsed buffers when retaining the original host', async () => {
  const f = await fixture();
  const api = handlers();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const booked = await api.book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${date}T10:00:00Z`,
      contact: { email: 'attendee@example.test' },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  const token = booked.managementUrl?.split('/').at(-1);
  if (token === undefined) throw new Error('New booking did not return its capability.');
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update calendar.calendars set buffer_before_minutes=15,buffer_after_minutes=15'),
  );
  const before = await api.appointment(token, request());
  const moved = await api.reschedule(
    token,
    { operationRequestId: randomUUID(), revision: before.revision, startsAt: `${date}T10:30:00Z` },
    request(),
  );
  expect(moved).toEqual({
    status: 'booked',
    startsAt: `${date}T10:30:00.000Z`,
    endsAt: `${date}T11:00:00.000Z`,
  });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        'select assigned_user_id,buffer_before_minutes,buffer_after_minutes,occupied_starts_at,occupied_ends_at from calendar.appointments',
      ),
    ),
  ).toEqual([
    {
      assigned_user_id: f.user.id,
      buffer_before_minutes: 15,
      buffer_after_minutes: 15,
      occupied_starts_at: new Date(`${date}T10:15:00Z`),
      occupied_ends_at: new Date(`${date}T11:15:00Z`),
    },
  ]);
});

it('offers capability-scoped reschedule slots for the retained host without its own occupancy and preserves inactive-calendar cancellation', async () => {
  const f = await fixture();
  const api = handlers();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const booked = await api.book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${date}T10:00:00Z`,
      contact: { email: 'attendee@example.test' },
      notificationConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  const token = booked.managementUrl?.split('/').at(-1);
  if (token === undefined) throw new Error('New booking did not return its capability.');
  const slots = await api.appointmentSlots(token, { date }, request());
  expect(slots.slots).toHaveLength(16);
  expect(slots.slots).toContainEqual({
    startsAt: `${date}T10:00:00Z`,
    endsAt: `${date}T10:30:00Z`,
  });
  expect(Object.keys(slots)).toEqual(['slots']);
  for (const slot of slots.slots) expect(Object.keys(slot).sort()).toEqual(['endsAt', 'startsAt']);
  await expect(api.appointmentSlots('A'.repeat(43), { date }, request())).rejects.toBeInstanceOf(
    NotFoundError,
  );
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update calendar.calendars set is_active=false'),
  );
  await expect(api.appointmentSlots(token, { date }, request())).rejects.toBeInstanceOf(
    NotFoundError,
  );
  const before = await api.appointment(token, request());
  expect(
    (
      await api.cancel(
        token,
        { operationRequestId: randomUUID(), revision: before.revision },
        request(),
      )
    ).status,
  ).toBe('cancelled');
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update calendar.appointments set management_expires_at=now()-interval '1 second'"),
  );
  await expect(api.appointmentSlots(token, { date }, request())).rejects.toBeInstanceOf(
    NotFoundError,
  );
});

it('refuses stale cancellation and reschedule revisions without changing the reservation or queuing another message', async () => {
  const f = await managedFixture();
  await expect(
    f.api.cancel(
      f.token,
      { operationRequestId: randomUUID(), revision: '0'.repeat(64) },
      request(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    f.api.reschedule(
      f.token,
      {
        operationRequestId: randomUUID(),
        revision: '0'.repeat(64),
        startsAt: `${f.date}T11:00:00Z`,
      },
      request(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(await f.api.appointment(f.token, request())).toEqual(f.appointment);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select operation from calendar.appointment_operations'),
    ),
  ).toEqual([]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from messaging.messages'),
    ),
  ).toHaveLength(1);
});
it.each(['completed', 'no_show', 'cancelled'] as const)(
  'keeps %s receipts readable but refuses fresh cancellation, reschedule and slots',
  async (status) => {
    const f = await managedFixture();
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        "update calendar.appointments set status=$1,cancelled_at=case when $1='cancelled' then clock_timestamp() else null end",
        [status],
      ),
    );
    const current = await f.api.appointment(f.token, request());
    expect(current.status).toBe(status);
    await expect(
      f.api.appointmentSlots(f.token, { date: f.date }, request()),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      f.api.cancel(
        f.token,
        { operationRequestId: randomUUID(), revision: current.revision },
        request(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      f.api.reschedule(
        f.token,
        {
          operationRequestId: randomUUID(),
          revision: current.revision,
          startsAt: `${f.date}T11:00:00Z`,
        },
        request(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await f.api.appointment(f.token, request())).toEqual(current);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select operation from calendar.appointment_operations'),
      ),
    ).toEqual([]);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select id from messaging.messages'),
      ),
    ).toHaveLength(1);
  },
);

it('rolls back a reschedule when another calendar reserves the retained host during the actual contact-lock wait', async () => {
  const f = await managedFixture();
  const contact = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>('select id from crm.contacts'),
  );
  const otherContact = await database.fixtures.contact(f.business.context, {
    email: 'other-reservation@example.test',
  });
  const otherCalendar = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>(
      "insert into calendar.calendars(business_id,name,kind,timezone,booking_slug) values(app.business_id(),'Staff meeting','personal','UTC','staff-meeting') returning id",
    ),
  );
  const ready = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const ordinary = defineCommand({
    ...updateContactCommand,
    name: 'test.contact.update_before_reschedule_collision',
    async handle(trx, input, command) {
      return updateContactCommand.handle(trx, input, {
        ...command,
        async emit(event) {
          ready.resolve(undefined);
          await proceed.promise;
          return command.emit(event);
        },
      });
    },
  });
  const updating = runCommand(
    { db, authorize: allowEveryone },
    ordinary,
    { id: toPublicId('contact', contact.id), firstName: 'Updated concurrently' },
    { context: { ...f.business.context, correlationId: randomUUID() }, permissions: 'all' },
  ).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await ready.promise;
  const rescheduling = f.api
    .reschedule(
      f.token,
      {
        operationRequestId: randomUUID(),
        revision: f.appointment.revision,
        startsAt: `${f.date}T11:00:00Z`,
      },
      request(),
    )
    .then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  try {
    await expect
      .poll(
        async () =>
          database.as(
            'crm_app',
            async (sql) =>
              (
                await sql.one<{ waiting: boolean }>(
                  "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%crm%contacts%for%update%') as waiting",
                )
              ).waiting,
          ),
        { timeout: 5000 },
      )
      .toBe(true);
    await database.withTenant(f.business.context, (sql) =>
      sql.query(
        "insert into calendar.appointments(business_id,calendar_id,contact_id,assigned_user_id,title,starts_at,ends_at,source) values(app.business_id(),$1,$2,$3,'Staff meeting',$4,$5,'user')",
        [
          otherCalendar.id,
          otherContact.id,
          f.user.id,
          `${f.date}T11:00:00Z`,
          `${f.date}T11:30:00Z`,
        ],
      ),
    );
  } finally {
    proceed.resolve(undefined);
  }
  const [updated, moved] = await Promise.all([updating, rescheduling]);
  if (!updated.ok) throw updated.error;
  expect(updated.result.firstName).toBe('Updated concurrently');
  expect(moved.ok).toBe(false);
  if (moved.ok) throw new Error('Conflicting reschedule unexpectedly committed.');
  expect(moved.error).toBeInstanceOf(ConflictError);
  expect(await f.api.appointment(f.token, request())).toEqual(f.appointment);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select operation from calendar.appointment_operations'),
    ),
  ).toEqual([]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select type from events.events where type='appointment.rescheduled'"),
    ),
  ).toEqual([]);
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from messaging.messages'),
    ),
  ).toHaveLength(1);
  expect(
    (await f.api.appointmentSlots(f.token, { date: f.date }, request())).slots,
  ).not.toContainEqual({ startsAt: `${f.date}T11:00:00Z`, endsAt: `${f.date}T11:30:00Z` });
});

it.each(['trashed contact'] as const)(
  'refuses reschedule but records cancellation without delivery for %s',
  async (reason) => {
    const f = await managedFixture();
    expect(reason).toBe('trashed contact');
    await database.withTenant(f.business.context, (sql) =>
      sql.query('update crm.contacts set deleted_at=clock_timestamp()'),
    );
    const current = await f.api.appointment(f.token, request());
    await expect(
      f.api.reschedule(
        f.token,
        {
          operationRequestId: randomUUID(),
          revision: current.revision,
          startsAt: `${f.date}T11:00:00Z`,
        },
        request(),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await f.api.appointment(f.token, request())).toEqual(current);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select operation from calendar.appointment_operations'),
      ),
    ).toEqual([]);
    const input = { operationRequestId: randomUUID(), revision: current.revision };
    const receipt = await f.api.cancel(f.token, input, request());
    expect(receipt.status).toBe('cancelled');
    expect(await f.api.cancel(f.token, input, request())).toEqual(receipt);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select operation,confirmation_status from calendar.appointment_operations'),
      ),
    ).toEqual([{ operation: 'cancel', confirmation_status: 'unavailable' }]);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select id from messaging.messages'),
      ),
    ).toHaveLength(1);
  },
);

it.each(['legacy sender', 'removed recipient'] as const)(
  'moves and cancels without email for a %s, as a booking without a mailbox does',
  async (reason) => {
    const f = await managedFixture();
    if (reason === 'legacy sender') {
      await database.withTenant(f.business.context, (sql) =>
        sql.query('update calendar.appointments set confirmation_account_id=null'),
      );
    } else {
      const contact = await database.withTenant(f.business.context, (sql) =>
        sql.one<{ id: string }>('select id from crm.contacts'),
      );
      await runCommand(
        { db, authorize: allowEveryone },
        updateContactCommand,
        { id: toPublicId('contact', contact.id), emails: ['replacement@example.test'] },
        { context: { ...f.business.context, correlationId: randomUUID() }, permissions: 'all' },
      );
    }
    const current = await f.api.appointment(f.token, request());
    const moved = await f.api.reschedule(
      f.token,
      {
        operationRequestId: randomUUID(),
        revision: current.revision,
        startsAt: `${f.date}T11:00:00Z`,
      },
      request(),
    );
    expect(moved.startsAt).toBe(`${f.date}T11:00:00.000Z`);
    const after = await f.api.appointment(f.token, request());
    const receipt = await f.api.cancel(
      f.token,
      { operationRequestId: randomUUID(), revision: after.revision },
      request(),
    );
    expect(receipt.status).toBe('cancelled');
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query(
          'select operation,confirmation_status from calendar.appointment_operations order by created_at',
        ),
      ),
    ).toEqual([
      { operation: 'reschedule', confirmation_status: 'unavailable' },
      { operation: 'cancel', confirmation_status: 'unavailable' },
    ]);
    // Only the booking's own confirmation was ever queued.
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select id from messaging.messages'),
      ),
    ).toHaveLength(1);
  },
);

it('retains confirmed status on reschedule and rejects reuse of an operation key across operation kinds', async () => {
  const f = await managedFixture();
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update calendar.appointments set status='confirmed'"),
  );
  const current = await f.api.appointment(f.token, request());
  const operationRequestId = randomUUID();
  const input = { operationRequestId, revision: current.revision, startsAt: `${f.date}T11:00:00Z` };
  const moved = await f.api.reschedule(f.token, input, request());
  expect(moved.status).toBe('confirmed');
  const after = await f.api.appointment(f.token, request());
  await expect(
    f.api.cancel(f.token, { operationRequestId, revision: after.revision }, request()),
  ).rejects.toBeInstanceOf(ConflictError);
  const cancelInput = { operationRequestId: randomUUID(), revision: after.revision };
  const cancelled = await f.api.cancel(f.token, cancelInput, request());
  expect(cancelled.status).toBe('cancelled');
  await expect(
    f.api.reschedule(
      f.token,
      {
        operationRequestId: cancelInput.operationRequestId,
        revision: after.revision,
        startsAt: `${f.date}T12:00:00Z`,
      },
      request(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update calendar.calendars set is_active=false'),
  );
  expect(await f.api.reschedule(f.token, input, request())).toEqual(moved);
  expect(await f.api.cancel(f.token, cancelInput, request())).toEqual(cancelled);
  expect((await f.api.appointment(f.token, request())).status).toBe('cancelled');
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select id from messaging.messages'),
    ),
  ).toHaveLength(3);
});

it.each(['unknown', 'expired'] as const)(
  'refuses every management operation for an %s capability without writes',
  async (kind) => {
    const f = await managedFixture();
    const token = kind === 'unknown' ? randomBytes(32).toString('base64url') : f.token;
    if (kind === 'expired')
      await database.withTenant(f.business.context, (sql) =>
        sql.query(
          "update calendar.appointments set management_expires_at=clock_timestamp()-interval '1 second'",
        ),
      );
    await expect(f.api.appointment(token, request())).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.api.appointmentSlots(token, { date: f.date }, request())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      f.api.cancel(
        token,
        { operationRequestId: randomUUID(), revision: f.appointment.revision },
        request(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      f.api.reschedule(
        token,
        {
          operationRequestId: randomUUID(),
          revision: f.appointment.revision,
          startsAt: `${f.date}T11:00:00Z`,
        },
        request(),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select operation from calendar.appointment_operations'),
      ),
    ).toEqual([]);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select status from calendar.appointments'),
      ),
    ).toEqual([{ status: 'booked' }]);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select id from messaging.messages'),
      ),
    ).toHaveLength(1);
  },
);

it.each(['appointment', 'slots', 'cancel', 'reschedule'] as const)(
  'rechecks capability expiry after the business lock wait for %s',
  async (operation) => {
    const f = await managedFixture();
    const ready = Promise.withResolvers<undefined>();
    const proceed = Promise.withResolvers<undefined>();
    const expiring = database
      .withTenant(f.business.context, async (sql) => {
        await sql.query(
          'select id from tenancy.businesses where id=app.business_id() for no key update',
        );
        ready.resolve(undefined);
        await proceed.promise;
        await sql.query(
          "update calendar.appointments set management_expires_at=clock_timestamp()-interval '1 second'",
        );
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await ready.promise;
    const result = (
      operation === 'appointment'
        ? f.api.appointment(f.token, request())
        : operation === 'slots'
          ? f.api.appointmentSlots(f.token, { date: f.date }, request())
          : operation === 'cancel'
            ? f.api.cancel(
                f.token,
                { operationRequestId: randomUUID(), revision: f.appointment.revision },
                request(),
              )
            : f.api.reschedule(
                f.token,
                {
                  operationRequestId: randomUUID(),
                  revision: f.appointment.revision,
                  startsAt: `${f.date}T11:00:00Z`,
                },
                request(),
              )
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await expect
        .poll(
          async () =>
            database.as(
              'crm_app',
              async (sql) =>
                (
                  await sql.one<{ waiting: boolean }>(
                    "select exists(select from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%tenancy%businesses%for no key update%') as waiting",
                  )
                ).waiting,
            ),
          { timeout: 5000 },
        )
        .toBe(true);
    } finally {
      proceed.resolve(undefined);
    }
    const [expired, response] = await Promise.all([expiring, result]);
    if (!expired.ok) throw expired.error;
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('Expired capability unexpectedly succeeded.');
    expect(response.error).toBeInstanceOf(NotFoundError);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select operation from calendar.appointment_operations'),
      ),
    ).toEqual([]);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select status from calendar.appointments'),
      ),
    ).toEqual([{ status: 'booked' }]);
    expect(
      await database.withTenant(f.business.context, (sql) =>
        sql.query('select id from messaging.messages'),
      ),
    ).toHaveLength(1);
  },
);

it('offers no reschedule slot for a legacy appointment without a host while retaining cancellation', async () => {
  const f = await managedFixture();
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update calendar.appointments set assigned_user_id=null'),
  );
  const current = await f.api.appointment(f.token, request());
  expect(await f.api.appointmentSlots(f.token, { date: f.date }, request())).toEqual({ slots: [] });
  await expect(
    f.api.reschedule(
      f.token,
      {
        operationRequestId: randomUUID(),
        revision: current.revision,
        startsAt: `${f.date}T11:00:00Z`,
      },
      request(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(await f.api.appointment(f.token, request())).toEqual(current);
  expect(
    (
      await f.api.cancel(
        f.token,
        { operationRequestId: randomUUID(), revision: current.revision },
        request(),
      )
    ).status,
  ).toBe('cancelled');
});
