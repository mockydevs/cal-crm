// A task reminder's time as the notifications page edits it: a number and a unit, as
// GoHighLevel's "Get a reminder X mins/hours/days before an upcoming task" has it, kept on
// the server in minutes, up to 30 days.
export type ReminderUnit = 'minutes' | 'hours' | 'days';

const MINUTES: Record<ReminderUnit, number> = { minutes: 1, hours: 60, days: 1440 };
const MAX_MINUTES = 43_200;

export interface ReminderDraft {
  readonly amount: string;
  readonly unit: ReminderUnit;
}

/** The largest unit the minutes divide into, so 1440 reads as 1 day. */
export function reminderDraftOf(minutes: number | null | undefined): ReminderDraft {
  if (minutes === null || minutes === undefined) return { amount: '', unit: 'minutes' };
  if (minutes % MINUTES.days === 0) return { amount: String(minutes / MINUTES.days), unit: 'days' };
  if (minutes % MINUTES.hours === 0)
    return { amount: String(minutes / MINUTES.hours), unit: 'hours' };
  return { amount: String(minutes), unit: 'minutes' };
}

/** Minutes to send: null for no reminder (left empty), undefined when it cannot be sent. */
export function reminderMinutesOf(draft: ReminderDraft): number | null | undefined {
  const amount = draft.amount.trim();
  if (amount === '') return null;
  if (!/^\d+$/.test(amount)) return undefined;
  const minutes = Number(amount) * MINUTES[draft.unit];
  return minutes >= 1 && minutes <= MAX_MINUTES ? minutes : undefined;
}
