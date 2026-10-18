import { isIP } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { defineCommand, runCommand, type Invocation } from '@repo/commands';
import {
  BOOKING_NOTIFICATION_WORDING,
  bookingTextWording,
  botChallengeRequest,
  parseInput,
  publicBookingReceipt,
  publicCalendarParams,
  publicSlotQuery,
  publicBookingInput,
  publicAppointmentReceipt,
  appointmentCapability,
  type CalendarConfiguration,
  type PublicCalendarAppearance,
  type PublicCalendarParams,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';
import { bookerValues, inviteTitleOf, meetingPlaceOf, policyRefusal } from './calendar-policy.js';
import { readCalendar, type CalendarOptions } from './calendars.js';
import { readUserAvailabilityProfiles } from './user-availability-management.js';
import { readBlockedTime } from './blocked-slots.js';
import { freshRangeAround, readGoogleBusy } from './google/google-busy.js';
import { confirmationOf } from './confirmations.js';
import { isDoubleBooking } from './double-booking.js';
import { chooseWeightedMember, generateCalendarSlots, type CalendarSlot } from './slots.js';
import {
  readManagedAppointment,
  cancelManagedAppointment,
  rescheduleManagedAppointment,
  readManagedSlots,
} from './appointment-management.js';
import type {
  PublicBookingHandlers,
  PublicBookingOptions,
  PublicBookingRequestContext,
} from './public-routes.js';

const requestContext = z.strictObject({
  requestId: z.uuid(),
  ipAddress: z
    .string()
    .max(45)
    .refine((value) => isIP(value) !== 0),
});
/**
 * What the transport says of a request, checked, and whom to tell which business it turned
 * out to be for (the transport's own function, passed through as it is).
 */
function contextOf(raw: PublicBookingRequestContext): PublicBookingRequestContext {
  const { onBusiness, ...said } = raw;
  const checked = parseInput(requestContext, said);
  return onBusiness === undefined ? checked : { ...checked, onBusiness };
}
export interface CalendarScope {
  readonly agency_id: string;
  readonly business_id: string;
  readonly calendar_id: string;
}
const unavailable = () => new NotFoundError('Booking calendar', 'unavailable');

/**
 * Sent sooner after the booking page was shown than a person books (the page's render
 * token, as a form's). The transport answers 429 with this wait, and the page sends again.
 */
export class BookingTooSoonError extends Error {
  readonly statusCode = 429;
  constructor(readonly retryAfterSeconds: number) {
    super('Wait before sending the booking.');
    this.name = 'BookingTooSoonError';
  }
}

/** The page was shown too long ago, to someone else, or its token was spent: show it again. */
const pageStale = () =>
  new ConflictError('The booking page changed. Load it again and book again.');

/** The wording of the box a visitor ticks to be emailed, or null when the calendar asks none. */
export function notificationWordingOf(config: CalendarConfiguration): string | null {
  if (!config.calendar.consentEnabled) return null;
  const own = config.calendar.consentText.trim();
  return own === '' ? BOOKING_NOTIFICATION_WORDING : own;
}

/** The lengths a visitor may choose: the calendar's own first, then its extra ones. */
export function durationsOf(config: CalendarConfiguration): number[] {
  return [
    config.calendar.slotMinutes,
    ...config.calendar.extraDurationMinutes.filter(
      (minutes) => minutes !== config.calendar.slotMinutes,
    ),
  ];
}

/**
 * The page's look (Widget appearance): the style, colours and button words as saved, and
 * each picture by its public address only, so a private file is never shown or named.
 */
async function appearanceOf(
  trx: DatabaseTransaction,
  config: CalendarConfiguration,
  media: PublicBookingOptions['media'],
): Promise<PublicCalendarAppearance> {
  const addressOf = async (fileId: string | null): Promise<string | null> => {
    const id = fileId === null ? undefined : parsePublicId('file', fileId);
    return id === undefined || media === undefined ? null : media.publicAddress(trx, id);
  };
  const { calendar } = config;
  return {
    style: calendar.widgetStyle,
    primaryColor: calendar.primaryColor,
    backgroundColor: calendar.backgroundColor,
    buttonText: calendar.buttonText,
    logoUrl: await addressOf(calendar.logoFileId),
    coverUrl: await addressOf(calendar.coverFileId),
  };
}

/** The length asked for, when the calendar offers it. */
function lengthOf(config: CalendarConfiguration, minutes: number | undefined): number {
  const offered = durationsOf(config);
  if (minutes === undefined) return config.calendar.slotMinutes;
  if (!offered.includes(minutes))
    throw new ValidationError([
      { path: '/minutes', code: 'not_offered', message: 'Choose one of the lengths offered.' },
    ]);
  return minutes;
}

/** The membership of a host, for the CRM's owner command. */
async function membershipOf(
  options: { readonly calendars: Pick<CalendarOptions, 'members'> },
  trx: DatabaseTransaction,
  context: TenantContext,
  config: CalendarConfiguration,
  userId: string,
): Promise<string | undefined> {
  for (const member of config.members) {
    if (member.membershipId === null) continue;
    try {
      if ((await options.calendars.members.resolve(trx, context, member.membershipId)) === userId)
        return member.membershipId;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
    }
  }
  return undefined;
}

/**
 * The "Text me reminders" words, naming the business that sends by its name now (CTIA
 * Messaging Principles 5.1.1): what the page shows, and what a booking keeps as proof.
 * Rendered here each time, never taken from the browser.
 */
async function textWordingOf(trx: DatabaseTransaction, businessId: string): Promise<string> {
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select('name')
    .where('id', '=', businessId)
    .executeTakeFirstOrThrow();
  return bookingTextWording(business.name);
}

/** How long an appointment is, in minutes. */
const lengthMinutes = (appointment: { readonly starts_at: Date; readonly ends_at: Date }): number =>
  Math.round((appointment.ends_at.getTime() - appointment.starts_at.getTime()) / 60_000);

/** The sending mailbox, while it can still send; null when there is none or it is gone. */
async function senderOf(
  options: { readonly calendars: Pick<CalendarOptions, 'senders'> },
  trx: DatabaseTransaction,
  context: TenantContext,
  senderId: string | null,
): Promise<string | null> {
  if (senderId === null) return null;
  try {
    return await options.calendars.senders.resolve(trx, context, senderId);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}
async function resolveCalendar(
  executor: PublicBookingOptions['db'] | DatabaseTransaction,
  params: PublicCalendarParams,
): Promise<CalendarScope> {
  const { rows } = await sql<CalendarScope>`
    select * from private.resolve_calendar(${params.agencySlug},${params.businessSlug},${params.calendarSlug})
  `.execute(executor);
  const scope = rows[0];
  if (scope === undefined) throw unavailable();
  return scope;
}
/**
 * Holds the place on the team of every member who still has one, until the booking
 * commits, and says who they are. A member who left, or leaves while this waits, is not a
 * host: a round-robin calendar carries on with the others. With nobody left (always so
 * for a personal calendar, which is one person) the calendar is as unbookable as one read
 * after the removal, and the public answer says no more than that.
 */
export async function holdMembers(
  options: { readonly calendars: Pick<CalendarOptions, 'members'> },
  trx: DatabaseTransaction,
  context: TenantContext,
  config: CalendarConfiguration,
): Promise<ReadonlySet<string>> {
  const hosts = new Set<string>();
  for (const member of config.members) {
    if (member.membershipId === null) continue;
    try {
      hosts.add(await options.calendars.members.resolve(trx, context, member.membershipId));
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
    }
  }
  if (hosts.size === 0) throw unavailable();
  return hosts;
}
/** The calendar's members who are on the team now, read without holding them. */
async function presentMembers(
  options: PublicBookingOptions,
  trx: DatabaseTransaction,
  context: TenantContext,
  scope: CalendarScope,
): Promise<ReadonlySet<string>> {
  const stored = await trx
    .selectFrom('calendar.calendar_members')
    .select('user_id')
    .where('business_id', '=', scope.business_id)
    .where('calendar_id', '=', scope.calendar_id)
    .execute();
  const memberships = await options.calendars.members.memberships(
    trx,
    context,
    stored.map((member) => member.user_id),
  );
  return new Set(memberships.keys());
}
function invocationFor(scope: CalendarScope, request: PublicBookingRequestContext): Invocation {
  return {
    context: {
      agencyId: scope.agency_id,
      businessId: scope.business_id,
      actorKind: 'contact',
      correlationId: request.requestId,
    },
    permissions: new Set(),
    ip: request.ipAddress,
  };
}
async function publicCalendarTransaction<T>(
  options: PublicBookingOptions,
  rawParams: PublicCalendarParams,
  rawRequest: PublicBookingRequestContext,
  read: (trx: DatabaseTransaction, invocation: Invocation, scope: CalendarScope) => Promise<T>,
): Promise<T> {
  const params = parseInput(publicCalendarParams, rawParams);
  const request = contextOf(rawRequest);
  const scope = await resolveCalendar(options.db, params);
  request.onBusiness?.(scope.business_id);
  const invocation = invocationFor(scope, request);
  return withTenant(options.db, invocation.context, async (trx) => {
    await options.calendars.business.lockActive(trx, invocation.context);
    // A suspension, slug or configuration change may have committed while the lock waited.
    const current = await resolveCalendar(trx, params);
    if (current.calendar_id !== scope.calendar_id || current.business_id !== scope.business_id)
      throw unavailable();
    return read(trx, invocation, scope);
  });
}

// The calendar's own word on whether the person who booked may still move the appointment.
function refuseByPolicy(config: CalendarConfiguration, action: 'reschedule', startsAt: Date): void {
  const refused = policyRefusal(
    {
      allowed: config.calendar.allowReschedule,
      cutoffMinutes: config.calendar.rescheduleCutoffMinutes,
    },
    action,
    startsAt,
    new Date(),
  );
  if (refused !== undefined) throw new ConflictError(refused);
}

export function createPublicBookingHandlers(options: PublicBookingOptions): PublicBookingHandlers {
  return {
    appointmentSlots: (token, query, request) =>
      readManagedSlots(
        options,
        async (trx, context, appointment, date) => {
          const config = await readCalendar(
            trx,
            { context, permissions: new Set() },
            toPublicId('calendar', appointment.calendar_id),
            options.calendars,
          );
          if (!config.calendar.bookable) throw unavailable();
          refuseByPolicy(config, 'reschedule', appointment.starts_at);
          const hosts = await holdMembers(options, trx, context, config);
          const slots = await availableSlots(
            trx,
            {
              agency_id: context.agencyId,
              business_id: appointment.business_id,
              calendar_id: appointment.calendar_id,
            },
            config,
            date,
            hosts,
            appointment.id,
            'public',
            { minutes: lengthMinutes(appointment) },
          );
          return {
            slots: slots
              .filter(
                (slot) =>
                  appointment.assigned_user_id !== null &&
                  slot.availableMemberIds.includes(appointment.assigned_user_id),
              )
              .map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
          };
        },
        parseInput(appointmentCapability, token),
        parseInput(publicSlotQuery, query).date,
        contextOf(request),
      ),
    reschedule: (token, input, request) =>
      rescheduleManagedAppointment(
        options,
        async (trx, command, appointment, startsAt) => {
          const config = await readCalendar(
            trx,
            command,
            toPublicId('calendar', appointment.calendar_id),
            options.calendars,
          );
          if (!config.calendar.bookable) throw unavailable();
          refuseByPolicy(config, 'reschedule', appointment.starts_at);
          const hosts = await holdMembers(options, trx, command.context, config);
          const date = Temporal.Instant.from(startsAt)
            .toZonedDateTimeISO(config.calendar.timezone)
            .toPlainDate()
            .toString();
          const slots = await availableSlots(
            trx,
            {
              agency_id: command.context.agencyId,
              business_id: appointment.business_id,
              calendar_id: appointment.calendar_id,
            },
            config,
            date,
            hosts,
            appointment.id,
            'public',
            // A moved appointment keeps the length it was booked with.
            { minutes: lengthMinutes(appointment) },
          );
          const slot = slots.find(
            (candidate) =>
              candidate.startsAt === startsAt &&
              appointment.assigned_user_id !== null &&
              candidate.availableMemberIds.includes(appointment.assigned_user_id),
          );
          if (slot === undefined) throw new ConflictError('This appointment time is unavailable.');
          return {
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            bufferBeforeMinutes: config.calendar.bufferBeforeMinutes,
            bufferAfterMinutes: config.calendar.bufferAfterMinutes,
          };
        },
        parseInput(appointmentCapability, token),
        input,
        contextOf(request),
      ),
    cancel: (token, input, request) =>
      cancelManagedAppointment(
        options,
        parseInput(appointmentCapability, token),
        input,
        contextOf(request),
      ),
    appointment: (token, request) =>
      readManagedAppointment(options, parseInput(appointmentCapability, token), contextOf(request)),
    calendar: (params, request) =>
      publicCalendarTransaction(options, params, request, async (trx, invocation, scope) => {
        const config = await readCalendar(
          trx,
          invocation,
          toPublicId('calendar', scope.calendar_id),
          options.calendars,
        );
        if (!config.calendar.bookable) throw unavailable();
        return {
          name: config.calendar.name,
          description: config.calendar.description,
          timezone: config.calendar.timezone,
          slotMinutes: config.calendar.slotMinutes,
          durations: durationsOf(config),
          notificationWording: notificationWordingOf(config),
          // "Text me reminders", only where the business can text now; left out, no box.
          ...((await options.texts?.available(trx)) === true
            ? { textWording: await textWordingOf(trx, scope.business_id) }
            : {}),
          // Bound to this calendar and to the address that asked, and good for one booking.
          renderToken: options.shown.issue(scope.calendar_id, contextOf(request).ipAddress),
          // Only when it is on, so a page without it is answered as before.
          ...(config.calendar.botProtection === 'altcha'
            ? { botProtection: 'altcha' as const }
            : {}),
          appearance: await appearanceOf(trx, config, options.media),
        };
      }),
    challenge: (params, input, request) =>
      publicCalendarTransaction(options, params, request, async (trx, invocation, scope) => {
        const { renderToken } = parseInput(botChallengeRequest, input);
        const config = await readCalendar(
          trx,
          invocation,
          toPublicId('calendar', scope.calendar_id),
          options.calendars,
        );
        if (!config.calendar.bookable || config.calendar.botProtection !== 'altcha')
          throw unavailable();
        const { bot } = options;
        if (bot === undefined) throw unavailable();
        // Bound to the showing the visitor holds, which it may ask for at once: the pause a
        // person takes is checked when the booking is sent.
        const mark = options.shown.mark(
          scope.calendar_id,
          contextOf(request).ipAddress,
          renderToken,
        );
        if (mark === undefined) throw pageStale();
        return bot.issue(mark);
      }),
    slots: (params, query, request) =>
      publicCalendarTransaction(options, params, request, async (trx, invocation, scope) => {
        const { date, minutes } = parseInput(publicSlotQuery, query);
        const config = await readCalendar(
          trx,
          invocation,
          toPublicId('calendar', scope.calendar_id),
          options.calendars,
        );
        if (!config.calendar.bookable) throw unavailable();
        const hosts = await presentMembers(options, trx, invocation.context, scope);
        const slots = await availableSlots(trx, scope, config, date, hosts, undefined, 'public', {
          minutes: lengthOf(config, minutes),
        });
        return { slots: slots.map(({ startsAt, endsAt }) => ({ startsAt, endsAt })) };
      }),
    async book(rawParams, rawInput, rawRequest) {
      const params = parseInput(publicCalendarParams, rawParams);
      const request = contextOf(rawRequest);
      // Anything in the field people cannot see means a program filled the page. It is told
      // what a person is told, and nothing is looked up or stored.
      const sent = parseInput(publicBookingInput, rawInput);
      if (sent.trap !== '') {
        const startsAt = Temporal.Instant.from(sent.startsAt).epochMilliseconds;
        return publicBookingReceipt.parse({
          status: 'booked',
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(startsAt + (sent.minutes ?? 30) * 60_000).toISOString(),
          emailed: false,
        });
      }
      const scope = await resolveCalendar(options.db, params);
      request.onBusiness?.(scope.business_id);
      // Google is read again for the hosts around the time asked for, before the booking
      // takes its locks; the booking then decides from what is known.
      if (options.google !== undefined)
        await options.google.freshen(
          invocationFor(scope, request).context,
          scope.calendar_id,
          freshRangeAround(sent.startsAt),
        );
      const invocation: Invocation = {
        ...invocationFor(scope, request),
        permissions: new Set(['calendars.manage']),
      };
      const command = defineCommand({
        name: 'calendar.public.book',
        permission: 'calendars.manage',
        input: publicBookingInput,
        audit: () => ({ calendarId: toPublicId('calendar', scope.calendar_id), operation: 'book' }),
        async handle(trx, input, context) {
          await options.calendars.business.lockActive(trx, context.context);
          const calendar = await trx
            .selectFrom('calendar.calendars')
            .select('id')
            .where('business_id', '=', scope.business_id)
            .where('id', '=', scope.calendar_id)
            .forUpdate()
            .executeTakeFirst();
          if (calendar === undefined) throw unavailable();
          const normalized = {
            ...input,
            startsAt: Temporal.Instant.from(input.startsAt).toString(),
          };
          // What was asked for, without the page's proofs: a page shown again sends the same
          // booking with a new token, and it is still the same booking. The proof's own
          // spending is kept with the appointment (render_mark).
          const asked = Object.fromEntries(
            Object.entries(normalized).filter(
              ([key]) => key !== 'renderToken' && key !== 'trap' && key !== 'botProof',
            ),
          );
          const digest = createHash('sha256').update(JSON.stringify(asked)).digest('hex');
          const previous = await trx
            .selectFrom('calendar.appointments')
            .select(['status', 'starts_at', 'ends_at', 'booking_request_digest'])
            .where('business_id', '=', scope.business_id)
            .where('calendar_id', '=', scope.calendar_id)
            .where('booking_request_id', '=', input.bookingRequestId)
            .executeTakeFirst();
          if (previous !== undefined) {
            if (previous.booking_request_digest !== digest)
              throw new ConflictError('This booking request already identifies different details.');
            return receiptOf(previous);
          }
          // The page must have been shown to this address, long enough ago, and its token
          // not spent on a booking already (the forms mechanism: forms/render-token.ts).
          const shown = options.shown.check(
            scope.calendar_id,
            request.ipAddress,
            input.renderToken,
          );
          if (!shown.accepted) {
            if (shown.reason === 'too_fast') throw new BookingTooSoonError(shown.retryAfterSeconds);
            throw pageStale();
          }
          const spent = await trx
            .selectFrom('calendar.appointments')
            .select('id')
            .where('business_id', '=', scope.business_id)
            .where('calendar_id', '=', scope.calendar_id)
            .where('render_mark', '=', shown.mark)
            .executeTakeFirst();
          if (spent !== undefined) throw pageStale();
          const current = await resolveCalendar(trx, params);
          if (
            current.calendar_id !== scope.calendar_id ||
            current.business_id !== scope.business_id
          )
            throw unavailable();
          const config = await readCalendar(
            trx,
            context,
            toPublicId('calendar', scope.calendar_id),
            options.calendars,
          );
          if (!config.calendar.bookable) throw unavailable();
          // A calendar that asks for bot protection takes only a proof solved for this
          // showing of its page. Without one, or with a wrong or expired one, the page is
          // shown again: it solves a new challenge and sends the booking again.
          if (
            config.calendar.botProtection === 'altcha' &&
            (options.bot === undefined || !(await options.bot.verify(shown.mark, input.botProof)))
          )
            throw pageStale();
          // A box the calendar asks the visitor to tick, or none: then no email is sent.
          const wording = notificationWordingOf(config);
          if (wording !== null && input.notificationConsent !== true)
            throw new ValidationError([
              {
                path: '/notificationConsent',
                code: 'required',
                message: 'Tick the box to get your confirmation by email.',
              },
            ]);
          // "Text me reminders" is for the number given with it.
          if (input.textConsent === true && input.contact.phone === undefined)
            throw new ValidationError([
              {
                path: '/contact/phone',
                code: 'required',
                message: 'Give the phone number to text the reminders to.',
              },
            ]);
          const minutes = lengthOf(config, input.minutes);
          const hosts = await holdMembers(options, trx, context.context, config);
          // Without a mailbox (or one that can no longer send) the booking is still taken:
          // it is shown on the page with its link, and the host is told as for every booking.
          const accountId = await senderOf(
            options,
            trx,
            context.context,
            config.calendar.confirmationSenderId,
          );
          const localDate = Temporal.Instant.from(normalized.startsAt)
            .toZonedDateTimeISO(config.calendar.timezone)
            .toPlainDate()
            .toString();
          const slots = await availableSlots(
            trx,
            scope,
            config,
            localDate,
            hosts,
            undefined,
            'public',
            { minutes },
          );
          const slot = slots.find((slot) => slot.startsAt === normalized.startsAt);
          if (slot === undefined) throw new ConflictError('This appointment time is unavailable.');
          const assignedUserId = await chooseHost(trx, scope, slot.availableMemberIds);
          if (assignedUserId === undefined)
            throw new ConflictError('This appointment time is unavailable.');
          const contact = await options.contacts.intake(
            trx,
            {
              firstName: input.contact.firstName,
              lastName: input.contact.lastName,
              emails: [input.contact.email],
              ...(input.contact.phone === undefined ? {} : { phones: [input.contact.phone] }),
            },
            context,
          );
          if (contact.emailIdentityId === null)
            throw new ConflictError('Contact details could not be accepted.');
          const token = randomBytes(32).toString('base64url');
          const managementDigest = createHash('sha256').update(token).digest('hex');
          const appointment = await trx
            .insertInto('calendar.appointments')
            .values({
              business_id: scope.business_id,
              calendar_id: scope.calendar_id,
              contact_id: contact.contactId,
              assigned_user_id: assignedUserId,
              title: inviteTitleOf(
                config.calendar.inviteTitle,
                bookerValues(input.contact),
                config.calendar.name,
              ),
              starts_at: slot.startsAt,
              ends_at: slot.endsAt,
              source: 'booking_page',
              location: await meetingPlaceOf(
                trx,
                scope.business_id,
                scope.calendar_id,
                assignedUserId,
              ),
              cancel_reason: null,
              cancelled_at: null,
              buffer_before_minutes: config.calendar.bufferBeforeMinutes,
              buffer_after_minutes: config.calendar.bufferAfterMinutes,
              confirmation_account_id: accountId,
              booking_request_id: input.bookingRequestId,
              booking_request_digest: digest,
              management_digest: managementDigest,
              management_expires_at: Temporal.Instant.from(slot.endsAt)
                .add({ hours: 720 })
                .toString(),
              booker_timezone: input.contactTimezone,
              render_mark: shown.mark,
            })
            .returningAll()
            .executeTakeFirstOrThrow()
            .catch((error: unknown) => {
              // The exclusions remain authoritative against writers outside this command, in
              // this business and in every other the host belongs to.
              if (isDoubleBooking(error))
                throw new ConflictError('This appointment time is unavailable.');
              throw error;
            });
          await options.contacts.setTimezone(
            trx,
            { contactId: contact.contactId, timezone: input.contactTimezone },
            context,
          );
          await options.contacts.attribute?.(
            trx,
            { contactId: contact.contactId, appointmentId: appointment.id, visit: input.visit },
            context,
          );
          if (wording !== null)
            await options.notifications.recordConsent(
              trx,
              {
                contactId: contact.contactId,
                appointmentId: appointment.id,
                notificationConsent: true,
                ipAddress: request.ipAddress,
                wording,
              },
              context,
            );
          // Ticked, and the business can still text: transactional consent for that number,
          // with the box's words as this server renders them, naming the business by its name
          // now; the browser only says it was ticked. A box the page did not offer (the
          // business stopped texting meanwhile) records nothing, and the booking stands.
          if (
            input.textConsent === true &&
            input.contact.phone !== undefined &&
            options.texts !== undefined &&
            (await options.texts.available(trx))
          )
            await options.texts.recordConsent(
              trx,
              {
                contactId: contact.contactId,
                appointmentId: appointment.id,
                phone: input.contact.phone,
                ipAddress: request.ipAddress,
                wording: await textWordingOf(trx, scope.business_id),
              },
              context,
            );
          // The calendar's assignment setting: the host becomes the contact's owner, or
          // only when the contact has none.
          if (config.calendar.assignContactToMember && options.contacts.assignOwner !== undefined) {
            const membershipId = await membershipOf(
              options,
              trx,
              context.context,
              config,
              assignedUserId,
            );
            if (membershipId !== undefined)
              await options.contacts.assignOwner(
                trx,
                {
                  contactId: contact.contactId,
                  membershipId,
                  keepExisting: config.calendar.skipAssignIfOwned,
                },
                context,
              );
          }
          const managementUrl = new URL(`/appointments/manage/${token}`, options.publicOrigin).href;
          const emailed = accountId !== null && wording !== null;
          if (emailed) {
            const message = await confirmationOf(
              trx,
              options.publicOrigin,
              appointment,
              'booked',
              managementUrl,
            );
            const confirmation = await options.notifications.queue(trx, context.context, {
              identityId: contact.emailIdentityId,
              accountId,
              idempotencyKey: `calendar:book:${appointment.id}`,
              ...message,
            });
            if (confirmation.outcome !== 'queued')
              throw new ConflictError('This booking could not queue its confirmation.');
          }
          await context.emit({
            type: 'appointment.booked',
            subject: { kind: 'appointment', id: appointment.id },
            records: [contact.contactId],
            payload: {
              calendarId: scope.calendar_id,
              contactId: contact.contactId,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
            },
          });
          return { ...receiptOf(appointment), managementUrl, emailed };
        },
      });
      return runCommand(
        {
          db: options.db,
          authorize: (candidate, name) =>
            name === 'calendar.public.book' &&
            candidate.context.actorKind === 'contact' &&
            candidate.context.agencyId === scope.agency_id &&
            candidate.context.businessId === scope.business_id,
        },
        command,
        rawInput,
        invocation,
      );
    },
  };
}

function receiptOf(row: { status: string; starts_at: Date; ends_at: Date }) {
  return publicAppointmentReceipt.parse({
    status: row.status,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
  });
}

/**
 * Who of the members free for a slot takes it: by weight, counting the appointments each
 * already has on the calendar that were not cancelled. The booking page and the team's own
 * bookings choose alike.
 */
export async function chooseHost(
  trx: DatabaseTransaction,
  scope: CalendarScope,
  availableMemberIds: readonly string[],
): Promise<string | undefined> {
  const members = await trx
    .selectFrom('calendar.calendar_members')
    .select(['user_id', 'weight'])
    .where('business_id', '=', scope.business_id)
    .where('calendar_id', '=', scope.calendar_id)
    .where('user_id', 'in', availableMemberIds)
    .execute();
  const counts = await trx
    .selectFrom('calendar.appointments')
    .select(['assigned_user_id', sql<string>`count(*)::text`.as('count')])
    .where('business_id', '=', scope.business_id)
    .where('calendar_id', '=', scope.calendar_id)
    .where('status', '!=', 'cancelled')
    .groupBy('assigned_user_id')
    .execute();
  return chooseWeightedMember(
    members.map((member) => ({
      id: member.user_id,
      weight: member.weight,
      assignedCount: BigInt(
        counts.find((count) => count.assigned_user_id === member.user_id)?.count ?? '0',
      ),
    })),
  );
}

export async function availableSlots(
  trx: DatabaseTransaction,
  scope: CalendarScope,
  config: CalendarConfiguration,
  localDate: string,
  /** The members who may host: those on the team now. Nobody else is offered or assigned. */
  hosts: ReadonlySet<string>,
  excludedAppointmentId?: string,
  /**
   * Who is asking. The public is shown fewer slots when the calendar is set to look busy;
   * the team always sees every slot that is really free.
   */
  audience: 'public' | 'team' = 'public',
  /** The length of the meeting asked for; the calendar's own by default. */
  shape: { readonly minutes?: number } = {},
): Promise<CalendarSlot[]> {
  const slotMinutes = shape.minutes ?? config.calendar.slotMinutes;
  const stored = await trx
    .selectFrom('calendar.calendar_members')
    .select(['user_id', 'weight'])
    .where('business_id', '=', scope.business_id)
    .where('calendar_id', '=', scope.calendar_id)
    .execute();
  const members = stored.filter((member) => hosts.has(member.user_id));
  if (members.length === 0) return [];
  const date = Temporal.PlainDate.from(localDate);
  const start = date
    .toPlainDateTime('00:00')
    .toZonedDateTime(config.calendar.timezone, { disambiguation: 'earlier' })
    .toInstant();
  const end = date
    .add({ days: 1 })
    .toPlainDateTime('00:00')
    .toZonedDateTime(config.calendar.timezone, { disambiguation: 'later' })
    .toInstant();
  let appointmentsQuery = trx
    .selectFrom('calendar.appointments')
    .select(['assigned_user_id', 'occupied_starts_at', 'occupied_ends_at'])
    .where('business_id', '=', scope.business_id);
  if (excludedAppointmentId !== undefined)
    appointmentsQuery = appointmentsQuery.where('id', '!=', excludedAppointmentId);
  const appointments = await appointmentsQuery
    .where(
      'assigned_user_id',
      'in',
      members.map((member) => member.user_id),
    )
    .where('status', 'in', ['booked', 'confirmed'])
    .where('occupied_starts_at', '<', new Date(end.epochMilliseconds))
    .where('occupied_ends_at', '>', new Date(start.epochMilliseconds))
    .execute();
  // A slot's occupied time reaches past its local day by at most a slot and both buffers.
  const reach =
    (slotMinutes + config.calendar.bufferBeforeMinutes + config.calendar.bufferAfterMinutes) *
    60_000;
  // One person has one diary: what the same people hold in every other business they
  // belong to counts too, read as bare busy times (private.host_busy, 0102).
  const { rows: elsewhere } = await sql<{ user_id: string; starts_at: Date; ends_at: Date }>`
    select user_id, starts_at, ends_at from private.host_busy(
      ${members.map((member) => member.user_id)}::uuid[],
      ${new Date(start.epochMilliseconds - reach)}::timestamptz,
      ${new Date(end.epochMilliseconds + reach)}::timestamptz
    )
  `.execute(trx);
  // Blocked time in this business: each member's own, and the calendar's.
  const blocked = await readBlockedTime(
    trx,
    scope,
    members.map((member) => member.user_id),
    {
      from: new Date(start.epochMilliseconds - reach),
      to: new Date(end.epochMilliseconds + reach),
    },
  );
  // A member's Google calendars: busy time the worker read, and time it has not read
  // lately, which is not free. Members without a working connection are not in it.
  const google = await readGoogleBusy(
    trx,
    scope.business_id,
    members.map((member) => member.user_id),
    {
      from: new Date(start.epochMilliseconds - reach),
      to: new Date(end.epochMilliseconds + reach),
    },
  );
  const busy = new Map(
    members.map((member) => [
      member.user_id,
      [
        ...(blocked.get(member.user_id) ?? []),
        ...(google.get(member.user_id) ?? []),
        ...appointments
          .filter((appointment) => appointment.assigned_user_id === member.user_id)
          .map((appointment) => ({
            startsAt: appointment.occupied_starts_at.toISOString(),
            endsAt: appointment.occupied_ends_at.toISOString(),
          })),
        ...elsewhere
          .filter((period) => period.user_id === member.user_id)
          .map((period) => ({
            startsAt: period.starts_at.toISOString(),
            endsAt: period.ends_at.toISOString(),
          })),
      ],
    ]),
  );
  const schedules = await readUserAvailabilityProfiles(
    trx,
    scope.business_id,
    members.map((member) => member.user_id),
    {
      from: new Date(start.epochMilliseconds - reach),
      to: new Date(end.epochMilliseconds + reach),
    },
  );
  // What the date already holds on this calendar counts against its daily limit; the
  // appointment being moved does not count against itself.
  const maxPerDay = config.calendar.maxPerDay;
  let bookedQuery = trx
    .selectFrom('calendar.appointments')
    .select((select) => select.fn.countAll<string>().as('booked'))
    .where('business_id', '=', scope.business_id)
    .where('calendar_id', '=', scope.calendar_id)
    .where('status', 'in', ['booked', 'confirmed'])
    .where('starts_at', '>=', new Date(start.epochMilliseconds))
    .where('starts_at', '<', new Date(end.epochMilliseconds));
  if (excludedAppointmentId !== undefined)
    bookedQuery = bookedQuery.where('id', '!=', excludedAppointmentId);
  const booked = maxPerDay === null ? 0 : Number((await bookedQuery.executeTakeFirst())?.booked);
  // How many each start time of the date already holds on this calendar (maxPerSlot).
  let perStartQuery = trx
    .selectFrom('calendar.appointments')
    .select(['starts_at', (select) => select.fn.countAll<string>().as('taken')])
    .where('business_id', '=', scope.business_id)
    .where('calendar_id', '=', scope.calendar_id)
    .where('status', 'in', ['booked', 'confirmed'])
    .where('starts_at', '>=', new Date(start.epochMilliseconds))
    .where('starts_at', '<', new Date(end.epochMilliseconds))
    .groupBy('starts_at');
  if (excludedAppointmentId !== undefined)
    perStartQuery = perStartQuery.where('id', '!=', excludedAppointmentId);
  const taken = new Map(
    (await perStartQuery.execute()).map((row) => [
      Temporal.Instant.from(row.starts_at.toISOString()).toString(),
      Number(row.taken),
    ]),
  );
  return generateCalendarSlots(
    {
      ...config.calendar,
      slotMinutes,
      // A longer meeting still starts on the calendar's own grid.
      slotIntervalMinutes: config.calendar.slotIntervalMinutes ?? config.calendar.slotMinutes,
      ...(config.calendar.maxPerSlot === null
        ? {}
        : { slotLimit: { max: config.calendar.maxPerSlot, taken } }),
      weeklyHours: config.weeklyHours,
      dateOverrides: config.dateOverrides,
      members: members.map((member) => ({ id: member.user_id, weight: member.weight })),
      ...(maxPerDay === null ? {} : { dayLimit: { max: maxPerDay, booked } }),
      ...(audience === 'public' && config.calendar.lookBusyPercent > 0
        ? { lookBusy: { percent: config.calendar.lookBusyPercent, seed: scope.calendar_id } }
        : {}),
    },
    localDate,
    new Date().toISOString(),
    busy,
    schedules,
  );
}
