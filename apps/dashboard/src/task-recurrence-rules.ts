// A recurring task's rule as the task panel edits it, and what it sends: GoHighLevel's
// "Recurring Task" switch, "Repeats every" n hours, days, weeks, months or years, "Ends on"
// never, a custom date or after a number of tasks, and "Create a new task even if the
// previous one is overdue". The limits are the server's (tasks-recurrence.ts).
import type { TaskFrequency, TaskRecurrence, TaskRecurrenceInput } from '@repo/contracts';

export type RecurrenceEnd = 'never' | 'on' | 'after';

export interface RecurrenceDraft {
  readonly on: boolean;
  readonly frequency: TaskFrequency;
  /** As typed, so a half-typed number stays as it is. */
  readonly every: string;
  readonly ends: RecurrenceEnd;
  /** YYYY-MM-DD, from a date field. */
  readonly endsOn: string;
  readonly occurrences: string;
  readonly createIfOverdue: boolean;
}

const MAX_EVERY = 999;
const MAX_OCCURRENCES = 1000;

export const NO_RECURRENCE: RecurrenceDraft = {
  on: false,
  frequency: 'daily',
  every: '1',
  ends: 'never',
  endsOn: '',
  occurrences: '10',
  createIfOverdue: false,
};

/** The draft a task opens with: its series' rule, switched on while the series runs. */
export function draftOf(recurrence: TaskRecurrence | undefined): RecurrenceDraft {
  if (recurrence === undefined) return NO_RECURRENCE;
  return {
    on: recurrence.active,
    frequency: recurrence.frequency,
    every: String(recurrence.every),
    ends: recurrence.ends.type,
    endsOn: recurrence.ends.type === 'on' ? recurrence.ends.date : '',
    occurrences:
      recurrence.ends.type === 'after'
        ? String(recurrence.ends.occurrences)
        : NO_RECURRENCE.occurrences,
    createIfOverdue: recurrence.createIfOverdue,
  };
}

const whole = (value: string, max: number): number | undefined => {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const number = Number(value);
  return number >= 1 && number <= max ? number : undefined;
};

/** What the draft sends: the rule, null when switched off, or the field to put right. */
export function recurrenceOf(
  draft: RecurrenceDraft,
):
  | { readonly ok: true; readonly value: TaskRecurrenceInput | null }
  | { readonly ok: false; readonly field: 'every' | 'endsOn' | 'occurrences' } {
  if (!draft.on) return { ok: true, value: null };
  const every = whole(draft.every, MAX_EVERY);
  if (every === undefined) return { ok: false, field: 'every' };
  let ends: TaskRecurrenceInput['ends'] = { type: 'never' };
  if (draft.ends === 'on') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.endsOn)) return { ok: false, field: 'endsOn' };
    ends = { type: 'on', date: draft.endsOn };
  } else if (draft.ends === 'after') {
    const occurrences = whole(draft.occurrences, MAX_OCCURRENCES);
    if (occurrences === undefined) return { ok: false, field: 'occurrences' };
    ends = { type: 'after', occurrences };
  }
  return {
    ok: true,
    value: { frequency: draft.frequency, every, ends, createIfOverdue: draft.createIfOverdue },
  };
}

const sameDraft = (one: RecurrenceDraft, other: RecurrenceDraft): boolean =>
  one.on === other.on &&
  (!one.on ||
    (one.frequency === other.frequency &&
      one.every.trim() === other.every.trim() &&
      one.ends === other.ends &&
      (one.ends !== 'on' || one.endsOn === other.endsOn) &&
      (one.ends !== 'after' || one.occurrences.trim() === other.occurrences.trim()) &&
      one.createIfOverdue === other.createIfOverdue));

/**
 * What an edit of a whole series sends: nothing when the draft is the series' rule as it
 * was (the server then keeps the schedule where it is), the new rule, or null to stop.
 */
export function seriesRecurrenceOf(
  original: TaskRecurrence,
  draft: RecurrenceDraft,
): ReturnType<typeof recurrenceOf> | { readonly ok: true; readonly value: undefined } {
  if (sameDraft(draftOf(original), draft)) return { ok: true, value: undefined };
  return recurrenceOf(draft);
}
