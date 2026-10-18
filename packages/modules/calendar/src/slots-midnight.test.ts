// Hours that reach midnight. A day's range may end at 24:00, the instant the next local
// date starts, so the last slot of the day can be offered; and a meeting may cross midnight
// only into hours that open at 00:00 on the next date (its buffers may run into closed
// time).
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { generateCalendarSlots } from './slots.js';

interface Day {
  readonly date: string;
  readonly ranges: readonly { readonly startTime: string; readonly endTime: string }[];
}
const rules = (
  timezone: string,
  days: readonly Day[],
  change: { slotMinutes?: number; bufferBeforeMinutes?: number; bufferAfterMinutes?: number } = {},
) => ({
  timezone,
  slotMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxDaysAhead: 730,
  weeklyHours: [] as { weekday: number; startTime: string; endTime: string }[],
  dateOverrides: days.map((day) => ({ date: day.date, ranges: [...day.ranges] })),
  members: [{ id: 'host', weight: 1 }],
  ...change,
});
const generated = (config: ReturnType<typeof rules>, date: string) =>
  generateCalendarSlots(config, date, '2026-01-01T00:00:00Z', new Map([['host', []]]));
const startsOf = (slots: readonly { startsAt: string }[]) =>
  slots.map((slot) => slot.startsAt.slice(11, 16));
const tonight: Day = { date: '2026-03-08', ranges: [{ startTime: '22:00', endTime: '24:00' }] };
const tomorrowFrom = (startTime: string): Day => ({
  date: '2026-03-09',
  ranges: [{ startTime, endTime: '02:00' }],
});

it('offers the last slot of a day whose hours end at 24:00', () => {
  const slots = generated(rules('UTC', [tonight]), '2026-03-08');
  expect(slots.map((slot) => slot.startsAt)).toEqual([
    '2026-03-08T22:00:00Z',
    '2026-03-08T22:30:00Z',
    '2026-03-08T23:00:00Z',
    '2026-03-08T23:30:00Z',
  ]);
  expect(slots.at(-1)?.endsAt).toBe('2026-03-09T00:00:00Z');
  // The same hours written as 23:59 lose it: that is what the contract used to force.
  const short = { date: '2026-03-08', ranges: [{ startTime: '22:00', endTime: '23:59' }] };
  expect(startsOf(generated(rules('UTC', [short]), '2026-03-08'))).toEqual([
    '22:00',
    '22:30',
    '23:00',
  ]);
});

it('joins a range that ends at 24:00 to the one before it', () => {
  const split = {
    date: '2026-03-08',
    ranges: [
      { startTime: '22:00', endTime: '23:00' },
      { startTime: '23:00', endTime: '24:00' },
    ],
  };
  expect(startsOf(generated(rules('UTC', [split], { slotMinutes: 90 }), '2026-03-08'))).toEqual([
    '22:00',
  ]);
});

it('counts a whole day of 00:00 to 24:00 as 23, 24 or 25 hours across a clock change', () => {
  for (const [date, hours] of [
    ['2026-03-07', 24],
    ['2026-03-08', 23],
    ['2026-11-01', 25],
  ] as const) {
    const wholeDay = { date, ranges: [{ startTime: '00:00', endTime: '24:00' }] };
    const slots = generated(rules('America/New_York', [wholeDay]), date);
    expect(slots).toHaveLength(hours * 2);
    const starts = slots.map((slot) => Date.parse(slot.startsAt));
    // Every half hour of the local day, once, with no gap, from its first instant to its last.
    const steps = starts.slice(1).map((start, index) => start - (starts[index] ?? 0));
    expect(new Set(steps)).toEqual(new Set([1_800_000]));
    expect((Date.parse(slots.at(-1)?.endsAt ?? '') - (starts[0] ?? 0)) / 3_600_000).toBe(hours);
  }
});

it('lets a meeting cross midnight only into hours that open at 00:00 the next day', () => {
  // A buffer may run into closed time. The buffer after the 23:30 slot runs to 00:15 while
  // tomorrow is closed, and the slot is still offered.
  expect(
    startsOf(generated(rules('UTC', [tonight], { bufferAfterMinutes: 15 }), '2026-03-08')),
  ).toEqual(['22:00', '22:30', '23:00', '23:30']);
  // The meeting itself may not: a 45-minute meeting at 23:30 runs to 00:15.
  expect(startsOf(generated(rules('UTC', [tonight], { slotMinutes: 45 }), '2026-03-08'))).toEqual([
    '22:00',
    '22:45',
  ]);
  expect(
    startsOf(
      generated(rules('UTC', [tonight, tomorrowFrom('00:00')], { slotMinutes: 45 }), '2026-03-08'),
    ),
  ).toEqual(['22:00', '22:45', '23:30']);
  // Tomorrow opens at 00:30: a real gap after midnight stays closed to the meeting.
  expect(
    startsOf(
      generated(rules('UTC', [tonight, tomorrowFrom('00:30')], { slotMinutes: 45 }), '2026-03-08'),
    ),
  ).toEqual(['22:00', '22:45']);
  // Tonight closes at 23:59, not 24:00. The buffer before tomorrow's first slot reaches
  // into that closed minute, which no longer matters; with 24:00 it is the same.
  const shortTonight = { date: '2026-03-08', ranges: [{ startTime: '22:00', endTime: '23:59' }] };
  for (const night of [shortTonight, tonight])
    expect(
      startsOf(
        generated(
          rules('UTC', [night, tomorrowFrom('00:00')], { bufferBeforeMinutes: 15 }),
          '2026-03-09',
        ),
      ),
    ).toEqual(['00:00', '00:30', '01:00', '01:30']);
  // A slot longer than what is left of tonight runs on into tomorrow's hours.
  const late = { date: '2026-03-08', ranges: [{ startTime: '22:30', endTime: '24:00' }] };
  expect(
    startsOf(
      generated(rules('UTC', [late, tomorrowFrom('00:00')], { slotMinutes: 60 }), '2026-03-08'),
    ),
  ).toEqual(['22:30', '23:30']);
  expect(startsOf(generated(rules('UTC', [late], { slotMinutes: 60 }), '2026-03-08'))).toEqual([
    '22:30',
  ]);
});

it('reads the next day from weekly hours, and from an override that closes it', () => {
  // 8 March 2026 is a Sunday (weekday 0); Monday is weekday 1. The 45-minute meeting at
  // 23:45 runs to 00:30 on Monday. (A buffer after would no longer need Monday's hours.)
  const weekly = {
    ...rules('UTC', [], { slotMinutes: 45 }),
    weeklyHours: [
      { weekday: 0, startTime: '23:00', endTime: '24:00' },
      { weekday: 1, startTime: '00:00', endTime: '01:00' },
    ],
  };
  expect(startsOf(generated(weekly, '2026-03-08'))).toEqual(['23:00', '23:45']);
  expect(
    startsOf(
      generated({ ...weekly, dateOverrides: [{ date: '2026-03-09', ranges: [] }] }, '2026-03-08'),
    ),
  ).toEqual(['23:00']);
});

it('crosses a midnight that the clock skips or repeats without opening closed time', () => {
  // Beirut 2026: clocks go from 00:00 to 01:00 on 29 March, so that date starts at 01:00.
  const before = { date: '2026-03-28', ranges: [{ startTime: '22:00', endTime: '24:00' }] };
  const skipped = { date: '2026-03-29', ranges: [{ startTime: '00:00', endTime: '03:00' }] };
  const config = rules('Asia/Beirut', [before, skipped], { bufferAfterMinutes: 30 });
  expect(generated(config, '2026-03-28').map((slot) => slot.startsAt)).toEqual([
    '2026-03-28T20:00:00Z',
    '2026-03-28T20:30:00Z',
    '2026-03-28T21:00:00Z',
    '2026-03-28T21:30:00Z',
  ]);
  // The skipped hour offers nothing; the date's first slots are at 01:00 local. The last,
  // 02:30 to 03:00, is offered although its buffer runs past closing.
  expect(generated(config, '2026-03-29').map((slot) => slot.startsAt)).toEqual([
    '2026-03-28T22:00:00Z',
    '2026-03-28T22:30:00Z',
    '2026-03-28T23:00:00Z',
    '2026-03-28T23:30:00Z',
  ]);
  // A 45-minute meeting at 23:30 local runs over the skipped midnight to 01:15 on the 29th:
  // offered while the 29th opens at 00:00, and not when the 29th is closed.
  const crossing = rules('Asia/Beirut', [before, skipped], { slotMinutes: 45 });
  expect(generated(crossing, '2026-03-28').map((slot) => slot.startsAt)).toEqual([
    '2026-03-28T20:00:00Z',
    '2026-03-28T20:45:00Z',
    '2026-03-28T21:30:00Z',
  ]);
  expect(
    generated(rules('Asia/Beirut', [before], { slotMinutes: 45 }), '2026-03-28').map(
      (slot) => slot.startsAt,
    ),
  ).toEqual(['2026-03-28T20:00:00Z', '2026-03-28T20:45:00Z']);
});

const zones = [
  { timezone: 'America/New_York', date: '2026-03-08' },
  { timezone: 'America/New_York', date: '2026-11-01' },
  { timezone: 'Europe/London', date: '2026-03-29' },
  { timezone: 'Europe/London', date: '2026-10-25' },
  { timezone: 'Africa/Nairobi', date: '2026-03-08' },
  { timezone: 'Australia/Lord_Howe', date: '2026-10-04' },
  { timezone: 'Australia/Lord_Howe', date: '2026-04-05' },
  { timezone: 'Asia/Beirut', date: '2026-10-24' },
] as const;

it('keeps every meeting minute of evening hours ending at 24:00 on its own date, by Intl, across zones', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...zones),
      fc.constantFrom(5, 10, 15, 20, 30, 45, 60),
      fc.integer({ min: 0, max: 30 }),
      fc.integer({ min: 0, max: 30 }),
      (zone, duration, before, after) => {
        const evening = { date: zone.date, ranges: [{ startTime: '20:00', endTime: '24:00' }] };
        const slots = generated(
          rules(zone.timezone, [evening], {
            slotMinutes: duration,
            bufferBeforeMinutes: before,
            bufferAfterMinutes: after,
          }),
          zone.date,
        );
        const formatter = new Intl.DateTimeFormat('en-GB', {
          timeZone: zone.timezone,
          calendar: 'iso8601',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        });
        const local = (instant: number) => {
          const parts = new Map(
            formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
          );
          const part = (type: Intl.DateTimeFormatPartTypes): string => {
            const value = parts.get(type);
            if (value === undefined) throw new Error(`Missing date part: ${type}`);
            return value;
          };
          return {
            date: `${part('year')}-${part('month')}-${part('day')}`,
            time: `${part('hour')}:${part('minute')}`,
          };
        };
        expect(slots.length).toBeGreaterThan(0);
        // The buffers may run outside the hours; only the meeting must be inside.
        for (const slot of slots) {
          const start = Date.parse(slot.startsAt);
          const end = Date.parse(slot.endsAt);
          const samples = [end - 1];
          for (let instant = start; instant < end; instant += 60_000) samples.push(instant);
          for (const sample of samples) {
            const at = local(sample);
            expect(at.date).toBe(zone.date);
            expect(at.time >= '20:00').toBe(true);
          }
        }
        // Whatever the buffers, the slot that ends exactly at midnight is offered.
        const last = slots.at(-1);
        if (240 % duration === 0 && last !== undefined)
          expect(local(Date.parse(last.endsAt)).time).toBe('00:00');
      },
    ),
    { numRuns: 60, seed: 146 },
  );
}, 30_000);
