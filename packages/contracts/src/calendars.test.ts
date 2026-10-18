import { expect, it } from 'vitest';
import {
  calendarAvailabilityInput,
  calendarHours,
  createCalendarInput,
  calendarSenderChoices,
  listCalendarSenders,
} from './calendars.js';

it('bounds sender choices and keeps private mailbox configuration outside its response', () => {
  const id = 'mbx_01h455vb4pex5vsknk084sn02q';
  const page = {
    items: [{ id, name: 'Bookings', email: 'bookings@example.test' }],
    nextCursor: null,
  };
  expect(calendarSenderChoices.parse(page)).toEqual(page);
  expect(
    calendarSenderChoices.safeParse({
      ...page,
      items: [{ ...page.items[0], smtpHost: 'private.test' }],
    }).success,
  ).toBe(false);
  expect(listCalendarSenders.query.parse({})).toEqual({ limit: 25 });
  for (const query of [{ limit: 51 }, { limit: 0 }, { after: 'con_01h455vb4pex5vsknk084sn02q' }])
    expect(listCalendarSenders.query.safeParse(query).success).toBe(false);
});

it('accepts only an explicit public mailbox sender ID and keeps drafts sender-free by default', () => {
  const draft = {
    name: 'Consultation',
    timezone: 'UTC',
    bookingSlug: 'consultation',
    kind: 'personal',
    members: [],
    weeklyHours: [],
    dateOverrides: [],
  };
  expect(createCalendarInput.parse(draft).confirmationSenderId).toBeNull();
  expect(
    createCalendarInput.safeParse({
      ...draft,
      confirmationSenderId: 'mbx_01h455vb4pex5vsknk084sn02q',
    }).success,
  ).toBe(true);
  for (const confirmationSenderId of [
    'con_01h455vb4pex5vsknk084sn02q',
    'sender@example.test',
    '0198de17-876e-7000-aac7-9bc8ac22900d',
  ])
    expect(createCalendarInput.safeParse({ ...draft, confirmationSenderId }).success).toBe(false);
});

it('refuses year zero and impossible dates before writing PostgreSQL date overrides', () => {
  for (const date of ['0000-01-01', '2026-02-30'])
    expect(
      calendarAvailabilityInput.safeParse({
        members: [],
        weeklyHours: [],
        dateOverrides: [{ date, ranges: [] }],
      }).success,
    ).toBe(false);
});

it('accepts weekly hours and a closed date override while refusing invalid ranges', () => {
  const availability = {
    members: [],
    weeklyHours: [{ weekday: 1, startTime: '09:00', endTime: '17:00' }],
    dateOverrides: [{ date: '2026-12-25', ranges: [] }],
  };
  expect(calendarAvailabilityInput.parse(availability)).toEqual(availability);
  for (const range of [
    { weekday: 1, startTime: '17:00', endTime: '09:00' },
    { weekday: 1, startTime: '09:00', endTime: '09:00' },
    { weekday: 7, startTime: '09:00', endTime: '17:00' },
    { weekday: 1, startTime: '25:00', endTime: '26:00' },
  ]) {
    expect(
      calendarAvailabilityInput.safeParse({ ...availability, weeklyHours: [range] }).success,
    ).toBe(false);
  }
});

it('lets a day end at 24:00, and nothing else reach or pass midnight', () => {
  const empty = { members: [], weeklyHours: [], dateOverrides: [] };
  const untilMidnight = {
    members: [],
    weeklyHours: [
      { weekday: 1, startTime: '00:00', endTime: '24:00' },
      { weekday: 2, startTime: '09:00', endTime: '12:00' },
      { weekday: 2, startTime: '23:59', endTime: '24:00' },
    ],
    dateOverrides: [{ date: '2026-12-31', ranges: [{ startTime: '18:00', endTime: '24:00' }] }],
  };
  expect(calendarAvailabilityInput.parse(untilMidnight)).toEqual(untilMidnight);
  expect(
    calendarHours.parse({ ...untilMidnight.dateOverrides[0], timezone: 'UTC', source: 'override' }),
  ).toMatchObject({ ranges: [{ startTime: '18:00', endTime: '24:00' }] });
  for (const range of [
    // A day cannot start at 24:00, and no time after it exists.
    { startTime: '24:00', endTime: '24:00' },
    { startTime: '23:00', endTime: '24:01' },
    { startTime: '23:00', endTime: '24:30' },
    { startTime: '23:00', endTime: '25:00' },
    { startTime: '23:00', endTime: '24:0' },
    { startTime: '23:00', endTime: ' 24:00' },
  ]) {
    expect(
      calendarAvailabilityInput.safeParse({ ...empty, weeklyHours: [{ weekday: 1, ...range }] })
        .success,
    ).toBe(false);
    expect(
      calendarAvailabilityInput.safeParse({
        ...empty,
        dateOverrides: [{ date: '2026-12-31', ranges: [range] }],
      }).success,
    ).toBe(false);
  }
  // Hours that end at 24:00 still may not overlap the ones before them.
  expect(
    calendarAvailabilityInput.safeParse({
      ...empty,
      weeklyHours: [
        { weekday: 1, startTime: '20:00', endTime: '24:00' },
        { weekday: 1, startTime: '23:00', endTime: '24:00' },
      ],
    }).success,
  ).toBe(false);
});

it('allows inactive drafts but requires bookable members when activating supported kinds', () => {
  const draft = {
    name: 'Consultation',
    timezone: 'Africa/Nairobi',
    bookingSlug: 'consultation',
    kind: 'personal',
    members: [],
    weeklyHours: [],
    dateOverrides: [],
  };
  expect(createCalendarInput.parse(draft).isActive).toBe(false);
  expect(createCalendarInput.safeParse({ ...draft, isActive: true }).success).toBe(false);
  const member = { membershipId: 'mem_01h455vb4pex5vsknk084sn02q', weight: 1 };
  expect(
    createCalendarInput.safeParse({ ...draft, isActive: true, members: [member] }).success,
  ).toBe(true);
  // A type whose booking is not built is saved as a draft and cannot be switched on.
  for (const kind of ['collective', 'class', 'service', 'event']) {
    expect(createCalendarInput.safeParse({ ...draft, kind }).success).toBe(true);
    const active = createCalendarInput.safeParse({
      ...draft,
      kind,
      isActive: true,
      members: [member],
    });
    expect(active.error?.issues.map((issue) => issue.path.join('/'))).toEqual(['isActive']);
  }
  for (const changed of [
    { kind: 'rental' },
    { timezone: 'Moon/Base' },
    { bookingSlug: 'Ｃonsultation' },
    { slotMinutes: 4 },
    { bufferAfterMinutes: 241 },
  ]) {
    expect(createCalendarInput.safeParse({ ...draft, ...changed }).success).toBe(false);
  }
});

it('refuses overlapping hours, repeated overrides and duplicate members', () => {
  const empty = { members: [], weeklyHours: [], dateOverrides: [] };
  const overlapping = [
    { weekday: 1, startTime: '09:00', endTime: '12:00' },
    { weekday: 1, startTime: '11:00', endTime: '17:00' },
  ];
  expect(calendarAvailabilityInput.safeParse({ ...empty, weeklyHours: overlapping }).success).toBe(
    false,
  );
  expect(
    calendarAvailabilityInput.safeParse({
      ...empty,
      dateOverrides: [
        { date: '2026-12-25', ranges: [] },
        { date: '2026-12-25', ranges: [] },
      ],
    }).success,
  ).toBe(false);
  expect(
    calendarAvailabilityInput.safeParse({
      ...empty,
      dateOverrides: [
        {
          date: '2026-12-25',
          ranges: overlapping.map(({ startTime, endTime }) => ({ startTime, endTime })),
        },
      ],
    }).success,
  ).toBe(false);
  const member = { membershipId: 'mem_01h455vb4pex5vsknk084sn02q', weight: 1 };
  expect(calendarAvailabilityInput.safeParse({ ...empty, members: [member] }).success).toBe(true);
  expect(calendarAvailabilityInput.safeParse({ ...empty, members: [member, member] }).success).toBe(
    false,
  );
});
