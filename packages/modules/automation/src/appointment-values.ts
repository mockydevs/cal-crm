// The appointment a run is about, as appointment.<key> (contracts automationAppointmentFields):
// the appointment whose event started the run, otherwise the one the run's latest wait for
// an appointment waited for. Read as it is now, so a reminder sent after a reschedule names
// the new time. Every key is there, null, for a run without one, as deal.* is.
import { automationAppointmentFields, type ConditionValues } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { sql } from 'kysely';

/** Every appointment.* path, empty. */
export const NO_APPOINTMENT: ConditionValues = Object.fromEntries(
  Object.keys(automationAppointmentFields).map((key) => [`appointment.${key}`, null]),
);

/**
 * A region zone this runtime knows, such as America/New_York. An abbreviation such as EST
 * has no summer time, so it is never used, as quiet hours never use one.
 */
function knownZone(zone: string | null | undefined): string | undefined {
  if (zone === null || zone === undefined || (!zone.includes('/') && zone !== 'UTC'))
    return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

// Every kind of space, such as the narrow ones some ICU versions put before AM and PM,
// reads as a plain space in mail (\s takes U+00A0 and U+202F).
const spaced = (text: string): string => text.replaceAll(/\s/g, ' ');

/**
 * When an appointment starts, in words in a zone: "Thursday, October 15, 2026, 3:00 PM
 * Eastern Daylight Time". US English, as the booking's own confirmation says it.
 */
export function startTimeWords(startsAt: Date, zone: string): string {
  const date = new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'full' }).format(
    startsAt,
  );
  const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeStyle: 'short' }).format(
    startsAt,
  );
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' })
      .formatToParts(startsAt)
      .find((part) => part.type === 'timeZoneName')?.value ?? zone;
  return spaced(`${date}, ${time} ${name}`);
}

/**
 * Makes the appointment's reschedule-or-cancel address (the calendar module's keyed link,
 * migration 0107): null when the install serves no public pages, or the appointment is not
 * booked or confirmed or has ended. Only a step that sends a message is given one, so
 * appointment.manageUrl is empty in conditions and a link is made only to be sent.
 */
export interface AppointmentLinks {
  readonly manageUrl: (trx: DatabaseTransaction, appointmentId: string) => Promise<string | null>;
}

/** The appointment's id the run is about, as stored; undefined when it is about none. */
async function appointmentOfRun(
  trx: DatabaseTransaction,
  enrolmentId: string,
): Promise<string | undefined> {
  const started = await trx
    .selectFrom('automation.enrolments as run')
    .innerJoin('events.events as event', 'event.id', 'run.trigger_event_id')
    .select('event.subject_id')
    .where('run.id', '=', enrolmentId)
    .where('event.subject_kind', '=', 'appointment')
    .executeTakeFirst();
  if (started !== undefined) return started.subject_id;
  // A wait for an appointment keeps the one it waited for in its output.
  const waited = await trx
    .selectFrom('automation.step_runs')
    .select(sql<string>`output->>'appointmentId'`.as('appointment'))
    .where('enrolment_id', '=', enrolmentId)
    .where('status', '=', 'succeeded')
    .where(sql<boolean>`output ? 'appointmentId'`)
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return waited === undefined ? undefined : parsePublicId('appointment', waited.appointment);
}

/**
 * The appointment a run's message is about, when it is the run's own contact's: what a
 * transactional message names, so quiet hours do not hold a reminder of it.
 */
export async function runAppointment(
  trx: DatabaseTransaction,
  recordId: string,
  enrolmentId: string,
): Promise<string | undefined> {
  const id = await appointmentOfRun(trx, enrolmentId);
  if (id === undefined) return undefined;
  const own = await trx
    .selectFrom('calendar.appointments')
    .select('id')
    .where('id', '=', id)
    .where('contact_id', '=', recordId)
    .executeTakeFirst();
  return own?.id;
}

/**
 * The values of the appointment the run is about. The time is in the zone the contact
 * booked in, else the contact's own, else the calendar's: the one they think in.
 */
export async function appointmentValues(
  trx: DatabaseTransaction,
  recordId: string,
  enrolmentId: string,
  links?: AppointmentLinks,
): Promise<ConditionValues> {
  const id = await appointmentOfRun(trx, enrolmentId);
  if (id === undefined) return NO_APPOINTMENT;
  const row = await trx
    .selectFrom('calendar.appointments as appointment')
    .innerJoin('calendar.calendars as calendar', (join) =>
      join
        .onRef('calendar.id', '=', 'appointment.calendar_id')
        .onRef('calendar.business_id', '=', 'appointment.business_id'),
    )
    .innerJoin('crm.contacts as contact', (join) =>
      join
        .onRef('contact.id', '=', 'appointment.contact_id')
        .onRef('contact.business_id', '=', 'appointment.business_id'),
    )
    .select([
      'appointment.title',
      'appointment.starts_at',
      'appointment.location',
      'appointment.status',
      'appointment.booker_timezone',
      'calendar.name as calendar',
      'calendar.timezone as calendar_timezone',
      'contact.timezone as contact_timezone',
    ])
    .where('appointment.id', '=', id)
    // Only the run's own contact's appointment is ever read into its messages.
    .where('appointment.contact_id', '=', recordId)
    .executeTakeFirst();
  if (row === undefined) return NO_APPOINTMENT;
  const zone =
    knownZone(row.booker_timezone) ??
    knownZone(row.contact_timezone) ??
    knownZone(row.calendar_timezone) ??
    'UTC';
  const location = row.location?.trim() ?? '';
  return {
    'appointment.title': row.title,
    'appointment.startTime': startTimeWords(row.starts_at, zone),
    'appointment.startsAt': row.starts_at.toISOString(),
    'appointment.calendar': row.calendar,
    'appointment.location': location === '' ? null : location,
    'appointment.status': row.status,
    'appointment.manageUrl': links === undefined ? null : await links.manageUrl(trx, id),
  };
}
