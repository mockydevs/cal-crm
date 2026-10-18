import { createHash } from 'node:crypto';
import { defineCommand, runCommand, type CommandContext, type Invocation } from '@repo/commands';
import { Temporal } from '@js-temporal/polyfill';
import {
  publicAppointmentPage,
  publicAppointmentReceipt,
  publicCancellationInput,
  publicRescheduleInput,
  type PublicAppointmentPage,
  type PublicAppointmentReceipt,
  type PublicCancellationInput,
  type PublicRescheduleInput,
  type PublicSlots,
} from '@repo/contracts';
import { withTenant, type DB, type DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, toPublicId, type TenantContext } from '@repo/kernel';
import { sql, type Selectable } from 'kysely';
import { heldBy } from './appointment-links.js';
import { policyRefusal } from './calendar-policy.js';
import { freshRangeAround } from './google/google-busy.js';
import { confirmationOf } from './confirmations.js';
import { isDoubleBooking } from './double-booking.js';
import type { PublicBookingOptions, PublicBookingRequestContext } from './public-routes.js';

interface ManagementScope {
  readonly agency_id: string;
  readonly business_id: string;
  readonly appointment_id: string;
}
type Appointment = Selectable<DB['calendar.appointments']>;
type ConfirmationStatus = 'queued' | 'refused' | 'unavailable';

export interface RescheduleSelection {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
}
export type SelectRescheduleSlot = (
  trx: DatabaseTransaction,
  command: CommandContext,
  appointment: Appointment,
  startsAt: string,
) => Promise<RescheduleSelection>;

export async function readManagedSlots(
  options: PublicBookingOptions,
  selectSlots: (
    trx: DatabaseTransaction,
    context: TenantContext,
    appointment: Appointment,
    date: string,
  ) => Promise<PublicSlots>,
  token: string,
  date: string,
  request: PublicBookingRequestContext,
): Promise<PublicSlots> {
  const digest = createHash('sha256').update(token).digest('hex');
  const { rows } =
    await sql<ManagementScope>`select * from private.appointment_scope(${digest})`.execute(
      options.db,
    );
  const scope = rows[0];
  if (scope === undefined) throw new NotFoundError('Appointment', 'unavailable');
  request.onBusiness?.(scope.business_id);
  const context: TenantContext = {
    agencyId: scope.agency_id,
    businessId: scope.business_id,
    actorKind: 'contact',
    correlationId: request.requestId,
  };
  return withTenant(options.db, context, async (trx) => {
    await options.calendars.business.lockActive(trx, context);
    const appointment = await trx
      .selectFrom('calendar.appointments')
      .selectAll()
      .where('business_id', '=', scope.business_id)
      .where('id', '=', scope.appointment_id)
      // The booking's own token, or a reminder's link (appointment-links.ts).
      .where(heldBy(digest))
      .where('status', 'in', ['booked', 'confirmed'])
      .executeTakeFirst();
    if (appointment === undefined) throw new NotFoundError('Appointment', 'unavailable');
    const calendar = await trx
      .selectFrom('calendar.calendars')
      .select('id')
      .where('business_id', '=', scope.business_id)
      .where('id', '=', appointment.calendar_id)
      .forShare()
      .executeTakeFirst();
    if (calendar === undefined) throw new NotFoundError('Appointment', 'unavailable');
    return selectSlots(trx, context, appointment, date);
  });
}

/** Retains the original host; the factory supplies the live calendar's slot selector. */
export async function rescheduleManagedAppointment(
  options: PublicBookingOptions,
  selectSlot: SelectRescheduleSlot,
  token: string,
  input: PublicRescheduleInput,
  request: PublicBookingRequestContext,
): Promise<PublicAppointmentReceipt> {
  const digest = createHash('sha256').update(token).digest('hex');
  const { rows } =
    await sql<ManagementScope>`select * from private.appointment_scope(${digest})`.execute(
      options.db,
    );
  const scope = rows[0];
  if (scope === undefined) throw new NotFoundError('Appointment', 'unavailable');
  request.onBusiness?.(scope.business_id);
  const invocation: Invocation = {
    context: {
      agencyId: scope.agency_id,
      businessId: scope.business_id,
      actorKind: 'contact',
      correlationId: request.requestId,
    },
    permissions: new Set(['calendars.manage']),
    ip: request.ipAddress,
  };
  // Google is read again for the host around the new time before the move takes its locks,
  // as for a booking; the move then decides from what is known.
  const asked = publicRescheduleInput.safeParse(input);
  if (options.google !== undefined && asked.success) {
    const held = await withTenant(options.db, invocation.context, (trx) =>
      trx
        .selectFrom('calendar.appointments')
        .select('calendar_id')
        .where('business_id', '=', scope.business_id)
        .where('id', '=', scope.appointment_id)
        .where(heldBy(digest))
        .executeTakeFirst(),
    );
    if (held !== undefined)
      await options.google.freshen(
        invocation.context,
        held.calendar_id,
        freshRangeAround(asked.data.startsAt),
      );
  }
  const command = defineCommand({
    name: 'calendar.public.reschedule',
    permission: 'calendars.manage',
    input: publicRescheduleInput,
    audit: () => ({
      appointmentId: toPublicId('appointment', scope.appointment_id),
      operation: 'reschedule',
    }),
    async handle(trx, parsed, command): Promise<PublicAppointmentReceipt> {
      const normalized = { ...parsed, startsAt: Temporal.Instant.from(parsed.startsAt).toString() };
      await options.calendars.business.lockActive(trx, command.context);
      const peek = await trx
        .selectFrom('calendar.appointments')
        .selectAll()
        .where('business_id', '=', scope.business_id)
        .where('id', '=', scope.appointment_id)
        // The booking's own token, or a reminder's link (appointment-links.ts).
        .where(heldBy(digest))
        .executeTakeFirst();
      if (peek === undefined) throw new NotFoundError('Appointment', 'unavailable');
      const calendar = await trx
        .selectFrom('calendar.calendars')
        .select('id')
        .where('business_id', '=', scope.business_id)
        .where('id', '=', peek.calendar_id)
        .forUpdate()
        .executeTakeFirst();
      if (calendar === undefined) throw new NotFoundError('Appointment', 'unavailable');
      const requestDigest = createHash('sha256')
        .update(JSON.stringify(['reschedule', normalized]))
        .digest('hex');
      const previous = await trx
        .selectFrom('calendar.appointment_operations')
        .select(['operation', 'request_digest', 'receipt'])
        .where('business_id', '=', scope.business_id)
        .where('appointment_id', '=', scope.appointment_id)
        .where('operation_request_id', '=', parsed.operationRequestId)
        .executeTakeFirst();
      if (previous !== undefined) {
        if (previous.operation !== 'reschedule' || previous.request_digest !== requestDigest)
          throw new ConflictError('This operation request already identifies different details.');
        return publicAppointmentReceipt.parse(previous.receipt);
      }
      const slot = await selectSlot(trx, command, peek, normalized.startsAt);
      const contactActive = await options.contacts.lock(trx, command.context, {
        contactId: peek.contact_id,
      });
      if (!contactActive)
        throw new ConflictError('This appointment cannot queue its confirmation.');
      const row = await trx
        .selectFrom('calendar.appointments')
        .selectAll()
        .where('business_id', '=', scope.business_id)
        .where('id', '=', scope.appointment_id)
        // The booking's own token, or a reminder's link (appointment-links.ts).
        .where(heldBy(digest))
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError('Appointment', 'unavailable');
      if (
        row.calendar_id !== peek.calendar_id ||
        row.contact_id !== peek.contact_id ||
        revisionOf(row) !== parsed.revision
      )
        throw new ConflictError('This appointment changed. Reload before continuing.');
      if (row.status !== 'booked' && row.status !== 'confirmed')
        throw new ConflictError('This appointment cannot be rescheduled.');
      // The booker is emailed where the booking was: a mailbox to send from that can still
      // send, and the address the booking's own confirmation went to. Without them the
      // appointment still moves, and the page shows the new time.
      const identityId =
        row.confirmation_account_id === null
          ? null
          : await options.notifications.recipient(trx, command.context, {
              appointmentId: row.id,
              contactId: row.contact_id,
            });
      const accountId =
        identityId === null || row.confirmation_account_id === null
          ? null
          : await options.calendars.senders
              .resolve(trx, command.context, toPublicId('mailbox', row.confirmation_account_id))
              .catch((error: unknown) => {
                if (error instanceof NotFoundError) return null;
                throw error;
              });
      const moved = await trx
        .updateTable('calendar.appointments')
        .set({
          starts_at: slot.startsAt,
          ends_at: slot.endsAt,
          buffer_before_minutes: slot.bufferBeforeMinutes,
          buffer_after_minutes: slot.bufferAfterMinutes,
          management_expires_at: Temporal.Instant.from(slot.endsAt).add({ hours: 720 }).toString(),
        })
        .where('business_id', '=', scope.business_id)
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow()
        .catch((error: unknown) => {
          if (isDoubleBooking(error))
            throw new ConflictError('This appointment time is unavailable.');
          throw error;
        });
      let confirmationStatus: ConfirmationStatus = 'unavailable';
      if (identityId !== null && accountId !== null) {
        const message = await confirmationOf(
          trx,
          options.publicOrigin,
          moved,
          'rescheduled',
          new URL(`/appointments/manage/${token}`, options.publicOrigin).href,
        );
        const confirmation = await options.notifications.queue(trx, command.context, {
          identityId,
          accountId,
          idempotencyKey: `calendar:reschedule:${row.id}:${parsed.operationRequestId}`,
          ...message,
        });
        if (confirmation.outcome !== 'queued')
          throw new ConflictError('This appointment cannot queue its confirmation.');
        confirmationStatus = 'queued';
      }
      const receipt = publicAppointmentReceipt.parse({
        status: moved.status,
        startsAt: moved.starts_at.toISOString(),
        endsAt: moved.ends_at.toISOString(),
      });
      await trx
        .insertInto('calendar.appointment_operations')
        .values({
          business_id: scope.business_id,
          appointment_id: row.id,
          operation_request_id: parsed.operationRequestId,
          operation: 'reschedule',
          request_digest: requestDigest,
          receipt,
          confirmation_status: confirmationStatus,
        })
        .execute();
      await command.emit({
        type: 'appointment.rescheduled',
        subject: { kind: 'appointment', id: row.id },
        records: [row.contact_id],
        payload: {
          calendarId: row.calendar_id,
          contactId: row.contact_id,
          startsAt: receipt.startsAt,
          endsAt: receipt.endsAt,
        },
      });
      return receipt;
    },
  });
  return runCommand(
    {
      db: options.db,
      authorize: (candidate, name) =>
        name === 'calendar.public.reschedule' &&
        candidate.context.actorKind === 'contact' &&
        candidate.context.agencyId === scope.agency_id &&
        candidate.context.businessId === scope.business_id,
    },
    command,
    input,
    invocation,
  );
}

/**
 * What the booker's change must name to be made: any change since to what their page shows
 * or what their change depends on gives another. The team's own notes are not part of it:
 * the booker never sees them, so a note written meanwhile does not make them reload.
 */
export function revisionOf(row: Appointment): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.id,
        row.calendar_id,
        row.contact_id,
        row.status,
        row.starts_at.toISOString(),
        row.ends_at.toISOString(),
        row.assigned_user_id,
        row.buffer_before_minutes,
        row.buffer_after_minutes,
        row.confirmation_account_id,
      ]),
    )
    .digest('hex');
}

/**
 * What the team's change must name (appointment-staff.ts): the booker's revision and the
 * notes. A note saved over one someone else wrote meanwhile is refused like any other
 * stale change, and so is a move made on an appointment whose notes the mover hasn't read.
 */
export function teamRevisionOf(row: Appointment): string {
  return createHash('sha256')
    .update(JSON.stringify([revisionOf(row), row.notes]))
    .digest('hex');
}

/** Called by the factory only after capability and trusted request-context validation. */
export async function readManagedAppointment(
  options: PublicBookingOptions,
  token: string,
  request: PublicBookingRequestContext,
): Promise<PublicAppointmentPage> {
  const digest = createHash('sha256').update(token).digest('hex');
  const { rows } =
    await sql<ManagementScope>`select * from private.appointment_scope(${digest})`.execute(
      options.db,
    );
  const scope = rows[0];
  if (scope === undefined) throw new NotFoundError('Appointment', 'unavailable');
  request.onBusiness?.(scope.business_id);
  const context: TenantContext = {
    agencyId: scope.agency_id,
    businessId: scope.business_id,
    actorKind: 'contact',
    correlationId: request.requestId,
  };
  return withTenant(options.db, context, async (trx) => {
    await options.calendars.business.lockActive(trx, context);
    const row = await trx
      .selectFrom('calendar.appointments as a')
      .innerJoin('calendar.calendars as c', (join) =>
        join.onRef('c.business_id', '=', 'a.business_id').onRef('c.id', '=', 'a.calendar_id'),
      )
      .selectAll('a')
      .select(['c.name as calendar_name', 'c.timezone as calendar_timezone'])
      .where('a.business_id', '=', scope.business_id)
      .where('a.id', '=', scope.appointment_id)
      // The booking's own token, or a reminder's link (appointment-links.ts).
      .where(heldBy(digest, 'a'))
      .forShare('a')
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Appointment', 'unavailable');
    return publicAppointmentPage.parse({
      status: row.status,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      calendarName: row.calendar_name,
      timezone: row.calendar_timezone,
      revision: revisionOf(row),
    });
  });
}

/** The factory validates the capability; this private command rechecks its live scope. */
export async function cancelManagedAppointment(
  options: PublicBookingOptions,
  token: string,
  input: PublicCancellationInput,
  request: PublicBookingRequestContext,
): Promise<PublicAppointmentReceipt> {
  const digest = createHash('sha256').update(token).digest('hex');
  const { rows } =
    await sql<ManagementScope>`select * from private.appointment_scope(${digest})`.execute(
      options.db,
    );
  const scope = rows[0];
  if (scope === undefined) throw new NotFoundError('Appointment', 'unavailable');
  request.onBusiness?.(scope.business_id);
  const invocation: Invocation = {
    context: {
      agencyId: scope.agency_id,
      businessId: scope.business_id,
      actorKind: 'contact',
      correlationId: request.requestId,
    },
    permissions: new Set(['calendars.manage']),
    ip: request.ipAddress,
  };
  const command = defineCommand({
    name: 'calendar.public.cancel',
    permission: 'calendars.manage',
    input: publicCancellationInput,
    audit: () => ({
      appointmentId: toPublicId('appointment', scope.appointment_id),
      operation: 'cancel',
    }),
    async handle(trx, parsed, context): Promise<PublicAppointmentReceipt> {
      await options.calendars.business.lockActive(trx, context.context);
      const peek = await trx
        .selectFrom('calendar.appointments')
        .select(['calendar_id', 'contact_id'])
        .where('business_id', '=', scope.business_id)
        .where('id', '=', scope.appointment_id)
        // The booking's own token, or a reminder's link (appointment-links.ts).
        .where(heldBy(digest))
        .executeTakeFirst();
      if (peek === undefined) throw new NotFoundError('Appointment', 'unavailable');
      const calendar = await trx
        .selectFrom('calendar.calendars')
        .select(['id', 'allow_cancel', 'cancel_cutoff_minutes'])
        .where('business_id', '=', scope.business_id)
        .where('id', '=', peek.calendar_id)
        .forUpdate()
        .executeTakeFirst();
      if (calendar === undefined) throw new NotFoundError('Appointment', 'unavailable');
      const requestDigest = createHash('sha256')
        .update(JSON.stringify(['cancel', parsed]))
        .digest('hex');
      const previous = await trx
        .selectFrom('calendar.appointment_operations')
        .select(['operation', 'request_digest', 'receipt'])
        .where('business_id', '=', scope.business_id)
        .where('appointment_id', '=', scope.appointment_id)
        .where('operation_request_id', '=', parsed.operationRequestId)
        .executeTakeFirst();
      if (previous !== undefined) {
        if (previous.operation !== 'cancel' || previous.request_digest !== requestDigest)
          throw new ConflictError('This operation request already identifies different details.');
        return publicAppointmentReceipt.parse(previous.receipt);
      }
      const contactActive = await options.contacts.lock(trx, context.context, {
        contactId: peek.contact_id,
      });
      const row = await trx
        .selectFrom('calendar.appointments')
        .selectAll()
        .where('business_id', '=', scope.business_id)
        .where('id', '=', scope.appointment_id)
        // The booking's own token, or a reminder's link (appointment-links.ts).
        .where(heldBy(digest))
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError('Appointment', 'unavailable');
      if (
        row.calendar_id !== peek.calendar_id ||
        row.contact_id !== peek.contact_id ||
        revisionOf(row) !== parsed.revision
      )
        throw new ConflictError('This appointment changed. Reload before continuing.');
      if (row.status !== 'booked' && row.status !== 'confirmed')
        throw new ConflictError('This appointment cannot be cancelled.');
      // The calendar's own word on whether the person who booked may still cancel.
      const refused = policyRefusal(
        { allowed: calendar.allow_cancel, cutoffMinutes: calendar.cancel_cutoff_minutes },
        'cancel',
        row.starts_at,
        new Date(),
      );
      if (refused !== undefined) throw new ConflictError(refused);
      const cancelled = await trx
        .updateTable('calendar.appointments')
        .set({ status: 'cancelled', cancelled_at: sql<Date>`statement_timestamp()` })
        .where('business_id', '=', scope.business_id)
        .where('id', '=', scope.appointment_id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const receipt = publicAppointmentReceipt.parse({
        status: cancelled.status,
        startsAt: cancelled.starts_at.toISOString(),
        endsAt: cancelled.ends_at.toISOString(),
      });
      const confirmationStatus = await cancellationConfirmation(
        trx,
        context.context,
        options,
        cancelled,
        token,
        parsed.operationRequestId,
        contactActive,
      );
      await trx
        .insertInto('calendar.appointment_operations')
        .values({
          business_id: scope.business_id,
          appointment_id: scope.appointment_id,
          operation_request_id: parsed.operationRequestId,
          operation: 'cancel',
          request_digest: requestDigest,
          receipt,
          confirmation_status: confirmationStatus,
        })
        .execute();
      await context.emit({
        type: 'appointment.cancelled',
        subject: { kind: 'appointment', id: row.id },
        records: [row.contact_id],
        payload: {
          calendarId: row.calendar_id,
          contactId: row.contact_id,
          startsAt: receipt.startsAt,
          endsAt: receipt.endsAt,
        },
      });
      return receipt;
    },
  });
  return runCommand(
    {
      db: options.db,
      authorize: (candidate, name) =>
        name === 'calendar.public.cancel' &&
        candidate.context.actorKind === 'contact' &&
        candidate.context.agencyId === scope.agency_id &&
        candidate.context.businessId === scope.business_id,
    },
    command,
    input,
    invocation,
  );
}

async function cancellationConfirmation(
  trx: DatabaseTransaction,
  context: TenantContext,
  options: PublicBookingOptions,
  appointment: Appointment,
  token: string,
  operationRequestId: string,
  contactActive: boolean,
): Promise<ConfirmationStatus> {
  if (!contactActive || appointment.confirmation_account_id === null) return 'unavailable';
  await sql`savepoint calendar_cancellation_confirmation`.execute(trx);
  try {
    const identityId = await options.notifications.recipient(trx, context, {
      appointmentId: appointment.id,
      contactId: appointment.contact_id,
    });
    if (identityId === null) return 'unavailable';
    const accountId = await options.calendars.senders.resolve(
      trx,
      context,
      toPublicId('mailbox', appointment.confirmation_account_id),
    );
    const message = await confirmationOf(
      trx,
      options.publicOrigin,
      appointment,
      'cancelled',
      new URL(`/appointments/manage/${token}`, options.publicOrigin).href,
    );
    const confirmation = await options.notifications.queue(trx, context, {
      identityId,
      accountId,
      idempotencyKey: `calendar:cancel:${appointment.id}:${operationRequestId}`,
      ...message,
    });
    if (confirmation.outcome === 'refused') {
      await sql`rollback to savepoint calendar_cancellation_confirmation`.execute(trx);
      return 'refused';
    }
    return 'queued';
  } catch (error) {
    await sql`rollback to savepoint calendar_cancellation_confirmation`.execute(trx);
    if (error instanceof NotFoundError) return 'unavailable';
    if (error instanceof ConflictError) return 'refused';
    throw error;
  } finally {
    await sql`release savepoint calendar_cancellation_confirmation`.execute(trx);
  }
}
