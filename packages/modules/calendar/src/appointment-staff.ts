// What a signed-in person does to an appointment: book one for a contact, move it, cancel
// it, mark what became of it, and write its notes.
//
// A time is checked by the rules the booking page keeps (booking.ts): the calendar's hours
// and date overrides, its notice and range, each person's own hours and absences, and
// everybody's other appointments with their buffers. Someone at the desk may set those
// aside (`ignoreAvailability`), because they know what the calendar does not. What nobody
// sets aside is that a person is never booked twice at the same time: the table keeps that
// itself (appointments_no_double_booking), whoever writes.
//
// Each command locks the business, then the calendar, then the appointment, in that order,
// as the booking page's commands do, so the two never wait on each other crosswise.
import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import {
  defineCommand,
  requireBusiness,
  type Command,
  type CommandContext,
  type Invocation,
} from '@repo/commands';
import {
  cancelAppointment,
  cancelAppointmentInput,
  createAppointmentInput,
  rescheduleAppointment,
  rescheduleAppointmentInput,
  setAppointmentNotes,
  setAppointmentNotesInput,
  setAppointmentStatus,
  setAppointmentStatusInput,
  type AppointmentDetail,
  type CalendarConfiguration,
} from '@repo/contracts';
import { withTenant, type Database, type DatabaseTransaction, type DB } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { sql, type Selectable } from 'kysely';

import { revisionOf, teamRevisionOf } from './appointment-management.js';
import { confirmationOf } from './confirmations.js';
import { isDoubleBooking } from './double-booking.js';
import { readAppointment, storedId, type AppointmentReadOptions } from './appointments.js';
import { availableSlots, chooseHost, holdMembers } from './booking.js';
import { readCalendar, type CalendarOptions } from './calendars.js';
import { freshRangeAround } from './google/google-busy.js';
import type { PublicBookingOptions } from './public-routes.js';

/** What changing appointments needs, beside what reading them does. */
export interface AppointmentOptions extends AppointmentReadOptions {
  readonly calendars: CalendarOptions;
  readonly contacts: AppointmentReadOptions['contacts'] & {
    /** Holds the contact; false when the business has none such, or it is in the trash. */
    readonly lock: PublicBookingOptions['contacts']['lock'];
  };
  /** The booker's own confirmations, where the booker agreed to them (booking.ts). */
  readonly notifications: Pick<PublicBookingOptions['notifications'], 'recipient' | 'queue'>;
  /**
   * The CRM's own address: the host of an invite's UID (confirmations.ts). Left out, the
   * booker's email carries no invite.
   */
  readonly publicOrigin?: string | undefined;
  /**
   * A fresh look at the hosts' Google Calendars before the team books or moves by the
   * calendar's slots, as the booking page has. Left out, the team's bookings decide from
   * the busy store alone.
   */
  readonly google?: PublicBookingOptions['google'];
}

/**
 * Asks for the fresh look before the command, outside its transaction: the worker must be
 * free to answer while the request waits. A time the team sets exactly (availability set
 * aside) sets Google aside too, so it waits for nothing. Nor does a caller the command will
 * refuse: only someone who may book makes the worker ask Google.
 */
export async function freshenBeforeTeamBooking(
  options: AppointmentOptions,
  db: Database,
  invocation: Invocation,
  asked: {
    readonly calendarId?: string | undefined;
    readonly appointmentId?: string | undefined;
    readonly startsAt: string;
    readonly ignoreAvailability: boolean;
  },
): Promise<void> {
  const { google } = options;
  const { context, permissions } = invocation;
  const businessId = context.businessId;
  const mayBook = permissions === 'all' || permissions.has('appointments.manage');
  if (google === undefined || businessId === undefined || !mayBook || asked.ignoreAvailability)
    return;
  let calendarId =
    asked.calendarId === undefined ? undefined : parsePublicId('calendar', asked.calendarId);
  if (asked.appointmentId !== undefined) {
    const appointmentId = parsePublicId('appointment', asked.appointmentId);
    if (appointmentId === undefined) return;
    const row = await withTenant(db, context, (trx) =>
      trx
        .selectFrom('calendar.appointments')
        .select('calendar_id')
        .where('business_id', '=', businessId)
        .where('id', '=', appointmentId)
        .executeTakeFirst(),
    );
    calendarId = row?.calendar_id;
  }
  if (calendarId === undefined) return;
  await google.freshen(context, calendarId, freshRangeAround(asked.startsAt));
}

type Stored = Selectable<DB['calendar.appointments']>;

/** The longest an appointment can be, as appointments_duration_bounded keeps it. */
const LONGEST_MS = 31 * 86_400_000;

const refused = (path: string, code: string, message: string) =>
  new ValidationError([{ path, code, message }]);
const taken = () => new ConflictError('This appointment time is unavailable.');
const stale = () => new ConflictError('This appointment changed. Reload before continuing.');

/** The exclusion remains the last word against any other writer; anything else is passed on. */
export const explainDoubleBooking = (error: unknown): never => {
  if (isDoubleBooking(error)) throw taken();
  throw error;
};

async function lockCalendar(
  trx: DatabaseTransaction,
  businessId: string,
  calendarId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom('calendar.calendars')
    .select('id')
    .where('business_id', '=', businessId)
    .where('id', '=', calendarId)
    .forUpdate()
    .executeTakeFirst();
  return row !== undefined;
}

/** The calendar's members who are on the team now, each held until the command ends. */
async function hostsOf(
  options: AppointmentOptions,
  trx: DatabaseTransaction,
  context: TenantContext,
  config: CalendarConfiguration,
): Promise<ReadonlySet<string>> {
  try {
    return await holdMembers(options, trx, context, config);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    return new Set();
  }
}

async function assigneeOf(
  options: AppointmentOptions,
  trx: DatabaseTransaction,
  context: TenantContext,
  membershipId: string,
  hosts: ReadonlySet<string>,
): Promise<string> {
  let userId: string;
  try {
    userId = await options.calendars.members.resolve(trx, context, membershipId);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    throw refused('/assignee', 'unavailable_member', 'Choose someone on this business team.');
  }
  if (!hosts.has(userId))
    throw refused(
      '/assignee',
      'not_calendar_member',
      'Choose someone who takes bookings on this calendar.',
    );
  return userId;
}

interface Placement {
  readonly userId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
}

/**
 * Where an appointment goes: with whom, from when to when, and the buffers it carries. By
 * the calendar's own slots unless availability is set aside; then the times are the
 * caller's, with no buffers, since the time was chosen exactly.
 */
async function place(
  options: AppointmentOptions,
  trx: DatabaseTransaction,
  command: CommandContext,
  scope: { readonly agency_id: string; readonly business_id: string; readonly calendar_id: string },
  config: CalendarConfiguration,
  input: {
    readonly startsAt: string;
    readonly endsAt?: string | undefined;
    readonly assignee?: string | undefined;
  },
  current?: Stored,
): Promise<Placement> {
  const hosts = await hostsOf(options, trx, command.context, config);
  const named =
    input.assignee === undefined
      ? undefined
      : await assigneeOf(options, trx, command.context, input.assignee, hosts);
  // Whoever it is with stays, while they still take bookings on the calendar.
  const kept =
    current?.assigned_user_id !== null &&
    current?.assigned_user_id !== undefined &&
    hosts.has(current.assigned_user_id)
      ? current.assigned_user_id
      : undefined;
  const wanted = named ?? kept;
  const startsAt = Temporal.Instant.from(input.startsAt).toString();

  // The contract takes an end exactly when availability is set aside.
  if (input.endsAt !== undefined) {
    const endsAt = Temporal.Instant.from(input.endsAt).toString();
    if (Date.parse(endsAt) - Date.parse(startsAt) > LONGEST_MS)
      throw refused('/endsAt', 'too_long', 'An appointment is at most 31 days long.');
    const userId = wanted ?? (hosts.size === 1 ? [...hosts][0] : undefined);
    if (userId === undefined)
      throw refused('/assignee', 'assignee_required', 'Choose who the appointment is with.');
    return { userId, startsAt, endsAt, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
  }

  if (current !== undefined && wanted === undefined)
    throw refused('/assignee', 'assignee_required', 'Choose who the appointment is with.');
  const localDate = Temporal.Instant.from(startsAt)
    .toZonedDateTimeISO(config.calendar.timezone)
    .toPlainDate()
    .toString();
  const slots = await availableSlots(trx, scope, config, localDate, hosts, current?.id, 'team');
  const slot = slots.find(
    (candidate) =>
      candidate.startsAt === startsAt &&
      (wanted === undefined || candidate.availableMemberIds.includes(wanted)),
  );
  if (slot === undefined) throw taken();
  const userId = wanted ?? (await chooseHost(trx, scope, slot.availableMemberIds));
  if (userId === undefined) throw taken();
  return {
    userId,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    bufferBeforeMinutes: config.calendar.bufferBeforeMinutes,
    bufferAfterMinutes: config.calendar.bufferAfterMinutes,
  };
}

/**
 * Tells the booker, where they agreed to be told and the appointment has a mailbox to
 * write from. It never stops the change: an appointment the team moved is moved whether or
 * not the message can be queued.
 */
async function tellBooker(
  options: AppointmentOptions,
  trx: DatabaseTransaction,
  context: TenantContext,
  appointment: Stored,
  contactActive: boolean,
  kind: 'rescheduled' | 'cancelled',
  idempotencyKey: string,
): Promise<void> {
  if (!contactActive || appointment.confirmation_account_id === null) return;
  await sql`savepoint calendar_staff_confirmation`.execute(trx);
  try {
    const identityId = await options.notifications.recipient(trx, context, {
      appointmentId: appointment.id,
      contactId: appointment.contact_id,
    });
    if (identityId === null) return;
    const accountId = await options.calendars.senders.resolve(
      trx,
      context,
      toPublicId('mailbox', appointment.confirmation_account_id),
    );
    // The booker's own link is not known to the team, so the message carries none.
    const { invite, ...message } = await confirmationOf(
      trx,
      options.publicOrigin ?? 'https://localhost',
      appointment,
      kind,
      undefined,
    );
    const confirmation = await options.notifications.queue(trx, context, {
      identityId,
      accountId,
      idempotencyKey,
      ...message,
      ...(options.publicOrigin === undefined ? {} : { invite }),
    });
    if (confirmation.outcome === 'refused')
      await sql`rollback to savepoint calendar_staff_confirmation`.execute(trx);
  } catch (error) {
    await sql`rollback to savepoint calendar_staff_confirmation`.execute(trx);
    if (!(error instanceof NotFoundError) && !(error instanceof ConflictError)) throw error;
  } finally {
    await sql`release savepoint calendar_staff_confirmation`.execute(trx);
  }
}

const eventPayload = (row: Stored) => ({
  calendarId: row.calendar_id,
  contactId: row.contact_id,
  startsAt: row.starts_at.toISOString(),
  endsAt: row.ends_at.toISOString(),
});

/** The appointment and its calendar, both held, with the caller's revision checked. */
async function hold(
  options: AppointmentOptions,
  trx: DatabaseTransaction,
  command: CommandContext,
  id: string,
  revision: string,
): Promise<{ readonly businessId: string; readonly row: Stored }> {
  const businessId = requireBusiness(command.context);
  await options.calendars.business.lockActive(trx, command.context);
  const appointmentId = storedId('appointment', id);
  // The calendar first, then the appointment: the order the booking page's commands keep.
  await trx
    .selectFrom('calendar.calendars as c')
    .select('c.id')
    .where('c.business_id', '=', businessId)
    .where('c.id', '=', (eb) =>
      eb
        .selectFrom('calendar.appointments as a')
        .select('a.calendar_id')
        .where('a.business_id', '=', businessId)
        .where('a.id', '=', appointmentId),
    )
    .forUpdate()
    .execute();
  const row = await trx
    .selectFrom('calendar.appointments')
    .selectAll()
    .where('business_id', '=', businessId)
    .where('id', '=', appointmentId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Appointment', id);
  if (teamRevisionOf(row) !== revision) throw stale();
  return { businessId, row };
}

const createInput = createAppointmentInput;

export function createAppointmentCommand(
  options: AppointmentOptions,
): Command<typeof createInput, AppointmentDetail> {
  return defineCommand({
    name: 'calendar.appointment.book',
    permission: 'appointments.manage',
    input: createInput,
    audit: ({ notes: _notes, location: _location, title: _title, ...kept }) => kept,
    async handle(trx, input, command): Promise<AppointmentDetail> {
      const businessId = requireBusiness(command.context);
      await options.calendars.business.lockActive(trx, command.context);
      const calendarId = storedId('calendar', input.calendarId);
      if (!(await lockCalendar(trx, businessId, calendarId)))
        throw new NotFoundError('Calendar', input.calendarId);
      const normalized = {
        ...input,
        startsAt: Temporal.Instant.from(input.startsAt).toString(),
        ...(input.endsAt === undefined
          ? {}
          : { endsAt: Temporal.Instant.from(input.endsAt).toString() }),
      };
      const digest = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
      const previous = await trx
        .selectFrom('calendar.appointments')
        .select(['id', 'booking_request_digest'])
        .where('business_id', '=', businessId)
        .where('calendar_id', '=', calendarId)
        .where('booking_request_id', '=', input.requestId)
        .executeTakeFirst();
      if (previous !== undefined) {
        if (previous.booking_request_digest !== digest)
          throw new ConflictError('This booking request already identifies different details.');
        return readAppointment(trx, command, toPublicId('appointment', previous.id), options);
      }
      const config = await readCalendar(trx, command, input.calendarId, options.calendars);
      if (!config.calendar.supported || !config.calendar.isActive)
        throw refused(
          '/calendarId',
          'calendar_unavailable',
          'Choose an active calendar that takes bookings.',
        );
      const contactId = storedId('contact', input.contactId);
      // A person of the team books in their own name; a key or an assistant has none here.
      const bookedBy = command.context.actorKind === 'user' ? command.context.userId : undefined;
      if (!(await options.contacts.lock(trx, command.context, { contactId })))
        throw refused('/contactId', 'unknown_contact', 'Choose a contact of this business.');
      const placed = await place(
        options,
        trx,
        command,
        {
          agency_id: command.context.agencyId,
          business_id: businessId,
          calendar_id: calendarId,
        },
        config,
        normalized,
      );
      const created = await trx
        .insertInto('calendar.appointments')
        .values({
          business_id: businessId,
          calendar_id: calendarId,
          contact_id: contactId,
          assigned_user_id: placed.userId,
          title: input.title ?? config.calendar.name,
          starts_at: placed.startsAt,
          ends_at: placed.endsAt,
          status: input.status,
          location: input.location ?? null,
          notes: input.notes,
          source: bookedBy === undefined ? 'api' : 'user',
          created_by_user_id: bookedBy ?? null,
          buffer_before_minutes: placed.bufferBeforeMinutes,
          buffer_after_minutes: placed.bufferAfterMinutes,
          booking_request_id: input.requestId,
          booking_request_digest: digest,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch(explainDoubleBooking);
      await command.emit({
        type: 'appointment.booked',
        subject: { kind: 'appointment', id: created.id },
        records: [created.contact_id],
        payload: { ...eventPayload(created), source: created.source },
      });
      return readAppointment(trx, command, toPublicId('appointment', created.id), options);
    },
  });
}

const rescheduleInput = rescheduleAppointmentInput.safeExtend(rescheduleAppointment.params.shape);

export function rescheduleAppointmentCommand(
  options: AppointmentOptions,
): Command<typeof rescheduleInput, AppointmentDetail> {
  return defineCommand({
    name: 'calendar.appointment.reschedule',
    permission: 'appointments.manage',
    input: rescheduleInput,
    async handle(trx, input, command): Promise<AppointmentDetail> {
      const { businessId, row } = await hold(options, trx, command, input.id, input.revision);
      if (row.status !== 'booked' && row.status !== 'confirmed')
        throw new ConflictError('This appointment cannot be rescheduled.');
      const config = await readCalendar(
        trx,
        command,
        toPublicId('calendar', row.calendar_id),
        options.calendars,
      );
      if (!config.calendar.supported)
        throw new ConflictError('This appointment cannot be rescheduled.');
      const contactActive = await options.contacts.lock(trx, command.context, {
        contactId: row.contact_id,
      });
      const placed = await place(
        options,
        trx,
        command,
        {
          agency_id: command.context.agencyId,
          business_id: businessId,
          calendar_id: row.calendar_id,
        },
        config,
        input,
        row,
      );
      const moved = await trx
        .updateTable('calendar.appointments')
        .set({
          starts_at: placed.startsAt,
          ends_at: placed.endsAt,
          assigned_user_id: placed.userId,
          buffer_before_minutes: placed.bufferBeforeMinutes,
          buffer_after_minutes: placed.bufferAfterMinutes,
          // A booker's link lasts thirty days past the appointment, wherever it moves.
          ...(row.management_digest === null
            ? {}
            : {
                management_expires_at: Temporal.Instant.from(placed.endsAt)
                  .add({ hours: 720 })
                  .toString(),
              }),
        })
        .where('business_id', '=', businessId)
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch(explainDoubleBooking);
      await tellBooker(
        options,
        trx,
        command.context,
        moved,
        contactActive,
        'rescheduled',
        `calendar:staff-reschedule:${moved.id}:${revisionOf(moved)}`,
      );
      await command.emit({
        type: 'appointment.rescheduled',
        subject: { kind: 'appointment', id: moved.id },
        records: [moved.contact_id],
        payload: eventPayload(moved),
      });
      // GoHighLevel treats a moved appointment as a new one for its status trigger.
      await command.emit({
        type: 'appointment.status_changed',
        subject: { kind: 'appointment', id: moved.id },
        records: [moved.contact_id],
        payload: {
          ...eventPayload(moved),
          status: moved.status,
          previousStatus: moved.status,
          rescheduled: true,
        },
      });
      return readAppointment(trx, command, input.id, options);
    },
  });
}

/** Sets a status, with what follows from it; the same status changes and reports nothing. */
async function mark(
  options: AppointmentOptions,
  trx: DatabaseTransaction,
  command: CommandContext,
  input: {
    readonly id: string;
    readonly revision: string;
    readonly status: Stored['status'];
    readonly reason?: string | undefined;
  },
): Promise<AppointmentDetail> {
  const { businessId, row } = await hold(options, trx, command, input.id, input.revision);
  if (row.status === input.status) return readAppointment(trx, command, input.id, options);
  const cancelled = input.status === 'cancelled';
  const contactActive = cancelled
    ? await options.contacts.lock(trx, command.context, { contactId: row.contact_id })
    : false;
  const marked = await trx
    .updateTable('calendar.appointments')
    .set({
      status: input.status,
      cancelled_at: cancelled ? sql<Date>`statement_timestamp()` : null,
      cancel_reason: cancelled ? (input.reason ?? null) : null,
    })
    .where('business_id', '=', businessId)
    .where('id', '=', row.id)
    .returningAll()
    .executeTakeFirstOrThrow()
    // Back to booked or confirmed, the time must still be the person's to give.
    .catch(explainDoubleBooking);
  if (cancelled) {
    await tellBooker(
      options,
      trx,
      command.context,
      marked,
      contactActive,
      'cancelled',
      `calendar:staff-cancel:${marked.id}:${revisionOf(marked)}`,
    );
    await command.emit({
      type: 'appointment.cancelled',
      subject: { kind: 'appointment', id: marked.id },
      records: [marked.contact_id],
      payload: eventPayload(marked),
    });
  }
  await command.emit({
    type: 'appointment.status_changed',
    subject: { kind: 'appointment', id: marked.id },
    records: [marked.contact_id],
    payload: { ...eventPayload(marked), status: marked.status, previousStatus: row.status },
  });
  return readAppointment(trx, command, input.id, options);
}

const cancelInput = cancelAppointmentInput.extend(cancelAppointment.params.shape);

export function cancelAppointmentCommand(
  options: AppointmentOptions,
): Command<typeof cancelInput, AppointmentDetail> {
  return defineCommand({
    name: 'calendar.appointment.cancel',
    permission: 'appointments.manage',
    input: cancelInput,
    audit: ({ reason: _reason, ...kept }) => kept,
    handle: (trx, input, command) => mark(options, trx, command, { ...input, status: 'cancelled' }),
  });
}

const statusInput = setAppointmentStatusInput.extend(setAppointmentStatus.params.shape);

export function setAppointmentStatusCommand(
  options: AppointmentOptions,
): Command<typeof statusInput, AppointmentDetail> {
  return defineCommand({
    name: 'calendar.appointment.set_status',
    permission: 'appointments.manage',
    input: statusInput,
    handle: (trx, input, command) => mark(options, trx, command, input),
  });
}

const notesInput = setAppointmentNotesInput.extend(setAppointmentNotes.params.shape);

/**
 * Replaces an appointment's notes, whatever its status: the team's own words about it,
 * which the booker never sees. The team's revision covers the notes (teamRevisionOf), so a
 * note written over one someone else saved first is refused; the booker's revision does
 * not, so their open page stays good. Nothing is emitted: no trigger reads the notes, and
 * the audit log keeps the change without the words.
 */
export function setAppointmentNotesCommand(
  options: AppointmentOptions,
): Command<typeof notesInput, AppointmentDetail> {
  return defineCommand({
    name: 'calendar.appointment.set_notes',
    permission: 'appointments.manage',
    input: notesInput,
    audit: ({ notes: _notes, ...kept }) => kept,
    async handle(trx, input, command): Promise<AppointmentDetail> {
      const { businessId, row } = await hold(options, trx, command, input.id, input.revision);
      if (row.notes !== input.notes)
        await trx
          .updateTable('calendar.appointments')
          .set({ notes: input.notes })
          .where('business_id', '=', businessId)
          .where('id', '=', row.id)
          .execute();
      return readAppointment(trx, command, input.id, options);
    },
  });
}
