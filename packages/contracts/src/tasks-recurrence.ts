// Recurring tasks, as GoHighLevel offers them: hourly, daily, weekly, monthly or yearly,
// every n of those, ending never, on a date or after a number of tasks, and whether a new
// task is made while the one before it is still overdue.
//
// Occurrence n of a series is due at the anchor's due time moved (n - anchor) times by the
// rule. Hourly moves the instant. The others move the date on the wall clock of the series'
// time zone and keep the time of day, so a task due at 09:00 is due at 09:00 after a clock
// change; a monthly or yearly date a month does not have becomes that month's last day, and
// each occurrence is counted from the anchor, so a task of the 31st is back on the 31st.
import * as z from 'zod';

import { zonedParts, zonedTime } from './automations-zoned.js';

export const taskFrequencies = ['hourly', 'daily', 'weekly', 'monthly', 'yearly'] as const;
export type TaskFrequency = (typeof taskFrequencies)[number];

/** The most a "Repeats every" may say, and the most tasks a series may end after. */
export const MAX_TASK_REPEAT_EVERY = 999;
export const MAX_TASK_OCCURRENCES = 1000;

export const taskRecurrenceEnd = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('never') }),
  z.strictObject({
    type: z.literal('on'),
    date: z.iso.date().meta({
      description:
        "The last day a task of the series may be due on, in the business's time zone. Not before the first task's due date.",
    }),
  }),
  z.strictObject({
    type: z.literal('after'),
    occurrences: z
      .int()
      .min(1)
      .max(MAX_TASK_OCCURRENCES)
      .meta({ description: 'How many tasks the series makes in all, the first included.' }),
  }),
]);
export type TaskRecurrenceEnd = z.output<typeof taskRecurrenceEnd>;

export const taskRecurrenceInput = z
  .strictObject({
    frequency: z.enum(taskFrequencies),
    every: z
      .int()
      .min(1)
      .max(MAX_TASK_REPEAT_EVERY)
      .default(1)
      .meta({ description: 'Repeats every this many hours, days, weeks, months or years.' }),
    ends: taskRecurrenceEnd.default({ type: 'never' }),
    createIfOverdue: z.boolean().default(false).meta({
      description:
        'Make the next task on schedule even while the one before it is open and overdue. Off, that task is not made.',
    }),
  })
  .meta({ id: 'TaskRecurrenceInput' });
export type TaskRecurrenceInput = z.output<typeof taskRecurrenceInput>;

/** What a series' due times are worked out from. */
export interface TaskSchedule {
  readonly frequency: TaskFrequency;
  readonly every: number;
  readonly anchorDueAt: Date;
  readonly anchorOccurrence: number;
  readonly timeZone: string;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * The shortest and the longest one step of a rule can be: a wall-clock day is 23 to 25
 * hours where the clocks change, a month 28 to 31 days, a year 365 or 366.
 */
export function recurrencePeriod(rule: {
  readonly frequency: TaskFrequency;
  readonly every: number;
}): { readonly shortest: number; readonly longest: number } {
  const { every } = rule;
  switch (rule.frequency) {
    case 'hourly':
      return { shortest: every * HOUR, longest: every * HOUR };
    case 'daily':
      return { shortest: every * (DAY - HOUR), longest: every * (DAY + HOUR) };
    case 'weekly':
      return { shortest: every * 7 * DAY - HOUR, longest: every * 7 * DAY + HOUR };
    case 'monthly':
      return { shortest: every * 28 * DAY - HOUR, longest: every * 31 * DAY + HOUR };
    case 'yearly':
      return { shortest: every * 365 * DAY - HOUR, longest: every * 366 * DAY + HOUR };
  }
}

const daysInMonth = (year: number, month: number): number => {
  const last = new Date(0);
  last.setUTCFullYear(year, month, 0);
  return last.getUTCDate();
};

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

/** When occurrence n of a series is due; nothing when the zone or the date is not one. */
export function occurrenceDue(schedule: TaskSchedule, occurrence: number): Date | undefined {
  const steps = (occurrence - schedule.anchorOccurrence) * schedule.every;
  if (schedule.frequency === 'hourly')
    return new Date(schedule.anchorDueAt.getTime() + steps * HOUR);
  const local = zonedParts(schedule.anchorDueAt, schedule.timeZone);
  if (local === undefined) return undefined;
  const [year = 0, month = 1, day = 1] = local.date.split('-').map(Number);
  let date: string;
  if (schedule.frequency === 'daily' || schedule.frequency === 'weekly') {
    // Date.UTC would read the years 0 to 99 as 1900 to 1999, so the year is set on its own.
    const moved = new Date(0);
    moved.setUTCFullYear(year, month - 1, day + steps * (schedule.frequency === 'weekly' ? 7 : 1));
    date = moved.toISOString().slice(0, 10);
  } else {
    const months = year * 12 + (month - 1) + steps * (schedule.frequency === 'yearly' ? 12 : 1);
    const toYear = Math.floor(months / 12);
    const toMonth = (months % 12) + 1;
    date = `${pad(toYear, 4)}-${pad(toMonth)}-${pad(Math.min(day, daysInMonth(toYear, toMonth)))}`;
  }
  const at = zonedTime(date, local.time, schedule.timeZone);
  return at === undefined ? undefined : new Date(at.getTime() + Math.round(local.seconds * 1000));
}

/**
 * The newest occurrence due at or before an instant, from the anchor on: one before the
 * anchor when none is. Worked out in one step from the time or the months between, then
 * checked against the rule itself, so a series far behind is not walked an occurrence at
 * a time.
 */
export function lastOccurrenceBy(schedule: TaskSchedule, instant: Date): number {
  const anchor = schedule.anchorOccurrence;
  const elapsed = instant.getTime() - schedule.anchorDueAt.getTime();
  let found = anchor - 1;
  if (elapsed >= 0) {
    if (schedule.frequency === 'monthly' || schedule.frequency === 'yearly') {
      const from = zonedParts(schedule.anchorDueAt, schedule.timeZone)?.date;
      const to = zonedParts(instant, schedule.timeZone)?.date;
      const months = (date: string) => {
        const [year = 0, month = 1] = date.split('-').map(Number);
        return year * 12 + month - 1;
      };
      const step = schedule.every * (schedule.frequency === 'yearly' ? 12 : 1);
      found =
        from === undefined || to === undefined
          ? anchor
          : anchor + Math.floor((months(to) - months(from)) / step);
    } else {
      const step =
        schedule.every *
        (schedule.frequency === 'hourly' ? HOUR : schedule.frequency === 'daily' ? DAY : 7 * DAY);
      found = anchor + Math.floor(elapsed / step);
    }
  }
  const dueBy = (occurrence: number) => {
    const due = occurrenceDue(schedule, occurrence);
    return due !== undefined && due.getTime() <= instant.getTime();
  };
  // The estimate is within a step or two either way: a clock change, a short month.
  for (let tries = 0; tries < 4 && found >= anchor && !dueBy(found); tries += 1) found -= 1;
  for (let tries = 0; tries < 4 && dueBy(found + 1); tries += 1) found += 1;
  return Math.max(found, anchor - 1);
}

/**
 * Whether a series may still make occurrence n, due then: on or before its last day (in
 * its time zone), and while it has had fewer occurrences than it may. Every scheduled
 * occurrence counts, one passed over included, so a series always ends.
 */
export function occurrenceWithinEnd(
  due: Date,
  timeZone: string,
  end: {
    readonly endsOn?: string | null;
    readonly maxOccurrences?: number | null;
    readonly occurrence: number;
  },
): boolean {
  if (end.endsOn !== undefined && end.endsOn !== null) {
    const local = zonedParts(due, timeZone);
    if (local === undefined || local.date > end.endsOn) return false;
  }
  if (end.maxOccurrences !== undefined && end.maxOccurrences !== null)
    return end.occurrence < end.maxOccurrences;
  return true;
}

/**
 * Why a recurring task's due time cannot start a series: more than one step of its rule
 * in the past, so a series is never made to catch up on years of tasks at once.
 */
export function recurrenceDueTooOld(
  dueAt: string,
  recurrence: { readonly frequency: TaskFrequency; readonly every?: number },
  now: number,
): boolean {
  const due = Date.parse(dueAt);
  return (
    Number.isFinite(due) &&
    due +
      recurrencePeriod({ frequency: recurrence.frequency, every: recurrence.every ?? 1 }).longest <
      now
  );
}
