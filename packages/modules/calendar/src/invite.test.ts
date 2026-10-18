import { expect, it } from 'vitest';

import { appointmentInvite, foldLine, icsText, whenText } from './invite.js';

const base = {
  method: 'REQUEST' as const,
  uid: '019a0000-0000-7000-8000-000000000001@crm.example.test',
  sequence: 0,
  stamp: new Date('2026-10-14T18:00:00.000Z'),
  startsAt: '2026-11-03T15:00:00.000Z',
  endsAt: '2026-11-03T16:00:00.000Z',
  summary: 'Consultation, with Maya; and "friends"',
  description: 'Manage this appointment: https://crm.example.test/appointments/manage/abc',
  location: null,
  organizer: { email: 'bookings@harbor.example', name: 'Harbor Lights' },
  attendee: { email: 'maya@example.test', name: 'Maya Lee' },
};
const lines = (text: string) => text.split('\r\n');
/** The content lines as they were before folding. */
const unfolded = (text: string) => lines(text.replaceAll('\r\n ', ''));

it('writes a METHOD:REQUEST invite with the parts RFC 5546 3.2.2 requires, in UTC', () => {
  const ics = appointmentInvite(base);
  expect(ics.endsWith('\r\n')).toBe(true);
  expect(ics.includes('\n') && !ics.replaceAll('\r\n', '').includes('\n')).toBe(true);
  expect(lines(ics)).toEqual([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Open CRM//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:019a0000-0000-7000-8000-000000000001@crm.example.test',
    'DTSTAMP:20261014T180000Z',
    'SEQUENCE:0',
    'DTSTART:20261103T150000Z',
    'DTEND:20261103T160000Z',
    'SUMMARY:Consultation\\, with Maya\\; and "friends"',
    'DESCRIPTION:Manage this appointment: https://crm.example.test/appointments/',
    ' manage/abc',
    'ORGANIZER;CN="Harbor Lights":mailto:bookings@harbor.example',
    'ATTENDEE;CN="Maya Lee";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:ma',
    ' ilto:maya@example.test',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ]);
});

it('writes a CANCEL with the same UID, a higher SEQUENCE and STATUS:CANCELLED (RFC 5546 3.2.5)', () => {
  const ics = appointmentInvite({ ...base, method: 'CANCEL', sequence: 2, location: 'Room 1' });
  expect(lines(ics)).toContain('METHOD:CANCEL');
  expect(lines(ics)).toContain('UID:019a0000-0000-7000-8000-000000000001@crm.example.test');
  expect(lines(ics)).toContain('SEQUENCE:2');
  expect(lines(ics)).toContain('STATUS:CANCELLED');
  expect(lines(ics)).toContain('LOCATION:Room 1');
  expect(lines(ics)).not.toContain('TRANSP:OPAQUE');
});

it('escapes text as RFC 5545 3.3.11 asks, and keeps names out of the parameter syntax', () => {
  expect(icsText('a\\b;c,d\ne\r\nf:g')).toBe('a\\\\b\\;c\\,d\\ne\\nf:g');
  const ics = appointmentInvite({
    ...base,
    organizer: { email: 'b@x.example', name: 'Bad "name";\nX-EVIL:1' },
    attendee: { email: 'm@x.example', name: '' },
  });
  expect(unfolded(ics)).toContain('ORGANIZER;CN="Bad name; X-EVIL:1":mailto:b@x.example');
  expect(lines(ics).some((line) => line.startsWith('X-EVIL'))).toBe(false);
  expect(unfolded(ics)).toContain(
    'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:m@x.example',
  );
});

it('folds a line at 75 octets without splitting a character (RFC 5545 3.1)', () => {
  expect(foldLine('x'.repeat(75))).toBe('x'.repeat(75));
  expect(foldLine('x'.repeat(76))).toBe(`${'x'.repeat(75)}\r\n x`);
  const folded = foldLine(`SUMMARY:${'é'.repeat(80)}`);
  for (const line of folded.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  expect(folded.replaceAll('\r\n ', '')).toBe(`SUMMARY:${'é'.repeat(80)}`);
  const emoji = foldLine(`X:${'😀'.repeat(30)}`);
  expect(emoji.replaceAll('\r\n ', '')).toBe(`X:${'😀'.repeat(30)}`);
  expect(emoji).not.toContain('�');
});

it('says when in the booker’s zone and the calendar’s, by name, never as UTC text', () => {
  const text = whenText({
    startsAt: base.startsAt,
    endsAt: base.endsAt,
    calendarZone: 'America/New_York',
    bookerZone: 'America/Los_Angeles',
  });
  expect(text).toBe(
    'Tuesday, November 3, 2026, 7:00 AM – 8:00 AM Pacific Standard Time (America/Los_Angeles)\n' +
      'For the host: Tuesday, November 3, 2026, 10:00 AM – 11:00 AM Eastern Standard Time (America/New_York)',
  );
  expect(text).not.toContain('Z');
  // One zone for both: said once.
  expect(
    whenText({
      startsAt: base.startsAt,
      endsAt: base.endsAt,
      calendarZone: 'America/New_York',
      bookerZone: null,
    }),
  ).toBe('Tuesday, November 3, 2026, 10:00 AM – 11:00 AM Eastern Standard Time (America/New_York)');
  // A meeting over midnight says both dates.
  expect(
    whenText({
      startsAt: '2026-11-04T04:30:00.000Z',
      endsAt: '2026-11-04T05:30:00.000Z',
      calendarZone: 'America/New_York',
      bookerZone: 'America/New_York',
    }),
  ).toBe(
    'Tuesday, November 3, 2026, 11:30 PM – Wednesday, November 4, 2026, 12:30 AM Eastern Standard Time (America/New_York)',
  );
});
