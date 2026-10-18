// Wait modes through real runs: a wait for a reply on one channel, for a trigger link, for
// a condition on the record and for an appointment, and the resume window. Real Postgres,
// the CRM's own commands for what changes a contact, and the engine's own match and step
// commands.
import { randomUUID } from 'node:crypto';

import { defineCommand, runCommand } from '@repo/commands';
import type { AutomationDocumentInput } from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import { assignRecordTagCommand, createTagCommand, updateContactCommand } from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { startHarness, type Enrolled, type Harness, type Tenant } from '../test/workflows.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const all = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});
const created = { id: 'created', type: 'contact.created', config: {} } as const;
const pause = { type: 'wait', config: { duration: 'PT1M' } } as const;
const HOUR = 3_600_000;

// Something happening to a contact, as the module that owns it emits it.
const happen = defineCommand({
  name: 'test.happened',
  permission: 'contacts.manage',
  input: z.strictObject({
    type: z.string(),
    recordId: z.uuid(),
    subject: z.strictObject({ kind: z.string(), id: z.uuid() }).optional(),
    payload: z.record(z.string(), z.unknown()),
  }),
  async handle(_trx, input, command) {
    return command.emit({
      type: input.type,
      subject: input.subject ?? { kind: 'test', id: randomUUID() },
      records: [input.recordId],
      payload: input.payload,
    });
  },
});

/** The event happens for the contact; it is matched, as the worker matches it, unless held back. */
async function event(
  tenant: Tenant,
  type: string,
  recordId: string,
  payload: Record<string, unknown> = {},
  subject?: { kind: string; id: string },
) {
  const eventId = await runCommand(
    h.services,
    happen,
    { type, recordId, payload, ...(subject === undefined ? {} : { subject }) },
    all(tenant),
  );
  return { eventId, matched: await h.match(tenant, eventId) };
}

const rows = (tenant: Tenant, enrolmentId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{
      step_key: string;
      status: string;
      resumes: boolean;
      branch: string | null;
      output: Record<string, unknown>;
      explanation: string;
    }>(
      `select step_key, status, resumes, branch, output, explanation from automation.step_runs
       where enrolment_id = $1 order by started_at, id`,
      [enrolmentId],
    ),
  );

const listening = (tenant: Tenant, enrolmentId: string) =>
  h.database.withTenant(tenant, (sql) =>
    sql.query<{ kind: string; event_type: string; conditions: unknown }>(
      `select kind, event_type, conditions from automation.event_waits
       where enrolment_id = $1 order by kind, event_type`,
      [enrolmentId],
    ),
  );

/** The newest event of a type the business recorded: what a CRM command just emitted. */
async function latest(tenant: Tenant, type: string): Promise<string> {
  const [row] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>(
      `select id from events.events where type = $1 order by recorded_at desc, id desc limit 1`,
      [type],
    ),
  );
  return row?.id ?? '';
}

async function started(
  tenant: Tenant,
  document: AutomationDocumentInput,
): Promise<Enrolled & { run: string }> {
  await h.publish(tenant, document);
  const made = await h.enrol(tenant);
  return { ...made, run: made.enrolments[0] ?? '' };
}

/** An id as the database makes them. */
async function newId(): Promise<string> {
  const [row] = await h.database.as('postgres', (sql) =>
    sql.query<{ id: string }>('select uuidv7() as id'),
  );
  return row?.id ?? '';
}

const waitingFor = (
  config: Record<string, unknown>,
  stopWhen: AutomationDocumentInput['stopWhen'] = [],
): AutomationDocumentInput => ({
  name: 'Wait for it',
  triggers: [created],
  stopWhen,
  start: 'hold',
  steps: {
    hold: {
      type: 'wait.event',
      config: { timeout: 'P3D', ...config } as never,
      next: { received: 'got_it', timed_out: 'gave_up' },
    },
    got_it: pause,
    gave_up: pause,
  },
});

it('wakes a wait for a reply only on the channel it names', async () => {
  const tenant = await h.business();
  const { run, contactId } = await started(
    tenant,
    waitingFor({ event: 'message.received', channel: 'sms' }),
  );
  await h.step(tenant, run);
  expect(await listening(tenant, run)).toEqual([
    {
      kind: 'event',
      event_type: 'message.received',
      conditions: { filter: { type: 'message.received', config: { channel: 'sms' } } },
    },
  ]);
  const email = await event(tenant, 'message.received', contactId, { channel: 'email' });
  expect(email.matched.woken).toBe(0);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'waiting', current_step: 'hold' });
  const text = await event(tenant, 'message.received', contactId, { channel: 'sms' });
  expect(text.matched.woken).toBe(1);
  expect(await h.step(tenant, run)).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'got_it' });
  expect((await rows(tenant, run)).at(-1)).toMatchObject({
    branch: 'received',
    output: { eventId: text.eventId },
  });
});

it('wakes a wait for a trigger link on the link it names, and on any link when it names none', async () => {
  const tenant = await h.business();
  const brochure = await newId();
  const { run, contactId } = await started(
    tenant,
    waitingFor({ event: 'trigger_link.clicked', link: toPublicId('trigger_link', brochure) }),
  );
  await h.step(tenant, run);
  const other = await event(tenant, 'trigger_link.clicked', contactId, { linkId: await newId() });
  expect(other.matched.woken).toBe(0);
  const clicked = await event(tenant, 'trigger_link.clicked', contactId, { linkId: brochure });
  expect(clicked.matched.woken).toBe(1);
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ current_step: 'got_it' });

  const second = await h.business();
  const any = await started(second, waitingFor({ event: 'trigger_link.clicked' }));
  await h.step(second, any.run);
  expect(await listening(second, any.run)).toEqual([
    { kind: 'event', event_type: 'trigger_link.clicked', conditions: {} },
  ]);
  const click = await event(second, 'trigger_link.clicked', any.contactId, {
    linkId: randomUUID(),
  });
  expect(click.matched.woken).toBe(1);
});

const untilVip = (stopWhen: AutomationDocumentInput['stopWhen'] = []): AutomationDocumentInput => ({
  name: 'Until VIP',
  triggers: [created],
  stopWhen,
  start: 'hold',
  steps: {
    hold: {
      type: 'wait.condition',
      config: {
        if: { field: 'contact.tags', operator: 'includes', value: 'VIP' },
        timeout: 'P2D',
      },
      next: { met: 'welcome', timed_out: 'nudge' },
    },
    welcome: pause,
    nudge: pause,
  },
});

/** Makes a tag and gives it to the contact through the CRM, and matches the event it emits. */
async function tag(tenant: Tenant, contact: string, name: string, match = true) {
  const made = await runCommand(h.services, createTagCommand, { name }, all(tenant));
  await runCommand(
    h.services,
    assignRecordTagCommand,
    { id: contact, tagId: made.id },
    all(tenant),
  );
  const eventId = await latest(tenant, 'tag.assigned');
  return { eventId, matched: match ? await h.match(tenant, eventId) : undefined };
}

it('waits for a condition and takes met when a tag makes it hold', async () => {
  const tenant = await h.business();
  const { run, contact } = await started(tenant, untilVip());
  const began = Date.now();
  await h.step(tenant, run);
  const waiting = await h.run(tenant, run);
  expect(waiting).toMatchObject({ status: 'waiting', current_step: 'hold' });
  // Two days from when the step ran.
  expect((waiting.wake_at?.getTime() ?? 0) - began).toBeGreaterThanOrEqual(48 * HOUR - 1000);
  expect((waiting.wake_at?.getTime() ?? 0) - began).toBeLessThan(48 * HOUR + 60_000);
  expect(await listening(tenant, run)).toEqual(
    [
      'contact.updated',
      'field.value_cleared',
      'field.value_set',
      'tag.assigned',
      'tag.removed',
    ].map((event_type) => ({ kind: 'event', event_type, conditions: { recheck: true } })),
  );
  const tagged = await tag(tenant, contact, 'VIP');
  expect(tagged.matched?.woken).toBe(1);
  expect(await h.step(tenant, run)).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'welcome' });
  expect(await listening(tenant, run)).toEqual([]);
  expect(await rows(tenant, run)).toEqual([
    {
      step_key: 'hold',
      status: 'succeeded',
      resumes: false,
      branch: null,
      output: { wakeAt: waiting.wake_at?.toISOString() },
      explanation: `Waiting until the condition holds, or until ${waiting.wake_at?.toISOString() ?? ''}.`,
    },
    {
      step_key: 'hold',
      status: 'succeeded',
      resumes: true,
      branch: 'met',
      output: {},
      explanation: 'The condition held when the record changed, so the met branch was taken.',
    },
  ]);
});

it('takes met at once when the condition already holds', async () => {
  const tenant = await h.business();
  await h.publish(tenant, untilVip());
  const made = await h.contact(tenant);
  await tag(tenant, made.contact, 'VIP', false);
  await h.match(tenant, made.eventId);
  const [run] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where record_id = $1', [
      made.contactId,
    ]),
  );
  await h.step(tenant, run?.id ?? '');
  expect(await h.run(tenant, run?.id ?? '')).toMatchObject({ current_step: 'welcome' });
  expect(await rows(tenant, run?.id ?? '')).toMatchObject([
    { branch: 'met', explanation: 'The condition already held, so the met branch was taken.' },
  ]);
});

it('goes on waiting to the same deadline when a change does not make it hold, in one row', async () => {
  const tenant = await h.business();
  const { run, contact, contactId } = await started(tenant, untilVip());
  await h.step(tenant, run);
  const { wake_at: deadline } = await h.run(tenant, run);
  // The contact is renamed, and given another tag: the record changed, VIP it is not.
  await runCommand(
    h.services,
    updateContactCommand,
    { id: contact, firstName: 'Grace' },
    all(tenant),
  );
  const renamed = await h.match(tenant, await latest(tenant, 'contact.updated'));
  expect(renamed.woken).toBe(1);
  expect(await h.step(tenant, run)).toBe('ran');
  const still = await h.run(tenant, run);
  expect(still).toMatchObject({ status: 'waiting', current_step: 'hold', wake_at: deadline });
  expect(await listening(tenant, run)).toHaveLength(5);
  const until = deadline?.toISOString() ?? '';
  expect(await rows(tenant, run)).toEqual([
    {
      step_key: 'hold',
      status: 'waiting',
      resumes: false,
      branch: null,
      output: { wakeAt: until },
      explanation: `The record changed, but the condition does not hold yet; still waiting until ${until}.`,
    },
  ]);
  // A job that wakes before the deadline with nothing changed does nothing.
  expect(await h.step(tenant, run)).toBe('skipped');
  // Another contact's change is not this run's.
  const other = await h.contact(tenant, 'Linus');
  const elsewhere = await tag(tenant, other.contact, 'VIP');
  expect(elsewhere.matched?.woken).toBe(0);
  // At the deadline it is judged once more, and times out.
  expect(await h.step(tenant, run, deadline ?? undefined)).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'nudge' });
  expect((await rows(tenant, run)).at(-1)).toMatchObject({
    branch: 'timed_out',
    resumes: true,
    explanation: 'The condition did not hold before the timeout.',
  });
  expect(await listening(tenant, run)).toEqual([]);
  expect(contactId).not.toBe(other.contactId);
});

it('is woken by a change recorded before the wait began but matched after it', async () => {
  const tenant = await h.business();
  const { run, contact } = await started(tenant, untilVip());
  // The change is committed, and its match job has not run, when the step begins to wait.
  const early = await tag(tenant, contact, 'Lead', false);
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'waiting' });
  const matched = await h.match(tenant, early.eventId);
  expect(matched.woken).toBe(1);
  // Judged again, it still does not hold, and goes on waiting.
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'waiting', current_step: 'hold' });
});

it('lets a stop condition take a run out of a wait for a condition', async () => {
  const tenant = await h.business();
  const { run, contactId } = await started(tenant, untilVip([{ event: 'form.submitted' }]));
  await h.step(tenant, run);
  const submitted = await event(tenant, 'form.submitted', contactId, { formId: randomUUID() });
  expect(submitted.matched).toMatchObject({ exited: 1, woken: 0 });
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'exited',
    exit_reason: 'stop:form.submitted',
  });
  expect(await listening(tenant, run)).toEqual([]);
  expect(await rows(tenant, run)).toMatchObject([{ step_key: 'hold', status: 'skipped' }]);
});

/** A calendar of the business, and appointments of a contact on it, as the calendar keeps them. */
async function calendarOf(tenant: Tenant): Promise<string> {
  const [row] = await h.database.as('postgres', (sql) =>
    sql.query<{ id: string }>(
      `insert into calendar.calendars (business_id, name, kind, timezone, booking_slug)
       values ($1, 'Consultations', 'personal', 'Africa/Nairobi', $2) returning id`,
      [tenant.businessId, `c-${randomUUID().slice(0, 8)}`],
    ),
  );
  return row?.id ?? '';
}

async function appointment(
  tenant: Tenant,
  calendarId: string,
  contactId: string,
  startsAt: Date,
): Promise<string> {
  const [row] = await h.database.as('postgres', (sql) =>
    sql.query<{ id: string }>(
      `insert into calendar.appointments
         (business_id, calendar_id, contact_id, title, starts_at, ends_at, source)
       values ($1, $2, $3, 'Consultation', $4, $5, 'user') returning id`,
      [tenant.businessId, calendarId, contactId, startsAt, new Date(startsAt.getTime() + HOUR)],
    ),
  );
  return row?.id ?? '';
}

/** The calendar moves or cancels an appointment and says so, as its commands do. */
async function change(
  tenant: Tenant,
  appointmentId: string,
  contactId: string,
  to: { startsAt: Date } | 'cancelled',
) {
  await h.database.as('postgres', (sql) =>
    to === 'cancelled'
      ? sql.query(
          `update calendar.appointments set status = 'cancelled', cancelled_at = now() where id = $1`,
          [appointmentId],
        )
      : sql.query(`update calendar.appointments set starts_at = $2, ends_at = $3 where id = $1`, [
          appointmentId,
          to.startsAt,
          new Date(to.startsAt.getTime() + HOUR),
        ]),
  );
  return event(
    tenant,
    to === 'cancelled' ? 'appointment.cancelled' : 'appointment.rescheduled',
    contactId,
    {},
    { kind: 'appointment', id: appointmentId },
  );
}

const beforeAppointment = (
  triggers: AutomationDocumentInput['triggers'] = [created],
): AutomationDocumentInput => ({
  name: 'Reminder',
  triggers,
  start: 'hold',
  steps: {
    hold: {
      type: 'wait.appointment',
      config: { offset: 'PT2H' },
      next: { reached: 'remind', passed: 'late', no_appointment: 'none' },
    },
    remind: {
      type: 'condition',
      config: { if: { field: 'steps.hold.appointmentId', operator: 'is_set' } },
      next: { yes: 'done', no: 'none' },
    },
    done: pause,
    late: pause,
    none: pause,
  },
});

// Whole seconds, well ahead, so a stored instant reads back as it was written.
const inDays = (days: number) => new Date(Math.floor(Date.now() / 1000) * 1000 + days * 24 * HOUR);

it('waits until two hours before the contact’s next appointment, then takes reached', async () => {
  const tenant = await h.business();
  const calendarId = await calendarOf(tenant);
  await h.publish(tenant, beforeAppointment());
  const made = await h.contact(tenant);
  const starts = inDays(3);
  // A later one, and a cancelled earlier one, are not the next.
  await appointment(tenant, calendarId, made.contactId, inDays(9));
  const cancelled = await appointment(tenant, calendarId, made.contactId, inDays(1));
  await h.database.as('postgres', (sql) =>
    sql.query(
      `update calendar.appointments set status = 'cancelled', cancelled_at = now() where id = $1`,
      [cancelled],
    ),
  );
  const id = await appointment(tenant, calendarId, made.contactId, starts);
  await h.match(tenant, made.eventId);
  const [{ id: run } = { id: '' }] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where record_id = $1', [
      made.contactId,
    ]),
  );
  await h.step(tenant, run);
  const target = new Date(starts.getTime() - 2 * HOUR);
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'waiting',
    current_step: 'hold',
    wake_at: target,
  });
  expect(await listening(tenant, run)).toEqual(
    ['appointment.cancelled', 'appointment.rescheduled', 'appointment.status_changed'].map(
      (event_type) => ({ kind: 'event', event_type, conditions: { recheck: true } }),
    ),
  );
  expect(await h.step(tenant, run, new Date(target.getTime() - 1000))).toBe('skipped');
  expect(await h.step(tenant, run, target)).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'remind' });
  const publicId = toPublicId('appointment', id);
  expect(await rows(tenant, run)).toEqual([
    {
      step_key: 'hold',
      status: 'succeeded',
      resumes: false,
      branch: null,
      output: { wakeAt: target.toISOString() },
      explanation: `Waiting until 2 hours before the appointment starts (${starts.toISOString()}), at ${target.toISOString()}.`,
    },
    {
      step_key: 'hold',
      status: 'succeeded',
      resumes: true,
      branch: 'reached',
      output: { appointmentId: publicId, startsAt: starts.toISOString() },
      explanation: 'The time came, so the reached branch was taken.',
    },
  ]);
  // What the wait gives is there for the steps after it.
  await h.step(tenant, run, target);
  expect(await h.run(tenant, run)).toMatchObject({ current_step: 'done' });
});

it('takes passed when the time has gone by, and no_appointment when the contact has none', async () => {
  const tenant = await h.business();
  const calendarId = await calendarOf(tenant);
  await h.publish(tenant, beforeAppointment());
  const soon = await h.contact(tenant);
  // In an hour: two hours before it has passed.
  await appointment(tenant, calendarId, soon.contactId, new Date(Date.now() + HOUR));
  await h.match(tenant, soon.eventId);
  const none = await h.enrol(tenant, 'Grace');
  const runs = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string; record_id: string }>('select id, record_id from automation.enrolments'),
  );
  const late = runs.find((row) => row.record_id === soon.contactId)?.id ?? '';
  await h.step(tenant, late);
  expect(await h.run(tenant, late)).toMatchObject({ status: 'running', current_step: 'late' });
  expect(await rows(tenant, late)).toMatchObject([{ branch: 'passed', status: 'succeeded' }]);
  const without = none.enrolments[0] ?? '';
  await h.step(tenant, without);
  expect(await h.run(tenant, without)).toMatchObject({ current_step: 'none' });
  expect(await rows(tenant, without)).toMatchObject([
    {
      branch: 'no_appointment',
      output: {},
      explanation:
        'The contact has no upcoming appointment, so the no_appointment branch was taken.',
    },
  ]);
  expect(await listening(tenant, without)).toEqual([]);
});

it('follows an appointment that is moved, later and then earlier, in one waiting row', async () => {
  const tenant = await h.business();
  const calendarId = await calendarOf(tenant);
  await h.publish(tenant, beforeAppointment());
  const made = await h.contact(tenant);
  const id = await appointment(tenant, calendarId, made.contactId, inDays(3));
  await h.match(tenant, made.eventId);
  const [{ id: run } = { id: '' }] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where record_id = $1', [
      made.contactId,
    ]),
  );
  await h.step(tenant, run);

  const later = inDays(6);
  const moved = await change(tenant, id, made.contactId, { startsAt: later });
  expect(moved.matched.woken).toBe(1);
  expect(await h.step(tenant, run)).toBe('ran');
  const target = new Date(later.getTime() - 2 * HOUR);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'waiting', wake_at: target });
  expect(await listening(tenant, run)).toHaveLength(3);
  expect(await rows(tenant, run)).toEqual([
    {
      step_key: 'hold',
      status: 'waiting',
      resumes: false,
      branch: null,
      output: { wakeAt: target.toISOString() },
      explanation: `The appointment was moved to ${later.toISOString()}, so the wait now ends at ${target.toISOString()}.`,
    },
  ]);

  // Moved to an hour from now: its two hours before have passed, so the run goes on at once.
  const sooner = new Date(Math.floor(Date.now() / 1000) * 1000 + HOUR);
  const again = await change(tenant, id, made.contactId, { startsAt: sooner });
  expect(again.matched.woken).toBe(1);
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'remind' });
  expect((await rows(tenant, run)).at(-1)).toMatchObject({
    branch: 'reached',
    output: { startsAt: sooner.toISOString() },
  });
});

it('honours a move whose event never came: the start is read again at the old time', async () => {
  const tenant = await h.business();
  const calendarId = await calendarOf(tenant);
  const { run, contactId } = await started(tenant, beforeAppointment());
  // Booked after the run began, but before it reached the step.
  const first = inDays(3);
  const id = await appointment(tenant, calendarId, contactId, first);
  await h.step(tenant, run);
  const later = inDays(5);
  await h.database.as('postgres', (sql) =>
    sql.query(`update calendar.appointments set starts_at = $2, ends_at = $3 where id = $1`, [
      id,
      later,
      new Date(later.getTime() + HOUR),
    ]),
  );
  expect(await h.step(tenant, run, new Date(first.getTime() - 2 * HOUR))).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'waiting',
    wake_at: new Date(later.getTime() - 2 * HOUR),
  });
});

it('takes no_appointment when the appointment is cancelled, or deleted, during the wait', async () => {
  const tenant = await h.business();
  const calendarId = await calendarOf(tenant);
  await h.publish(tenant, beforeAppointment());
  const first = await h.contact(tenant);
  const second = await h.contact(tenant, 'Grace');
  const kept = await appointment(tenant, calendarId, first.contactId, inDays(3));
  const gone = await appointment(tenant, calendarId, second.contactId, inDays(3));
  await h.match(tenant, first.eventId);
  await h.match(tenant, second.eventId);
  const runs = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string; record_id: string }>('select id, record_id from automation.enrolments'),
  );
  const cancelled = runs.find((row) => row.record_id === first.contactId)?.id ?? '';
  const deleted = runs.find((row) => row.record_id === second.contactId)?.id ?? '';
  await h.step(tenant, cancelled);
  await h.step(tenant, deleted);

  const told = await change(tenant, kept, first.contactId, 'cancelled');
  expect(told.matched.woken).toBe(1);
  await h.step(tenant, cancelled);
  expect(await h.run(tenant, cancelled)).toMatchObject({ current_step: 'none' });
  expect((await rows(tenant, cancelled)).at(-1)).toMatchObject({
    branch: 'no_appointment',
    output: { appointmentId: toPublicId('appointment', kept) },
    explanation: 'The appointment is cancelled, so the no_appointment branch was taken.',
  });

  await h.database.as('postgres', (sql) =>
    sql.query('delete from calendar.appointments where id = $1', [gone]),
  );
  await h.step(tenant, deleted, inDays(4));
  expect((await rows(tenant, deleted)).at(-1)).toMatchObject({
    branch: 'no_appointment',
    explanation: 'The appointment no longer exists, so the no_appointment branch was taken.',
  });
});

it('waits for the appointment that started the run, not the contact’s next one', async () => {
  const tenant = await h.business();
  const calendarId = await calendarOf(tenant);
  await h.publish(
    tenant,
    beforeAppointment([{ id: 'booked', type: 'appointment.booked', config: {} }]),
  );
  const made = await h.contact(tenant);
  await appointment(tenant, calendarId, made.contactId, inDays(2));
  const booked = inDays(7);
  const id = await appointment(tenant, calendarId, made.contactId, booked);
  const told = await event(
    tenant,
    'appointment.booked',
    made.contactId,
    { calendarId },
    { kind: 'appointment', id },
  );
  expect(told.matched.enrolled).toBe(1);
  const [{ id: run } = { id: '' }] = await h.database.withTenant(tenant, (sql) =>
    sql.query<{ id: string }>('select id from automation.enrolments where record_id = $1', [
      made.contactId,
    ]),
  );
  await h.step(tenant, run);
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'waiting',
    wake_at: new Date(booked.getTime() - 2 * HOUR),
  });
  // Another contact's appointment event wakes nobody here.
  const other = await h.contact(tenant, 'Linus');
  const elsewhere = await event(tenant, 'appointment.rescheduled', other.contactId, {});
  expect(elsewhere.matched.woken).toBe(0);
});

it('holds a reply that comes outside the resume window until the window opens', async () => {
  const tenant = await h.business();
  await h.database.as('postgres', (sql) =>
    sql.query(`update tenancy.businesses set timezone = 'Africa/Nairobi' where id = $1`, [
      tenant.businessId,
    ]),
  );
  const office = {
    days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    start: '09:00',
    end: '17:00',
  };
  const { run, contactId } = await started(
    tenant,
    waitingFor({ event: 'message.received', resumeWindow: office, timeout: 'P300D' }),
  );
  await h.step(tenant, run);
  const reply = await event(tenant, 'message.received', contactId, { channel: 'email' });
  expect(reply.matched.woken).toBe(1);
  // The step's job runs on a Saturday: 2027-01-02, 13:00 in Nairobi.
  const saturday = new Date('2027-01-02T10:00:00Z');
  const monday = new Date('2027-01-04T06:00:00Z');
  expect(await h.step(tenant, run, saturday)).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({
    status: 'waiting',
    current_step: 'hold',
    wake_at: monday,
  });
  // Nothing is listened for while the decision is held, and an early job does nothing.
  expect(await listening(tenant, run)).toEqual([]);
  expect(await h.step(tenant, run, new Date('2027-01-03T10:00:00Z'))).toBe('skipped');
  expect(await rows(tenant, run)).toMatchObject([
    {
      step_key: 'hold',
      status: 'waiting',
      explanation:
        'It would go on now (received), but the resume window (monday, tuesday, wednesday, thursday, friday, 09:00 to 17:00, Africa/Nairobi) is closed, so it goes on at 2027-01-04T06:00:00.000Z.',
    },
  ]);
  expect(await h.step(tenant, run, monday)).toBe('ran');
  expect(await h.run(tenant, run)).toMatchObject({ status: 'running', current_step: 'got_it' });
  expect((await rows(tenant, run)).at(-1)).toMatchObject({
    branch: 'received',
    resumes: true,
    output: { eventId: reply.eventId },
    explanation: 'message.received arrived, so the received branch was taken.',
  });
});

it('leaves every counter equal to the rows it counts', async () => {
  expect(await h.differences()).toEqual([]);
});
