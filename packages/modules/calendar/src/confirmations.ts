// The email a booker is sent when their appointment is booked, moved or cancelled, from the
// booking page or by the team: the time in words in their own zone and the calendar's
// (invite.ts), and a calendar invite with the appointment's stable UID and SEQUENCE.
import type { DatabaseTransaction } from '@repo/db';

import { appointmentInvite, whenText } from './invite.js';
import type { ConfirmationInvite } from './public-routes.js';

export type ConfirmationKind = 'booked' | 'rescheduled' | 'cancelled';

/** What a confirmation reads of the appointment, as stored. */
export interface ConfirmedAppointment {
  readonly id: string;
  readonly business_id: string;
  readonly calendar_id: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly title: string;
  readonly location: string | null;
  readonly sequence: number;
  readonly booker_timezone: string | null;
}

export interface Confirmation {
  readonly subject: string;
  readonly text: string;
  readonly invite: ConfirmationInvite;
}

const SUBJECTS: Readonly<Record<ConfirmationKind, string>> = {
  booked: 'Your appointment is booked',
  rescheduled: 'Your appointment has moved',
  cancelled: 'Your appointment is cancelled',
};
const OPENINGS: Readonly<Record<ConfirmationKind, string>> = {
  booked: 'Your appointment is booked.',
  rescheduled: 'Your appointment has moved to a new time.',
  cancelled: 'Your appointment has been cancelled.',
};

/** The UID of every invite about one appointment (RFC 5545 3.8.4.7): its id at the CRM's host. */
export const inviteUid = (appointmentId: string, publicOrigin: string): string =>
  `${appointmentId}@${new URL(publicOrigin).hostname}`;

export async function confirmationOf(
  trx: DatabaseTransaction,
  publicOrigin: string,
  appointment: ConfirmedAppointment,
  kind: ConfirmationKind,
  managementUrl: string | undefined,
): Promise<Confirmation> {
  const calendar = await trx
    .selectFrom('calendar.calendars')
    .select(['name', 'timezone'])
    .where('business_id', '=', appointment.business_id)
    .where('id', '=', appointment.calendar_id)
    .executeTakeFirstOrThrow();
  const startsAt = appointment.starts_at.toISOString();
  const endsAt = appointment.ends_at.toISOString();
  const when = whenText({
    startsAt,
    endsAt,
    calendarZone: calendar.timezone,
    bookerZone: appointment.booker_timezone,
  });
  const location = appointment.location?.trim() ?? '';
  const manage = managementUrl === undefined ? [] : [`Manage this appointment: ${managementUrl}`];
  const text = [
    OPENINGS[kind],
    '',
    when,
    '',
    calendar.name,
    ...(location === '' ? [] : [`Where: ${location}`]),
    ...manage,
  ].join('\n');
  const stamp = new Date();
  return {
    subject: SUBJECTS[kind],
    text,
    invite: {
      method: kind === 'cancelled' ? 'CANCEL' : 'REQUEST',
      build: (parties) =>
        appointmentInvite({
          method: kind === 'cancelled' ? 'CANCEL' : 'REQUEST',
          uid: inviteUid(appointment.id, publicOrigin),
          sequence: appointment.sequence,
          stamp,
          startsAt,
          endsAt,
          summary: appointment.title,
          description: [calendar.name, ...manage].join('\n'),
          location: appointment.location,
          organizer: parties.organizer,
          attendee: parties.attendee,
        }),
    },
  };
}
