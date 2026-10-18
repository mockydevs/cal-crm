// The recipe "Appointment reminders" run end to end on real Postgres: booked, the run waits
// until 24 hours and then 1 hour before the appointment and queues a transactional email
// each time; a reschedule moves both, a cancellation or a no-show ends the run with nothing
// more sent, and messaging's consent rule decides what goes. The engine's own match and
// step commands, at chosen moments, stand in for the worker; nothing leaves the database.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import {
  appointmentRemindersRecipe,
  automationStepTypes,
  bookingTextWording,
  type AutomationDocumentInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { queueOutboundMessage, recordBookingTextConsent } from '@repo/module-messaging';
import type { Sql } from '@repo/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startTimeWords } from './appointment-values.js';
import { runValues } from './run-values.js';
import { addPhoneNumber } from '../test/phone-number.js';
import { startHarness, type Harness, type Tenant } from '../test/workflows.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const HOUR = 3_600_000;
const all = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});
const superuser = <T>(work: (sql: Sql) => Promise<T>) => h.database.as('postgres', work);

// What the calendar emits for an appointment, as its own commands do.
const happen = defineCommand({
  name: 'test.appointment_happened',
  permission: 'appointments.manage',
  input: z.strictObject({
    type: z.string(),
    appointmentId: z.uuid(),
    contactId: z.uuid(),
    payload: z.record(z.string(), z.unknown()),
  }),
  async handle(_trx, input, command) {
    return command.emit({
      type: input.type,
      subject: { kind: 'appointment', id: input.appointmentId },
      records: [input.contactId],
      payload: input.payload,
    });
  },
});

/** The document as the server stores it: each step with its type's version (validator). */
function stamped(document: AutomationDocumentInput): AutomationDocumentInput {
  return {
    ...document,
    steps: Object.fromEntries(
      Object.entries(document.steps).map(([key, step]) => [
        key,
        { ...step, typeVersion: automationStepTypes[step.type].version },
      ]),
    ),
  };
}

// Whole seconds, so a stored instant reads back as it was written.
const fromNow = (ms: number) => new Date(Math.floor(Date.now() / 1000) * 1000 + ms);

interface Scene {
  readonly tenant: Tenant;
  readonly contactId: string;
  readonly calendarId: string;
  /** Books an appointment for the contact and tells automations; returns it and its run. */
  book(startsAt: Date): Promise<{ appointmentId: string; run: string }>;
  /** Moves, cancels or marks the appointment, and matches what the calendar says of it. */
  change(
    appointmentId: string,
    to: { startsAt: Date } | 'cancelled' | 'no_show',
  ): Promise<{ woken: number }>;
  messages(): Promise<
    {
      channel: string;
      status: string;
      error_code: string | null;
      subject: string | null;
      body_text: string;
      purpose: string;
      lane: string;
    }[]
  >;
}

/**
 * A business with a mailbox, a calendar in New York and one contact, Ada, who booked from
 * Los Angeles. Quiet hours are off, so the time of day never matters here. The booking's
 * consent for notifications is recorded as the booking page records it, unless left out.
 */
async function scene(
  options: {
    readonly consent?: boolean;
    readonly text?: boolean;
    readonly phone?: boolean;
    /** Quiet hours on, all day long (a start equal to the end is quiet throughout). */
    readonly quiet?: boolean;
  } = {},
): Promise<Scene> {
  const tenant = await h.business();
  const made = await h.contact(tenant);
  const { contactId } = made;
  await superuser(async (sql) => {
    await sql.query(
      `insert into messaging.settings (business_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end)
       values ($1, $2, '00:00', '00:00')
       on conflict (business_id) do update set quiet_hours_enabled = $2,
         quiet_hours_start = '00:00', quiet_hours_end = '00:00'`,
      [tenant.businessId, options.quiet === true],
    );
    // A zone quiet hours can be judged in.
    await sql.query(`update crm.contacts set timezone = 'America/New_York' where id = $1`, [
      contactId,
    ]);
    const [secret] = await sql.query<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'mailbox.password', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
       returning id`,
      [tenant.agencyId, tenant.businessId],
    );
    const [account] = await sql.query<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name, status)
       values ($1, 'email', 'Front desk', 'active') returning id`,
      [tenant.businessId],
    );
    const address = `${randomUUID()}@example.test`;
    await sql.query(
      `insert into messaging.mailboxes (business_id, id, email_address, auth_method, smtp_host,
         smtp_port, smtp_security, smtp_username, imap_host, imap_port, imap_security,
         imap_username, secret_id, use_for_conversations)
       values ($1, $2, $3, 'password', 'mail.example.test', 587, 'starttls', $3,
         'mail.example.test', 993, 'tls', $3, $4, true)`,
      [tenant.businessId, account?.id, address, secret?.id],
    );
    if (options.consent !== false)
      await sql.query(
        `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind, recorded_by_id)
         values ($1, $2, 'email', 'transactional', 'granted', 'booking', 'contact', $2)`,
        [tenant.businessId, contactId],
      );
    if (options.phone === true)
      await sql.query(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, is_primary)
         values ($1, $2, 'phone', '+12125550123', '+12125550123', true)`,
        [tenant.businessId, contactId],
      );
  });
  const [calendar] = await superuser((sql) =>
    sql.query<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
       values ($1, 'Consultations', 'personal', 'America/New_York', $2) returning id`,
      [tenant.businessId, `c-${randomUUID().slice(0, 8)}`],
    ),
  );
  const calendarId = calendar?.id ?? '';
  await h.publish(tenant, stamped(appointmentRemindersRecipe({ text: options.text === true })));
  const tell = async (type: string, appointmentId: string, payload: Record<string, unknown>) => {
    const eventId = await runCommand(
      h.services,
      happen,
      { type, appointmentId, contactId, payload },
      all(tenant),
    );
    return h.match(tenant, eventId);
  };
  return {
    tenant,
    contactId,
    calendarId,
    async book(startsAt) {
      const [row] = await superuser((sql) =>
        sql.query<{ id: string }>(
          `insert into calendar.appointments
             (business_id, calendar_id, contact_id, title, starts_at, ends_at, source, location, booker_timezone)
           values ($1, $2, $3, 'Consultation', $4, $5, 'booking_page', '12 Main Street', 'America/Los_Angeles')
           returning id`,
          [tenant.businessId, calendarId, contactId, startsAt, new Date(startsAt.getTime() + HOUR)],
        ),
      );
      const appointmentId = row?.id ?? '';
      const matched = await tell('appointment.booked', appointmentId, { calendarId });
      expect(matched.enrolled).toBe(1);
      const [run] = await h.database.withTenant(tenant, (sql) =>
        sql.query<{ id: string }>(
          `select id from automation.enrolments where record_id = $1 order by id desc limit 1`,
          [contactId],
        ),
      );
      return { appointmentId, run: run?.id ?? '' };
    },
    async change(appointmentId, to) {
      if (typeof to === 'object') {
        await superuser((sql) =>
          sql.query(`update calendar.appointments set starts_at = $2, ends_at = $3 where id = $1`, [
            appointmentId,
            to.startsAt,
            new Date(to.startsAt.getTime() + HOUR),
          ]),
        );
        return tell('appointment.rescheduled', appointmentId, { calendarId });
      }
      await superuser((sql) =>
        sql.query(
          `update calendar.appointments set status = $2,
             cancelled_at = case when $2 = 'cancelled' then now() end where id = $1`,
          [appointmentId, to],
        ),
      );
      if (to === 'cancelled') {
        const cancelled = await tell('appointment.cancelled', appointmentId, { calendarId });
        const changed = await tell('appointment.status_changed', appointmentId, {
          calendarId,
          status: to,
          previousStatus: 'booked',
        });
        return { woken: cancelled.woken + changed.woken };
      }
      return tell('appointment.status_changed', appointmentId, {
        calendarId,
        status: to,
        previousStatus: 'booked',
      });
    },
    messages: () =>
      h.database.withTenant(tenant, (sql) =>
        sql.query(
          `select m.channel, m.status, m.error_code, m.subject, m.body_text, d.purpose, d.lane
           from messaging.messages m
           join messaging.outbound_dispatch d on d.business_id = m.business_id and d.id = m.id
           order by m.created_at, m.id`,
        ),
      ),
  };
}

const rows = (tenant: Tenant, run: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ step_key: string; status: string; branch: string | null; explanation: string }>(
      `select step_key, status, branch, explanation from automation.step_runs
       where enrolment_id = $1 order by started_at, id`,
      [run],
    ),
  );

/** Runs the run's steps at a moment until it waits, ends, or has nothing due then. */
async function settle(s: Scene, run: string, now: Date): Promise<void> {
  for (let guard = 0; guard < 10; guard++) {
    const before = await h.run(s.tenant, run);
    if (before.status !== 'running' && before.status !== 'waiting') return;
    if ((await h.step(s.tenant, run, now)) === 'skipped') return;
  }
}

it('emails a reminder 24 hours before and 1 hour before, in the zone the contact booked in', async () => {
  const s = await scene();
  const starts = fromNow(3 * 24 * HOUR);
  const { run } = await s.book(starts);
  await settle(s, run, new Date());
  const dayBefore = new Date(starts.getTime() - 24 * HOUR);
  expect(await h.run(s.tenant, run)).toMatchObject({
    status: 'waiting',
    current_step: 'wait_day_before',
    wake_at: dayBefore,
  });
  // Nothing is sent before its time.
  expect(await h.step(s.tenant, run, new Date(dayBefore.getTime() - 1000))).toBe('skipped');
  expect(await s.messages()).toEqual([]);

  await settle(s, run, dayBefore);
  const hourBefore = new Date(starts.getTime() - HOUR);
  expect(await h.run(s.tenant, run)).toMatchObject({
    status: 'waiting',
    current_step: 'wait_hour_before',
    wake_at: hourBefore,
  });
  const when = startTimeWords(starts, 'America/Los_Angeles');
  expect(when).toMatch(/Pacific (Standard|Daylight) Time$/);
  const [first] = await s.messages();
  expect(first).toMatchObject({
    channel: 'email',
    status: 'queued',
    error_code: null,
    subject: `Reminder: Consultation on ${when}`,
    // A reminder is about the appointment booked: not marketing, still a workflow's.
    purpose: 'transactional',
    lane: 'automation',
  });
  expect(first?.body_text).toContain(`When: ${when}`);
  expect(first?.body_text).toContain('Where: 12 Main Street');
  expect(first?.body_text).toContain('Hi Ada,');

  await settle(s, run, hourBefore);
  expect(await h.run(s.tenant, run)).toMatchObject({ status: 'completed' });
  const sent = await s.messages();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toMatchObject({
    status: 'queued',
    subject: 'Starting in 1 hour: Consultation',
    purpose: 'transactional',
  });
  expect((await rows(s.tenant, run)).map((row) => [row.step_key, row.status, row.branch])).toEqual([
    ['wait_day_before', 'succeeded', null],
    ['wait_day_before', 'succeeded', 'reached'],
    ['email_day_before', 'succeeded', null],
    ['wait_hour_before', 'succeeded', null],
    ['wait_hour_before', 'succeeded', 'reached'],
    ['email_hour_before', 'succeeded', null],
  ]);
});

it('moves both reminders with a reschedule, and names the new time', async () => {
  const s = await scene();
  const first = fromNow(3 * 24 * HOUR);
  const { appointmentId, run } = await s.book(first);
  await settle(s, run, new Date());
  const later = fromNow(6 * 24 * HOUR);
  expect((await s.change(appointmentId, { startsAt: later })).woken).toBe(1);
  await settle(s, run, new Date());
  expect(await h.run(s.tenant, run)).toMatchObject({
    status: 'waiting',
    current_step: 'wait_day_before',
    wake_at: new Date(later.getTime() - 24 * HOUR),
  });
  // At the old time nothing is sent.
  expect(await h.step(s.tenant, run, new Date(first.getTime() - 24 * HOUR))).toBe('skipped');
  expect(await s.messages()).toEqual([]);

  await settle(s, run, new Date(later.getTime() - 24 * HOUR));
  expect((await s.messages())[0]?.body_text).toContain(
    `When: ${startTimeWords(later, 'America/Los_Angeles')}`,
  );
  // Moved again while it waits for the hour before: that wait follows too.
  const again = fromNow(8 * 24 * HOUR);
  expect((await s.change(appointmentId, { startsAt: again })).woken).toBe(1);
  await settle(s, run, new Date(later.getTime() - 24 * HOUR));
  expect(await h.run(s.tenant, run)).toMatchObject({
    current_step: 'wait_hour_before',
    wake_at: new Date(again.getTime() - HOUR),
  });
  await settle(s, run, new Date(again.getTime() - HOUR));
  const sent = await s.messages();
  expect(sent).toHaveLength(2);
  expect(sent[1]?.body_text).toContain(`When: ${startTimeWords(again, 'America/Los_Angeles')}`);
});

it('stops on a cancellation: nothing more is sent', async () => {
  const s = await scene();
  const { appointmentId, run } = await s.book(fromNow(3 * 24 * HOUR));
  await settle(s, run, new Date());
  expect((await s.change(appointmentId, 'cancelled')).woken).toBe(1);
  await settle(s, run, new Date());
  expect(await h.run(s.tenant, run)).toMatchObject({ status: 'completed' });
  expect((await rows(s.tenant, run)).at(-1)).toMatchObject({
    step_key: 'wait_day_before',
    branch: 'no_appointment',
    explanation: 'The appointment is cancelled, so the no_appointment branch was taken.',
  });
  expect(await s.messages()).toEqual([]);
});

it('stops on a no-show after the first reminder: the hour-before one is not sent', async () => {
  const s = await scene();
  const starts = fromNow(3 * 24 * HOUR);
  const { appointmentId, run } = await s.book(starts);
  await settle(s, run, new Date());
  await settle(s, run, new Date(starts.getTime() - 24 * HOUR));
  expect(await h.run(s.tenant, run)).toMatchObject({ current_step: 'wait_hour_before' });
  expect((await s.change(appointmentId, 'no_show')).woken).toBe(1);
  await settle(s, run, new Date(starts.getTime() - 2 * HOUR));
  expect(await h.run(s.tenant, run)).toMatchObject({ status: 'completed' });
  expect((await rows(s.tenant, run)).at(-1)).toMatchObject({
    step_key: 'wait_hour_before',
    branch: 'no_appointment',
    explanation: 'The appointment is marked no-show, so the no_appointment branch was taken.',
  });
  expect(await s.messages()).toHaveLength(1);
});

it('skips the day-before reminder for a booking less than a day away, and sends the other', async () => {
  const s = await scene();
  const starts = fromNow(5 * HOUR);
  const { run } = await s.book(starts);
  await settle(s, run, new Date());
  expect(await h.run(s.tenant, run)).toMatchObject({
    status: 'waiting',
    current_step: 'wait_hour_before',
    wake_at: new Date(starts.getTime() - HOUR),
  });
  expect((await rows(s.tenant, run))[0]).toMatchObject({
    step_key: 'wait_day_before',
    branch: 'passed',
  });
  expect(await s.messages()).toEqual([]);
  await settle(s, run, new Date(starts.getTime() - HOUR));
  expect(await s.messages()).toMatchObject([{ subject: 'Starting in 1 hour: Consultation' }]);
});

it('sends nothing to a contact the booking recorded no consent for, and the run goes on', async () => {
  const s = await scene({ consent: false });
  // Marketing consent is not what a reminder needs.
  await superuser((sql) =>
    sql.query(
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'marketing', 'granted', 'user', 'user')`,
      [s.tenant.businessId, s.contactId],
    ),
  );
  const starts = fromNow(3 * 24 * HOUR);
  const { run } = await s.book(starts);
  await settle(s, run, new Date());
  await settle(s, run, new Date(starts.getTime() - 24 * HOUR));
  expect(await s.messages()).toMatchObject([
    { status: 'failed', error_code: 'consent_required', purpose: 'transactional' },
  ]);
  // The refusal is kept on the step, and the run waits for the hour before all the same.
  expect(await h.run(s.tenant, run)).toMatchObject({
    status: 'waiting',
    current_step: 'wait_hour_before',
  });
  expect(
    (await rows(s.tenant, run)).find((row) => row.step_key === 'email_day_before'),
  ).toMatchObject({ status: 'failed' });
});

it('still reminds a contact who unsubscribed from marketing, and stops for one who withdrew', async () => {
  const s = await scene();
  await superuser((sql) =>
    sql.query(
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'marketing', 'withdrawn', 'unsubscribe_link', 'contact')`,
      [s.tenant.businessId, s.contactId],
    ),
  );
  const starts = fromNow(3 * 24 * HOUR);
  const { run } = await s.book(starts);
  await settle(s, run, new Date());
  await settle(s, run, new Date(starts.getTime() - 24 * HOUR));
  expect(await s.messages()).toMatchObject([{ status: 'queued', purpose: 'transactional' }]);
  // Notifications about bookings withdrawn: the hour-before reminder is refused.
  await superuser((sql) =>
    sql.query(
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'transactional', 'withdrawn', 'user', 'user')`,
      [s.tenant.businessId, s.contactId],
    ),
  );
  await settle(s, run, new Date(starts.getTime() - HOUR));
  expect((await s.messages())[1]).toMatchObject({
    status: 'failed',
    error_code: 'consent_withdrawn',
  });
  expect(await h.run(s.tenant, run)).toMatchObject({ status: 'completed' });
});

it('with a text chosen, skips it for a contact without a phone, and notes a missing number', async () => {
  const noPhone = await scene({ text: true });
  const starts = fromNow(5 * HOUR);
  const first = await noPhone.book(starts);
  await settle(noPhone, first.run, new Date());
  await settle(noPhone, first.run, new Date(starts.getTime() - HOUR));
  expect(await h.run(noPhone.tenant, first.run)).toMatchObject({ status: 'completed' });
  expect((await rows(noPhone.tenant, first.run)).at(-1)).toMatchObject({
    step_key: 'has_phone',
    branch: 'no',
  });
  expect((await noPhone.messages()).map((message) => message.channel)).toEqual(['email']);

  // A phone, but no number left that can text: the step says so, and the run still ends well.
  const withPhone = await scene({ text: true, phone: true });
  const second = await withPhone.book(starts);
  await settle(withPhone, second.run, new Date());
  await settle(withPhone, second.run, new Date(starts.getTime() - HOUR));
  expect(await h.run(withPhone.tenant, second.run)).toMatchObject({ status: 'completed' });
  expect((await rows(withPhone.tenant, second.run)).at(-1)).toMatchObject({
    step_key: 'text_hour_before',
    status: 'failed',
  });
});

it('fills appointment fields only from the run’s own contact’s appointment', async () => {
  const s = await scene();
  const { appointmentId, run } = await s.book(fromNow(3 * 24 * HOUR));
  const own = await withTenant(h.db, s.tenant, (trx) => runValues(trx, s.contactId, run));
  expect(own).toMatchObject({
    'appointment.title': 'Consultation',
    'appointment.calendar': 'Consultations',
    'appointment.location': '12 Main Street',
    'appointment.status': 'booked',
  });
  // The appointment is moved to another contact: the run's messages no longer read it.
  const other = await h.contact(s.tenant, 'Grace');
  await superuser((sql) =>
    sql.query(`update calendar.appointments set contact_id = $2 where id = $1`, [
      appointmentId,
      other.contactId,
    ]),
  );
  const values = await withTenant(h.db, s.tenant, (trx) => runValues(trx, s.contactId, run));
  expect(values['appointment.title']).toBeNull();
  expect(values['appointment.startTime']).toBeNull();
});

it('fills appointment fields from the appointment a wait waited for, in a run nothing booked', async () => {
  const s = await scene();
  // Another workflow, started for every new contact: its wait finds the contact's next one.
  await h.publish(s.tenant, {
    name: 'Before the visit',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'hold',
    steps: {
      hold: { type: 'wait.appointment', config: { offset: 'PT2H' }, next: { reached: 'after' } },
      after: { type: 'wait', config: { duration: 'PT1H' } },
    },
  });
  const made = await h.enrol(s.tenant, 'Linus');
  const run = made.enrolments.at(-1) ?? '';
  const empty = await withTenant(h.db, s.tenant, (trx) => runValues(trx, made.contactId, run));
  expect(empty['appointment.title']).toBeNull();
  const starts = fromNow(2 * 24 * HOUR);
  await superuser((sql) =>
    sql.query(
      `insert into calendar.appointments
         (business_id, calendar_id, contact_id, title, starts_at, ends_at, source)
       values ($1, $2, $3, 'Fitting', $4, $5, 'user')`,
      [
        s.tenant.businessId,
        s.calendarId,
        made.contactId,
        starts,
        new Date(starts.getTime() + HOUR),
      ],
    ),
  );
  await settle(s, run, new Date());
  expect(await h.step(s.tenant, run, new Date(starts.getTime() - 2 * HOUR))).toBe('ran');
  expect(await h.run(s.tenant, run)).toMatchObject({ status: 'running', current_step: 'after' });
  const values = await withTenant(h.db, s.tenant, (trx) => runValues(trx, made.contactId, run));
  // No zone of the booker's or the contact's: the calendar's.
  expect(values).toMatchObject({
    'appointment.title': 'Fitting',
    'appointment.startTime': startTimeWords(starts, 'America/New_York'),
    'appointment.startsAt': starts.toISOString(),
    'appointment.location': null,
  });
});

// Messaging's own queueing, as any other sender would ask it, with the test's choices.
const queueAsked = defineCommand({
  name: 'test.queue_message',
  permission: 'conversations.manage',
  input: z.strictObject({
    contactId: z.uuid(),
    purpose: z.enum(['marketing', 'transactional']),
    appointmentId: z.uuid().optional(),
  }),
  async handle(trx, input, command) {
    const identity = await trx
      .selectFrom('crm.contact_identities')
      .select('id')
      .where('contact_id', '=', input.contactId)
      .where('kind', '=', 'email')
      .executeTakeFirstOrThrow();
    const account = await trx
      .selectFrom('messaging.channel_accounts')
      .select('id')
      .where('channel', '=', 'email')
      .executeTakeFirstOrThrow();
    return queueOutboundMessage(trx, command.context, {
      identityId: identity.id,
      accountId: account.id,
      channel: 'email',
      purpose: input.purpose,
      lane: 'automation',
      idempotencyKey: randomUUID(),
      subject: 'Asked',
      text: 'Asked',
      ...(input.appointmentId === undefined ? {} : { appointmentId: input.appointmentId }),
    });
  },
});
const held = (tenant: Tenant, id: string) =>
  h.database.withTenant(tenant, async (sql) => {
    const [row] = await sql.query<{ status: string; error_code: string | null }>(
      `select status, error_code from messaging.messages where id = $1`,
      [id],
    );
    return row;
  });

it('sends the hour-before reminder in quiet hours, and still holds a marketing message', async () => {
  const s = await scene({ quiet: true });
  const starts = fromNow(5 * HOUR);
  const { appointmentId, run } = await s.book(starts);
  await settle(s, run, new Date());
  await settle(s, run, new Date(starts.getTime() - HOUR));
  // Quiet all day long, and the reminder of the contact's own appointment is not held.
  const [reminder] = await s.messages();
  expect(reminder).toMatchObject({
    subject: 'Starting in 1 hour: Consultation',
    status: 'queued',
    error_code: null,
    purpose: 'transactional',
  });
  // It carries the appointment's own link to reschedule or cancel.
  expect(reminder?.body_text).toContain(
    `Reschedule or cancel: https://crm.example.test/appointments/manage/test-${appointmentId}`,
  );
  expect(
    await h.database.withTenant(s.tenant, (sql) =>
      sql.query('select appointment_id from messaging.outbound_dispatch'),
    ),
  ).toEqual([{ appointment_id: appointmentId }]);

  await superuser((sql) =>
    sql.query(
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, recorded_by_kind)
       values ($1, $2, 'email', 'marketing', 'granted', 'user', 'user')`,
      [s.tenant.businessId, s.contactId],
    ),
  );
  const ask = (input: { purpose: 'marketing' | 'transactional'; appointmentId?: string }) =>
    runCommand(h.services, queueAsked, { contactId: s.contactId, ...input }, all(s.tenant));
  // Marketing is held, and so is a transactional message about no appointment.
  for (const asked of [{ purpose: 'marketing' as const }, { purpose: 'transactional' as const }])
    expect(await held(s.tenant, await ask(asked))).toEqual({
      status: 'queued',
      error_code: 'quiet_hours',
    });
  // Only a transactional message may name an appointment.
  await expect(ask({ purpose: 'marketing', appointmentId })).rejects.toThrow();
  // Another contact's appointment, or this one once cancelled, does not lift quiet hours.
  const other = await h.contact(s.tenant, 'Grace');
  const [theirs] = await superuser((sql) =>
    sql.query<{ id: string }>(
      `insert into calendar.appointments (business_id, calendar_id, contact_id, title, starts_at, ends_at, source)
       values ($1, $2, $3, 'Theirs', $4, $5, 'user') returning id`,
      [
        s.tenant.businessId,
        s.calendarId,
        other.contactId,
        starts,
        new Date(starts.getTime() + HOUR),
      ],
    ),
  );
  expect(
    await held(s.tenant, await ask({ purpose: 'transactional', appointmentId: theirs?.id ?? '' })),
  ).toMatchObject({ error_code: 'quiet_hours' });
  await superuser((sql) =>
    sql.query(
      `update calendar.appointments set status = 'cancelled', cancelled_at = now() where id = $1`,
      [appointmentId],
    ),
  );
  expect(
    await held(s.tenant, await ask({ purpose: 'transactional', appointmentId })),
  ).toMatchObject({ error_code: 'quiet_hours' });
});

// What the booking page records when "Text me reminders" is ticked (messaging's own).
const tickTextBox = defineCommand({
  name: 'test.tick_text_box',
  permission: 'contacts.manage',
  input: z.strictObject({ contactId: z.uuid(), appointmentId: z.uuid() }),
  handle: (trx, input, command) =>
    recordBookingTextConsent(
      trx,
      {
        ...input,
        phone: '+1 212 555 0123',
        ipAddress: '203.0.113.10',
        wording: bookingTextWording('Bayside Events'),
      },
      command,
    ),
});

it('texts the reminder to a booker who ticked "Text me reminders", and not after STOP', async () => {
  const ticked = await scene({ text: true, phone: true });
  await superuser((sql) => addPhoneNumber(sql, ticked.tenant, 'Front desk'));
  const starts = fromNow(5 * HOUR);
  const booked = await ticked.book(starts);
  expect(
    await runCommand(
      h.services,
      tickTextBox,
      { contactId: ticked.contactId, appointmentId: booked.appointmentId },
      all(ticked.tenant),
    ),
  ).toBe('granted');
  await settle(ticked, booked.run, new Date());
  await settle(ticked, booked.run, new Date(starts.getTime() - HOUR));
  const text = (await ticked.messages()).find((message) => message.channel === 'sms');
  expect(text).toMatchObject({ status: 'queued', error_code: null, purpose: 'transactional' });
  expect(text?.body_text).toContain(
    `Reschedule or cancel: https://crm.example.test/appointments/manage/test-${booked.appointmentId}`,
  );

  // Not ticked: the booking's email consent is no consent to text.
  const unticked = await scene({ text: true, phone: true });
  await superuser((sql) => addPhoneNumber(sql, unticked.tenant, 'Front desk'));
  const second = await unticked.book(starts);
  await settle(unticked, second.run, new Date());
  await settle(unticked, second.run, new Date(starts.getTime() - HOUR));
  expect((await unticked.messages()).find((message) => message.channel === 'sms')).toMatchObject({
    status: 'failed',
    error_code: 'consent_required',
  });

  // Ticked, then STOP from the number: the next reminder's text is refused.
  const stopped = await scene({ text: true, phone: true });
  await superuser((sql) => addPhoneNumber(sql, stopped.tenant, 'Front desk'));
  const third = await stopped.book(starts);
  await runCommand(
    h.services,
    tickTextBox,
    { contactId: stopped.contactId, appointmentId: third.appointmentId },
    all(stopped.tenant),
  );
  await superuser((sql) =>
    sql.query(
      `insert into messaging.consents (business_id, contact_id, channel, purpose, status, source, address_normalized, proof, recorded_by_kind, recorded_by_id)
       values ($1, $2, 'sms', 'transactional', 'withdrawn', 'keyword', '+12125550123', '{"keyword": "STOP"}', 'contact', $2)`,
      [stopped.tenant.businessId, stopped.contactId],
    ),
  );
  await settle(stopped, third.run, new Date());
  await settle(stopped, third.run, new Date(starts.getTime() - HOUR));
  expect((await stopped.messages()).find((message) => message.channel === 'sms')).toMatchObject({
    status: 'failed',
    error_code: 'consent_withdrawn',
  });
});

it('leaves every counter equal to the rows it counts', async () => {
  expect(await h.differences()).toEqual([]);
});
