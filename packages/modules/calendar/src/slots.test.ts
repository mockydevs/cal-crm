import fc from 'fast-check';
import { expect, it } from 'vitest';
import { generateCalendarSlots, chooseWeightedMember } from './slots.js';
import type { UserAvailabilityProfile } from './user-availability.js';

it('balances accepted bookings by weight with stable ties and exact large counts', () => {
  expect(chooseWeightedMember([])).toBeUndefined();
  expect(
    chooseWeightedMember([
      { id: 'busy', weight: 2, assignedCount: 2n },
      { id: 'free', weight: 1, assignedCount: 0n },
    ]),
  ).toBe('free');
  expect(
    chooseWeightedMember([
      { id: 'b', weight: 1, assignedCount: 0n },
      { id: 'a', weight: 3, assignedCount: 0n },
    ]),
  ).toBe('a');
  expect(
    chooseWeightedMember([
      { id: 'a', weight: 1, assignedCount: 9007199254740993n },
      { id: 'b', weight: 1, assignedCount: 9007199254740992n },
    ]),
  ).toBe('b');
  const candidates = [
    { id: 'a', weight: 3, assignedCount: 0n },
    { id: 'b', weight: 1, assignedCount: 0n },
  ];
  for (let booking = 0; booking < 8; booking++) {
    const chosen = chooseWeightedMember(candidates);
    const member = candidates.find((item) => item.id === chosen);
    if (member === undefined) throw new Error('Expected eligible member');
    member.assignedCount++;
  }
  expect(candidates.map((member) => member.assignedCount)).toEqual([6n, 2n]);
});

const cases = [
  {
    name: 'New York spring gap',
    date: '2026-03-08',
    timezone: 'America/New_York',
    start: '01:00',
    end: '04:00',
    starts: [
      '2026-03-08T06:00:00Z',
      '2026-03-08T06:30:00Z',
      '2026-03-08T07:00:00Z',
      '2026-03-08T07:30:00Z',
    ],
  },
  {
    name: 'New York repeated hour',
    date: '2026-11-01',
    timezone: 'America/New_York',
    start: '00:30',
    end: '02:30',
    starts: [
      '2026-11-01T04:30:00Z',
      '2026-11-01T05:00:00Z',
      '2026-11-01T05:30:00Z',
      '2026-11-01T06:00:00Z',
      '2026-11-01T06:30:00Z',
      '2026-11-01T07:00:00Z',
    ],
  },
  {
    name: 'London spring gap',
    date: '2026-03-29',
    timezone: 'Europe/London',
    start: '00:00',
    end: '03:00',
    starts: [
      '2026-03-29T00:00:00Z',
      '2026-03-29T00:30:00Z',
      '2026-03-29T01:00:00Z',
      '2026-03-29T01:30:00Z',
    ],
  },
  {
    name: 'London repeated hour',
    date: '2026-10-25',
    timezone: 'Europe/London',
    start: '00:30',
    end: '02:30',
    starts: [
      '2026-10-24T23:30:00Z',
      '2026-10-25T00:00:00Z',
      '2026-10-25T00:30:00Z',
      '2026-10-25T01:00:00Z',
      '2026-10-25T01:30:00Z',
      '2026-10-25T02:00:00Z',
    ],
  },
  {
    name: 'Nairobi has no DST transition',
    date: '2026-03-08',
    timezone: 'Africa/Nairobi',
    start: '01:00',
    end: '04:00',
    starts: [
      '2026-03-07T22:00:00Z',
      '2026-03-07T22:30:00Z',
      '2026-03-07T23:00:00Z',
      '2026-03-07T23:30:00Z',
      '2026-03-08T00:00:00Z',
      '2026-03-08T00:30:00Z',
    ],
  },
  {
    name: 'Lord Howe half-hour spring gap',
    date: '2026-10-04',
    timezone: 'Australia/Lord_Howe',
    start: '01:30',
    end: '03:00',
    starts: ['2026-10-03T15:00:00Z', '2026-10-03T15:30:00Z'],
  },
  {
    name: 'Lord Howe half-hour repeated interval',
    date: '2026-04-05',
    timezone: 'Australia/Lord_Howe',
    start: '01:00',
    end: '03:00',
    starts: [
      '2026-04-04T14:00:00Z',
      '2026-04-04T14:30:00Z',
      '2026-04-04T15:00:00Z',
      '2026-04-04T15:30:00Z',
      '2026-04-04T16:00:00Z',
    ],
  },
] as const;
function rules(
  timezone: string,
  date: string,
  ranges: readonly { startTime: string; endTime: string }[],
  slotMinutes = 30,
) {
  return {
    timezone,
    slotMinutes,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    maxDaysAhead: 730,
    weeklyHours: [],
    dateOverrides: [{ date, ranges: [...ranges] }],
    members: [{ id: 'host', weight: 1 }],
  };
}
for (const fixture of cases)
  it(fixture.name, () => {
    const slots = generateCalendarSlots(
      rules(fixture.timezone, fixture.date, [{ startTime: fixture.start, endTime: fixture.end }]),
      fixture.date,
      '2026-01-01T00:00:00Z',
      new Map([['host', []]]),
    );
    expect(slots.map((slot) => slot.startsAt)).toEqual(fixture.starts);
    expect(
      slots.every((slot) => Date.parse(slot.endsAt) - Date.parse(slot.startsAt) === 1800000),
    ).toBe(true);
  });
it('rejects a fold interval whose endpoints fit but whose interior crosses closed hours', () => {
  expect(
    generateCalendarSlots(
      rules('America/New_York', '2026-11-01', [{ startTime: '01:15', endTime: '01:45' }], 60),
      '2026-11-01',
      '2026-01-01T00:00:00Z',
      new Map([['host', []]]),
    ),
  ).toEqual([]);
});
it('merges adjacent hours without crossing a genuine closed interval', () => {
  const adjacent = rules(
    'Africa/Nairobi',
    '2026-03-08',
    [
      { startTime: '11:00', endTime: '12:00' },
      { startTime: '12:00', endTime: '13:00' },
    ],
    90,
  );
  expect(
    generateCalendarSlots(
      adjacent,
      '2026-03-08',
      '2026-01-01T00:00:00Z',
      new Map([['host', []]]),
    ).map((slot) => slot.startsAt),
  ).toEqual(['2026-03-08T08:00:00Z']);
  const separated = {
    ...adjacent,
    dateOverrides: [
      {
        date: '2026-03-08',
        ranges: [
          { startTime: '11:00', endTime: '12:00' },
          { startTime: '12:30', endTime: '13:30' },
        ],
      },
    ],
  };
  expect(
    generateCalendarSlots(separated, '2026-03-08', '2026-01-01T00:00:00Z', new Map([['host', []]])),
  ).toEqual([]);
});
it('filters physical before-buffer occupancy without omitting the later earlier-clock fold slot', () => {
  const config = {
    ...rules('America/New_York', '2026-11-01', [{ startTime: '00:30', endTime: '02:30' }]),
    bufferBeforeMinutes: 60,
  };
  // A buffer may run before opening time, so a free host keeps every fold slot.
  expect(
    generateCalendarSlots(
      config,
      '2026-11-01',
      '2026-01-01T00:00:00Z',
      new Map([['host', []]]),
    ).map((slot) => slot.startsAt),
  ).toEqual(cases[1].starts);
  // Busy until opening (23:30 to 00:30 EDT): the hour-long buffer must not touch it, so the
  // physical hour filters the grid, and 01:00 EST (06:00Z) after the fold stays offered.
  expect(
    generateCalendarSlots(
      config,
      '2026-11-01',
      '2026-01-01T00:00:00Z',
      new Map([['host', [{ startsAt: '2026-11-01T03:30:00Z', endsAt: '2026-11-01T04:30:00Z' }]]]),
    ).map((slot) => slot.startsAt),
  ).toEqual([
    '2026-11-01T05:30:00Z',
    '2026-11-01T06:00:00Z',
    '2026-11-01T06:30:00Z',
    '2026-11-01T07:00:00Z',
  ]);
});
it('lets buffers run outside the hours, as Calendly does, but never into busy time', () => {
  const config = {
    ...rules('UTC', '2026-03-09', [{ startTime: '09:00', endTime: '12:00' }]),
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 15,
  };
  const starts = (busy: readonly { startsAt: string; endsAt: string }[]) =>
    startsOf(
      generateCalendarSlots(
        config,
        '2026-03-09',
        '2026-03-01T00:00:00Z',
        new Map([['host', busy]]),
      ),
    );
  // The first and the last slot of the day stay bookable.
  expect(starts([])).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  // Busy time from another calendar just outside the hours still keeps the 15-minute gap.
  expect(
    starts([
      { startsAt: '2026-03-09T08:00:00Z', endsAt: '2026-03-09T08:50:00Z' },
      { startsAt: '2026-03-09T12:10:00Z', endsAt: '2026-03-09T13:00:00Z' },
    ]),
  ).toEqual(['09:30', '10:00', '10:30', '11:00']);
  // Exactly the buffer apart is enough (half-open intervals).
  expect(
    starts([
      { startsAt: '2026-03-09T08:00:00Z', endsAt: '2026-03-09T08:45:00Z' },
      { startsAt: '2026-03-09T12:15:00Z', endsAt: '2026-03-09T13:00:00Z' },
    ]),
  ).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
});
it('uses exact minimum notice across a spring gap, including its equality boundary', () => {
  const config = {
    ...rules('America/New_York', '2026-03-08', [{ startTime: '01:00', endTime: '04:00' }]),
    minNoticeMinutes: 30,
  };
  expect(
    generateCalendarSlots(
      config,
      '2026-03-08',
      '2026-03-08T06:30:00Z',
      new Map([['host', []]]),
    ).map((slot) => slot.startsAt),
  ).toEqual(['2026-03-08T07:00:00Z', '2026-03-08T07:30:00Z']);
});
it('uses the calendar-local date for the inclusive booking horizon', () => {
  const config = {
    ...rules('Africa/Nairobi', '2026-03-09', [{ startTime: '12:00', endTime: '13:00' }]),
    maxDaysAhead: 1,
  };
  expect(
    generateCalendarSlots(
      config,
      '2026-03-09',
      '2026-03-07T22:00:00Z',
      new Map([['host', []]]),
    ).map((slot) => slot.startsAt),
  ).toEqual(['2026-03-09T09:00:00Z', '2026-03-09T09:30:00Z']);
  expect(
    generateCalendarSlots(
      {
        ...config,
        dateOverrides: [{ date: '2026-03-10', ranges: [{ startTime: '12:00', endTime: '13:00' }] }],
      },
      '2026-03-10',
      '2026-03-07T22:00:00Z',
      new Map([['host', []]]),
    ),
  ).toEqual([]);
});

it('preserves fixed-offset occupancy, notice and ordered unique starts across generated Nairobi rules', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 5, max: 120 }),
      fc.integer({ min: 0, max: 60 }),
      fc.integer({ min: 0, max: 60 }),
      fc.integer({ min: 0, max: 120 }),
      (duration, before, after, notice) => {
        const date = '2026-03-08';
        const config = {
          timezone: 'Africa/Nairobi',
          slotMinutes: duration,
          bufferBeforeMinutes: before,
          bufferAfterMinutes: after,
          minNoticeMinutes: notice,
          maxDaysAhead: 60,
          weeklyHours: [],
          dateOverrides: [{ date, ranges: [{ startTime: '09:00', endTime: '17:00' }] }],
          members: [{ id: 'host', weight: 1 }],
        };
        const opens = Date.parse('2026-03-08T06:00:00Z');
        const closes = Date.parse('2026-03-08T14:00:00Z');
        // With a free host, buffers may run outside the hours, so only the meeting and the
        // notice decide; buffers no longer cost the first and last slot.
        const free = generateCalendarSlots(
          config,
          date,
          '2026-03-08T06:00:00Z',
          new Map([['host', []]]),
        );
        const firstFree = Math.ceil(notice / duration);
        const lastFree = Math.floor((480 - duration) / duration);
        expect(free).toHaveLength(Math.max(0, lastFree - firstFree + 1));
        // Busy from other calendars right up to opening and from closing: the buffers must
        // keep their gap from it, which gives back the whole occupied interval inside hours.
        const fenced = generateCalendarSlots(
          config,
          date,
          '2026-03-08T06:00:00Z',
          new Map([
            [
              'host',
              [
                { startsAt: '2026-03-08T04:00:00Z', endsAt: '2026-03-08T06:00:00Z' },
                { startsAt: '2026-03-08T14:00:00Z', endsAt: '2026-03-08T16:00:00Z' },
              ],
            ],
          ]),
        );
        const firstIndex = Math.ceil(Math.max(before, notice) / duration);
        const lastIndex = Math.floor((480 - duration - after) / duration);
        expect(fenced).toHaveLength(Math.max(0, lastIndex - firstIndex + 1));
        for (const slots of [free, fenced]) {
          const starts = slots.map((slot) => Date.parse(slot.startsAt));
          expect(starts).toEqual([...new Set(starts)].sort((a, b) => a - b));
          for (const slot of slots) {
            const start = Date.parse(slot.startsAt),
              end = Date.parse(slot.endsAt);
            expect(end - start).toBe(duration * 60000);
            expect(start).toBeGreaterThanOrEqual(opens);
            expect(end).toBeLessThanOrEqual(closes);
            expect(start).toBeGreaterThanOrEqual(opens + notice * 60000);
            expect((start - opens) % (duration * 60000)).toBe(0);
            expect(slot.availableMemberIds).toEqual(['host']);
          }
        }
        for (const slot of fenced) {
          expect(Date.parse(slot.startsAt) - before * 60000).toBeGreaterThanOrEqual(opens);
          expect(Date.parse(slot.endsAt) + after * 60000).toBeLessThanOrEqual(closes);
        }
      },
    ),
    { numRuns: 200, seed: 144 },
  );
  // 200 generated days are about two seconds of pure computation alone. On CI's two-core
  // runner, beside other packages' suites, the same work passed 30 seconds (run 38058546672).
}, 120_000);
it('keeps occupied endpoints half-open, excludes overlapping members and offers another free host', () => {
  const config = {
    timezone: 'UTC',
    slotMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    maxDaysAhead: 60,
    weeklyHours: [],
    dateOverrides: [{ date: '2026-03-08', ranges: [{ startTime: '08:30', endTime: '10:30' }] }],
    members: [
      { id: 'busy-host', weight: 1 },
      { id: 'free-host', weight: 1 },
    ],
  };
  const slots = generateCalendarSlots(
    config,
    '2026-03-08',
    '2026-03-08T00:00:00Z',
    new Map([
      ['busy-host', [{ startsAt: '2026-03-08T09:00:00Z', endsAt: '2026-03-08T10:00:00Z' }]],
      ['free-host', []],
    ]),
  );
  expect(slots.map((slot) => [slot.startsAt, slot.availableMemberIds])).toEqual([
    ['2026-03-08T08:30:00Z', ['busy-host', 'free-host']],
    ['2026-03-08T09:00:00Z', ['free-host']],
    ['2026-03-08T09:30:00Z', ['free-host']],
    ['2026-03-08T10:00:00Z', ['busy-host', 'free-host']],
  ]);
});
it('uses weekly hours without an override, while closed overrides and missing hosts block slots', () => {
  const config = {
    timezone: 'UTC',
    slotMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 0,
    maxDaysAhead: 60,
    weeklyHours: [{ weekday: 0, startTime: '09:00', endTime: '10:00' }],
    dateOverrides: [],
    members: [{ id: 'host', weight: 1 }],
  };
  expect(
    generateCalendarSlots(config, '2026-03-08', '2026-03-01T00:00:00Z', new Map()).map(
      (slot) => slot.startsAt,
    ),
  ).toEqual(['2026-03-08T09:00:00Z', '2026-03-08T09:30:00Z']);
  expect(
    generateCalendarSlots(
      { ...config, dateOverrides: [{ date: '2026-03-08', ranges: [] }] },
      '2026-03-08',
      '2026-03-01T00:00:00Z',
      new Map(),
    ),
  ).toEqual([]);
  expect(
    generateCalendarSlots(
      { ...config, members: [] },
      '2026-03-08',
      '2026-03-01T00:00:00Z',
      new Map(),
    ),
  ).toEqual([]);
  expect(generateCalendarSlots(config, '2026-03-08', '2026-03-09T00:00:00Z', new Map())).toEqual(
    [],
  );
});
it('keeps every meeting minute inside opening hours across generated DST rules using Intl as an independent oracle', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...cases),
      fc.constantFrom(5, 10, 15, 20, 30, 45, 60),
      fc.integer({ min: 0, max: 30 }),
      fc.integer({ min: 0, max: 30 }),
      (fixture, duration, before, after) => {
        const config = {
          ...rules(
            fixture.timezone,
            fixture.date,
            [{ startTime: '00:00', endTime: '04:00' }],
            duration,
          ),
          bufferBeforeMinutes: before,
          bufferAfterMinutes: after,
        };
        const slots = generateCalendarSlots(
          config,
          fixture.date,
          '2026-01-01T00:00:00Z',
          new Map([['host', []]]),
        );
        const formatter = new Intl.DateTimeFormat('en-GB', {
          timeZone: fixture.timezone,
          calendar: 'iso8601',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        });
        expect(slots.length).toBeGreaterThan(0);
        // Buffers may run outside the hours, so for a free host they change nothing.
        expect(slots).toEqual(
          generateCalendarSlots(
            { ...config, bufferBeforeMinutes: 0, bufferAfterMinutes: 0 },
            fixture.date,
            '2026-01-01T00:00:00Z',
            new Map([['host', []]]),
          ),
        );
        for (const slot of slots) {
          const start = Date.parse(slot.startsAt),
            end = Date.parse(slot.endsAt);
          expect(end - start).toBe(duration * 60000);
          // The meeting itself, not its buffers, must be inside the hours.
          const samples = [end - 1];
          for (let instant = start; instant < end; instant += 60000) samples.push(instant);
          for (const sample of samples) {
            const parts = new Map(
              formatter.formatToParts(new Date(sample)).map((part) => [part.type, part.value]),
            );
            const part = (type: Intl.DateTimeFormatPartTypes): string => {
              const value = parts.get(type);
              if (value === undefined) throw new Error(`Missing date part: ${type}`);
              return value;
            };
            expect(`${part('year')}-${part('month')}-${part('day')}`).toBe(fixture.date);
            const time = `${part('hour')}:${part('minute')}`;
            expect(time >= '00:00' && time < '04:00').toBe(true);
          }
        }
      },
    ),
    { numRuns: 40, seed: 145 },
  );
  // Pure computation, like the test above: under half a second alone, over five on CI.
}, 60_000);

const scheduleRules = {
  timezone: 'UTC',
  slotMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxDaysAhead: 60,
  weeklyHours: [],
  // Monday 9 March 2026, 08:00 to 12:00 UTC.
  dateOverrides: [{ date: '2026-03-09', ranges: [{ startTime: '08:00', endTime: '12:00' }] }],
};
const nairobiAfternoon = {
  timezone: 'Africa/Nairobi',
  inheritCalendarHours: false,
  // 12:00 to 14:00 in Nairobi is 09:00 to 11:00 UTC.
  weeklyHours: [{ weekday: 1, startMinute: 720, endMinute: 840 }],
  dateOverrides: [],
};
const startsOf = (slots: readonly { startsAt: string }[]) =>
  slots.map((slot) => slot.startsAt.slice(11, 16));

it("offers a member only inside their own schedule, in their own time zone, and never past the calendar's hours", () => {
  const schedules = new Map<string, UserAvailabilityProfile>([
    ['nairobi', nairobiAfternoon],
    [
      'away',
      {
        timezone: 'UTC',
        inheritCalendarHours: true,
        weeklyHours: [],
        dateOverrides: [],
      },
    ],
    [
      'early',
      {
        timezone: 'UTC',
        inheritCalendarHours: false,
        weeklyHours: [{ weekday: 1, startMinute: 0, endMinute: 510 }],
        dateOverrides: [],
      },
    ],
  ]);
  const slots = generateCalendarSlots(
    {
      ...scheduleRules,
      members: ['nairobi', 'away', 'early', 'unset'].map((id) => ({ id, weight: 1 })),
    },
    '2026-03-09',
    '2026-03-01T00:00:00Z',
    // Blocked time is busy time.
    new Map([['away', [{ startsAt: '2026-03-09T10:15:00Z', endsAt: '2026-03-09T10:30:00Z' }]]]),
    schedules,
  );
  expect(slots.map((slot) => [slot.startsAt.slice(11, 16), slot.availableMemberIds])).toEqual([
    // The calendar opens at 08:00, so the early member's hours before that offer nothing.
    ['08:00', ['away', 'early', 'unset']],
    ['08:30', ['away', 'unset']],
    ['09:00', ['away', 'nairobi', 'unset']],
    ['09:30', ['away', 'nairobi', 'unset']],
    ['10:00', ['nairobi', 'unset']],
    ['10:30', ['away', 'nairobi', 'unset']],
    ['11:00', ['away', 'unset']],
    ['11:30', ['away', 'unset']],
  ]);
});

it("drops a slot nobody can take; buffers may leave the member's hours but never touch blocked time", () => {
  const rules = { ...scheduleRules, members: [{ id: 'nairobi', weight: 1 }] };
  const schedules = new Map([['nairobi', nairobiAfternoon]]);
  const now = '2026-03-01T00:00:00Z';
  const buffered = { ...rules, bufferBeforeMinutes: 30, bufferAfterMinutes: 30 };
  expect(startsOf(generateCalendarSlots(rules, '2026-03-09', now, new Map(), schedules))).toEqual([
    '09:00',
    '09:30',
    '10:00',
    '10:30',
  ]);
  // Like the calendar's hours, the member's hours bound the meeting, not its buffers.
  expect(
    startsOf(generateCalendarSlots(buffered, '2026-03-09', now, new Map(), schedules)),
  ).toEqual(['09:00', '09:30', '10:00', '10:30']);
  // Blocked time is busy time, so the buffers keep their gap from it on both sides.
  expect(
    startsOf(
      generateCalendarSlots(
        buffered,
        '2026-03-09',
        now,
        new Map([
          [
            'nairobi',
            [
              { startsAt: '2026-03-09T08:30:00Z', endsAt: '2026-03-09T09:00:00Z' },
              { startsAt: '2026-03-09T11:00:00Z', endsAt: '2026-03-09T11:30:00Z' },
            ],
          ],
        ]),
        schedules,
      ),
    ),
  ).toEqual(['09:30', '10:00']);
  expect(
    generateCalendarSlots(
      rules,
      '2026-03-09',
      now,
      new Map(),
      new Map([['nairobi', { ...nairobiAfternoon, weeklyHours: [] }]]),
    ),
  ).toEqual([]);
  // Busy time and the schedule both apply: either one takes the slot away.
  expect(
    startsOf(
      generateCalendarSlots(
        rules,
        '2026-03-09',
        now,
        new Map([
          ['nairobi', [{ startsAt: '2026-03-09T09:30:00Z', endsAt: '2026-03-09T10:30:00Z' }]],
        ]),
        schedules,
      ),
    ),
  ).toEqual(['09:00', '10:30']);
});

it("applies a member's date override on their own local date, even while they follow calendar hours", () => {
  // 10:00 UTC on 9 March is midnight on 10 March in Kiritimati (UTC+14).
  const kiritimati = {
    timezone: 'Pacific/Kiritimati',
    inheritCalendarHours: true,
    weeklyHours: [],
    dateOverrides: [{ date: '2026-03-10', ranges: [] }],
    absences: [],
  };
  const rules = { ...scheduleRules, members: [{ id: 'host', weight: 1 }] };
  expect(
    startsOf(
      generateCalendarSlots(
        rules,
        '2026-03-09',
        '2026-03-01T00:00:00Z',
        new Map(),
        new Map([['host', kiritimati]]),
      ),
    ),
  ).toEqual(['08:00', '08:30', '09:00', '09:30']);
  expect(
    startsOf(
      generateCalendarSlots(
        rules,
        '2026-03-09',
        '2026-03-01T00:00:00Z',
        new Map(),
        new Map([
          [
            'host',
            {
              ...kiritimati,
              dateOverrides: [{ date: '2026-03-10', ranges: [{ startMinute: 0, endMinute: 60 }] }],
            },
          ],
        ]),
      ),
    ),
  ).toEqual(['08:00', '08:30', '09:00', '09:30', '10:00', '10:30']);
});

it('offers a start time only while it has taken fewer bookings than the calendar allows', () => {
  const config = {
    ...rules('UTC', '2026-03-08', [{ startTime: '09:00', endTime: '10:00' }]),
    members: [
      { id: 'one', weight: 1 },
      { id: 'two', weight: 1 },
    ],
  };
  const free = new Map([
    ['one', []],
    ['two', []],
  ]);
  const starts = (max: number, taken: Record<string, number>) =>
    generateCalendarSlots(
      { ...config, slotLimit: { max, taken: new Map(Object.entries(taken)) } },
      '2026-03-08',
      '2026-03-08T00:00:00Z',
      free,
    ).map((slot) => slot.startsAt);
  expect(starts(1, {})).toEqual(['2026-03-08T09:00:00Z', '2026-03-08T09:30:00Z']);
  expect(starts(1, { '2026-03-08T09:00:00Z': 1 })).toEqual(['2026-03-08T09:30:00Z']);
  expect(starts(2, { '2026-03-08T09:00:00Z': 1 })).toEqual([
    '2026-03-08T09:00:00Z',
    '2026-03-08T09:30:00Z',
  ]);
  expect(starts(2, { '2026-03-08T09:00:00Z': 2, '2026-03-08T09:30:00Z': 3 })).toEqual([]);
});
