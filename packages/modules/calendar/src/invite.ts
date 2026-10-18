// What a booker is sent about their appointment: the time in words, in their own time zone
// and the calendar's, and a calendar invite their mail program adds to their calendar.
//
// The invite is an iCalendar object (RFC 5545) carrying an iTIP method (RFC 5546), sent by
// email as RFC 6047 (iMIP) describes. What each part relies on:
// - VERSION and PRODID once each (RFC 5545 3.6, 3.7.3, 3.7.4); METHOD equal to the
//   Content-Type's method parameter (3.7.2; RFC 6047 2.4), which the mail adapter sets
//   from the same value.
// - METHOD:REQUEST has one ORGANIZER, at least one ATTENDEE, DTSTAMP, DTSTART, UID and a
//   SEQUENCE when above 0 (RFC 5546 3.2.2). METHOD:CANCEL has the UID of the original
//   REQUEST, a SEQUENCE, the attendees and STATUS:CANCELLED (RFC 5546 3.2.5).
// - UID is globally unique: the appointment's id at the CRM's own host (RFC 5545 3.8.4.7),
//   the same for every message about one appointment, so a reschedule replaces the event.
// - SEQUENCE starts at 0 and goes up when the time or status changes (RFC 5545 3.8.7.4,
//   RFC 5546 2.1.4); the database keeps it (migration 0102).
// - Every time is UTC, FORM #2 with a Z (RFC 5545 3.3.5), so no VTIMEZONE is needed
//   (RFC 5546 3.2.2 asks for one only when a time refers to a zone).
// - Text is escaped (3.3.11); lines end in CRLF and fold at 75 octets (3.1).
import { Temporal } from '@js-temporal/polyfill';

export interface InviteParty {
  readonly email: string;
  readonly name: string;
}

export interface AppointmentInvite {
  readonly method: 'REQUEST' | 'CANCEL';
  readonly uid: string;
  readonly sequence: number;
  /** When this invite was made (DTSTAMP). */
  readonly stamp: Date;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly summary: string;
  readonly description: string;
  readonly location: string | null;
  readonly organizer: InviteParty;
  readonly attendee: InviteParty;
}

/** A TEXT value as RFC 5545 3.3.11 writes it. A colon is not escaped. */
export function icsText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll(/\r\n|\r|\n/g, '\\n');
}

/**
 * A name as a quoted parameter value (RFC 5545 3.1: a quoted-string holds no DQUOTE and no
 * control character). Undefined when nothing is left.
 */
function quotedName(name: string): string | undefined {
  const cleaned = name
    .replaceAll('"', '')
    .replaceAll(/\p{Cc}/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? undefined : `"${cleaned}"`;
}

/** One content line, folded so no line is longer than 75 octets, never inside a character. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const character of line) {
    const size = Buffer.byteLength(character);
    // A continuation line starts with a space, which counts toward its 75.
    if (octets + size > 75) {
      parts.push(current);
      current = ' ';
      octets = 1;
    }
    current += character;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n');
}

const utc = (instant: string | Date): string =>
  Temporal.Instant.from(typeof instant === 'string' ? instant : instant.toISOString())
    .toZonedDateTimeISO('UTC')
    .toPlainDateTime()
    .toString({ smallestUnit: 'second' })
    .replaceAll('-', '')
    .replaceAll(':', '')
    .concat('Z');

const mailto = (email: string): string => `mailto:${email}`;

export function appointmentInvite(invite: AppointmentInvite): string {
  const cancel = invite.method === 'CANCEL';
  const organizerName = quotedName(invite.organizer.name);
  const attendeeName = quotedName(invite.attendee.name);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Open CRM//Booking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${invite.method}`,
    'BEGIN:VEVENT',
    `UID:${invite.uid}`,
    `DTSTAMP:${utc(invite.stamp)}`,
    `SEQUENCE:${String(invite.sequence)}`,
    `DTSTART:${utc(invite.startsAt)}`,
    `DTEND:${utc(invite.endsAt)}`,
    `SUMMARY:${icsText(invite.summary)}`,
    `DESCRIPTION:${icsText(invite.description)}`,
    ...(invite.location === null || invite.location.trim() === ''
      ? []
      : [`LOCATION:${icsText(invite.location)}`]),
    `ORGANIZER${organizerName === undefined ? '' : `;CN=${organizerName}`}:${mailto(invite.organizer.email)}`,
    `ATTENDEE${attendeeName === undefined ? '' : `;CN=${attendeeName}`};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:${mailto(invite.attendee.email)}`,
    cancel ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    ...(cancel ? [] : ['TRANSP:OPAQUE']),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

const spaced = (text: string): string => text.replaceAll(/[\u202f\u00a0]/g, ' ');

function moment(instant: string, zone: string): { date: string; time: string } {
  const at = new Date(instant);
  return {
    date: new Intl.DateTimeFormat('en-US', { timeZone: zone, dateStyle: 'full' }).format(at),
    time: spaced(
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeStyle: 'short' }).format(at),
    ),
  };
}

function zoneName(instant: string, zone: string): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' })
      .formatToParts(new Date(instant))
      .find((part) => part.type === 'timeZoneName')?.value ?? zone
  );
}

function span(startsAt: string, endsAt: string, zone: string): string {
  const start = moment(startsAt, zone);
  const end = moment(endsAt, zone);
  const until = start.date === end.date ? end.time : `${end.date}, ${end.time}`;
  return `${start.date}, ${start.time} – ${until} ${zoneName(startsAt, zone)} (${zone})`;
}

/**
 * When the appointment is, in words: in the zone the booker chose, and in the calendar's
 * when that is another. US English, as most clients are in the US.
 */
export function whenText(input: {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly calendarZone: string;
  readonly bookerZone: string | null;
}): string {
  const host = span(input.startsAt, input.endsAt, input.calendarZone);
  if (input.bookerZone === null || input.bookerZone === input.calendarZone) return host;
  return `${span(input.startsAt, input.endsAt, input.bookerZone)}\nFor the host: ${host}`;
}
