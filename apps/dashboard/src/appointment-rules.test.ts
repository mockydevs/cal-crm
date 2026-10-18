import { describe, expect, it } from 'vitest';
import {
  ANY,
  appointmentQueryOf,
  bookingOf,
  instantOfWall,
  moveOf,
  narrowed,
  nextHalfHour,
  NO_CHOICE,
  noAppointmentFilters,
  ordered,
  soonestFirst,
  wallTime,
  type AppointmentDraft,
} from './appointment-rules';

const draft: AppointmentDraft = {
  calendarId: 'cal_tours',
  contactId: 'con_maya',
  start: '2026-10-20T09:00',
  end: '',
  assignee: NO_CHOICE,
  title: '',
  status: 'confirmed',
  location: '',
  notes: '',
  ignoreAvailability: false,
};
const instant = (wall: string): string => new Date(wall).toISOString();

describe('the list question', () => {
  it('asks for the tab, the order and the page size, and nothing that is not chosen', () => {
    expect(appointmentQueryOf(noAppointmentFilters, soonestFirst, 20, undefined)).toEqual({
      view: 'upcoming',
      sort: 'startsAt',
      direction: 'asc',
      limit: 20,
    });
    expect(narrowed(noAppointmentFilters)).toBe(false);
  });

  it('carries each filter, the trimmed search and the cursor', () => {
    const filters = {
      view: 'all' as const,
      status: 'no_show' as const,
      calendar: 'cal_tours',
      user: 'mem_lee',
      q: '  tour ',
    };
    expect(appointmentQueryOf(filters, { sort: 'title', direction: 'desc' }, 50, 'appt_9')).toEqual(
      {
        view: 'all',
        sort: 'title',
        direction: 'desc',
        limit: 50,
        status: 'no_show' as const,
        calendar: 'cal_tours',
        user: 'mem_lee',
        q: 'tour',
        after: 'appt_9',
      },
    );
    expect(narrowed(filters)).toBe(true);
    expect(narrowed({ ...noAppointmentFilters, q: '   ' })).toBe(false);
    expect(narrowed({ ...noAppointmentFilters, status: ANY, user: 'mem_lee' })).toBe(true);
  });

  it('turns a column round when its heading is pressed again', () => {
    expect(ordered(soonestFirst, 'startsAt')).toEqual({ sort: 'startsAt', direction: 'desc' });
    expect(ordered({ sort: 'startsAt', direction: 'desc' }, 'startsAt')).toEqual(soonestFirst);
    expect(ordered({ sort: 'startsAt', direction: 'desc' }, 'title')).toEqual({
      sort: 'title',
      direction: 'asc',
    });
  });
});

describe('wall times', () => {
  it('writes an instant as this machine reads it, to the minute', () => {
    expect(wallTime(new Date(2026, 9, 5, 9, 7, 45))).toBe('2026-10-05T09:07');
  });

  it('starts a new appointment at the next half hour', () => {
    expect(nextHalfHour(new Date(2026, 9, 14, 10, 15))).toBe('2026-10-14T10:30');
    expect(nextHalfHour(new Date(2026, 9, 14, 10, 30))).toBe('2026-10-14T11:00');
    expect(nextHalfHour(new Date(2026, 9, 14, 23, 45))).toBe('2026-10-15T00:00');
  });
});

describe('a booking', () => {
  it('sends only what was filled in, and lets the calendar decide the rest', () => {
    expect(bookingOf(draft, 'req-1')).toEqual({
      body: {
        requestId: 'req-1',
        calendarId: 'cal_tours',
        contactId: 'con_maya',
        startsAt: instant('2026-10-20T09:00'),
        ignoreAvailability: false,
        status: 'confirmed',
        notes: '',
      },
    });
  });

  it('sends the owner, title, place and notes when given', () => {
    expect(
      bookingOf(
        {
          ...draft,
          assignee: 'mem_lee',
          title: '  Venue tour ',
          status: 'booked',
          location: ' Pier 4 ',
          notes: 'Bring the plans.\n',
        },
        'req-2',
      ),
    ).toEqual({
      body: {
        requestId: 'req-2',
        calendarId: 'cal_tours',
        contactId: 'con_maya',
        startsAt: instant('2026-10-20T09:00'),
        ignoreAvailability: false,
        assignee: 'mem_lee',
        title: 'Venue tour',
        status: 'booked',
        location: 'Pier 4',
        notes: 'Bring the plans.\n',
      },
    });
  });

  it('never sends an end unless availability is ignored, and then needs one after the start', () => {
    // An end left in the form is not sent while the calendar decides the length.
    expect(bookingOf({ ...draft, end: '2026-10-20T11:00' }, 'r')).not.toHaveProperty('body.endsAt');
    const overriding = { ...draft, ignoreAvailability: true };
    expect(bookingOf(overriding, 'r')).toEqual({ faults: { endsAt: 'missing' } });
    expect(bookingOf({ ...overriding, end: '2026-10-20T09:00' }, 'r')).toEqual({
      faults: { endsAt: 'ends_before_start' },
    });
    expect(bookingOf({ ...overriding, end: '2026-10-20T10:15' }, 'r')).toMatchObject({
      body: {
        startsAt: instant('2026-10-20T09:00'),
        endsAt: instant('2026-10-20T10:15'),
        ignoreAvailability: true,
      },
    });
  });

  it('says what is missing before anything is sent', () => {
    expect(bookingOf({ ...draft, calendarId: '', contactId: undefined, start: '' }, 'r')).toEqual({
      faults: { calendarId: 'missing', contactId: 'missing', startsAt: 'missing' },
    });
    expect(bookingOf({ ...draft, start: 'nonsense' }, 'r')).toEqual({
      faults: { startsAt: 'no_such_time' },
    });
  });
});

describe('a move', () => {
  it('sends the revision and the new time, and the owner only when one is chosen', () => {
    expect(moveOf(draft, 'a'.repeat(64))).toEqual({
      body: {
        revision: 'a'.repeat(64),
        startsAt: instant('2026-10-20T09:00'),
        ignoreAvailability: false,
      },
    });
    expect(
      moveOf(
        { ...draft, assignee: 'mem_dana', ignoreAvailability: true, end: '2026-10-20T09:45' },
        'b'.repeat(64),
      ),
    ).toEqual({
      body: {
        revision: 'b'.repeat(64),
        startsAt: instant('2026-10-20T09:00'),
        endsAt: instant('2026-10-20T09:45'),
        ignoreAvailability: true,
        assignee: 'mem_dana',
      },
    });
    expect(moveOf({ ...draft, start: '' }, 'c'.repeat(64))).toEqual({
      faults: { startsAt: 'missing' },
    });
  });
});

describe("wall times in the business's zone", () => {
  it('writes and reads them in the zone given, whatever this machine is in', () => {
    const instant = new Date('2026-10-20T13:00:00Z');
    expect(wallTime(instant, 'America/New_York')).toBe('2026-10-20T09:00');
    expect(wallTime(instant, 'Africa/Nairobi')).toBe('2026-10-20T16:00');
    expect(instantOfWall('2026-10-20T09:00', 'America/New_York')).toBe(instant.toISOString());
    expect(nextHalfHour(new Date('2026-10-20T13:05:00Z'), 'America/Los_Angeles')).toBe(
      '2026-10-20T06:30',
    );
  });

  it('refuses a time the clock skips in spring, and one that is no time at all', () => {
    expect(instantOfWall('2026-03-08T02:30', 'America/New_York')).toBeUndefined();
    expect(instantOfWall('2026-03-08T03:30', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
    // The hour shown twice in autumn is its first.
    expect(instantOfWall('2026-11-01T01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    for (const wall of ['2026-02-30T09:00', '2026-10-20T24:00', '2026-10-20', 'nonsense'])
      expect(instantOfWall(wall, 'America/New_York')).toBeUndefined();
  });

  it('books and moves in the zone given', () => {
    const chicago = 'America/Chicago';
    expect(bookingOf(draft, 'r', chicago)).toMatchObject({
      body: { startsAt: '2026-10-20T14:00:00.000Z' },
    });
    expect(moveOf({ ...draft, start: '2026-03-08T02:15' }, 'a'.repeat(64), chicago)).toEqual({
      faults: { startsAt: 'no_such_time' },
    });
  });
});
