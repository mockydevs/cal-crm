// What the blocked slot form works out: the times it shows and sends, typed by the clock of
// the business's zone, and the body `createBlockedSlot` and `updateBlockedSlot` take. No
// contract schema is read here.
import { DAY_MINUTES, instantAt, wallClock } from './calendar-rules';

/** No choice in a select: every calendar, or everyone on the calendar chosen. */
export const ALL = '';

export interface BlockedSlotDraft {
  readonly title: string;
  /** A membership id, or ALL for everyone on the calendar. */
  readonly membershipId: string;
  /** A calendar id, or ALL for every calendar the person is on. */
  readonly calendarId: string;
  /** As a datetime-local field holds it: 2026-10-14T09:30, by the zone's clock. */
  readonly start: string;
  readonly end: string;
}

export type BlockedSlotFault = 'missing' | 'order' | 'whom';
export type BlockedSlotFaults = Partial<
  Record<'membershipId' | 'startsAt' | 'endsAt', BlockedSlotFault>
>;

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

/** An instant as a datetime-local value by the zone's clock. */
export function localValue(instant: number, zone: string): string {
  const { day, minutes } = wallClock(instant, zone);
  return `${pad(day.getUTCFullYear(), 4)}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** A datetime-local value read by the zone's clock, as an instant; none when unreadable. */
export function instantOfLocal(value: string, zone: string): string | undefined {
  const found = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (found === null) return undefined;
  const [, year, month, date, hour, minute] = found.map(Number);
  const minutes = (hour ?? 0) * 60 + (minute ?? 0);
  if (minutes >= DAY_MINUTES) return undefined;
  const day = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1));
  return new Date(instantAt(day, minutes, zone)).toISOString();
}

/** The next whole hour after an instant. */
function nextHour(now: number): number {
  return Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
}

/** A blocked slot as the form starts on: one saved, or an hour from where it was asked for. */
export function blockedSlotDraft(
  saved:
    | {
        readonly title: string;
        readonly member: { readonly membershipId: string | null } | null;
        readonly calendar: { readonly id: string } | null;
        readonly startsAt: string;
        readonly endsAt: string;
      }
    | undefined,
  preset: { readonly membershipId?: string; readonly start?: number },
  zone: string,
  now: number = Date.now(),
): BlockedSlotDraft {
  if (saved !== undefined)
    return {
      title: saved.title,
      membershipId: saved.member?.membershipId ?? ALL,
      calendarId: saved.calendar?.id ?? ALL,
      start: localValue(Date.parse(saved.startsAt), zone),
      end: localValue(Date.parse(saved.endsAt), zone),
    };
  const start = preset.start ?? nextHour(now);
  return {
    title: '',
    membershipId: preset.membershipId ?? ALL,
    calendarId: ALL,
    start: localValue(start, zone),
    end: localValue(start + 3_600_000, zone),
  };
}

/** What the form sends, or what is wrong with it before anything is sent. */
export function blockedSlotBody(
  draft: BlockedSlotDraft,
  zone: string,
):
  | {
      readonly body: {
        readonly title: string;
        readonly membershipId: string | null;
        readonly calendarId: string | null;
        readonly startsAt: string;
        readonly endsAt: string;
      };
    }
  | { readonly faults: BlockedSlotFaults } {
  const startsAt = instantOfLocal(draft.start, zone);
  const endsAt = instantOfLocal(draft.end, zone);
  const faults: BlockedSlotFaults = {};
  if (draft.membershipId === ALL && draft.calendarId === ALL) faults.membershipId = 'whom';
  if (startsAt === undefined) faults.startsAt = 'missing';
  if (endsAt === undefined) faults.endsAt = 'missing';
  else if (startsAt !== undefined && Date.parse(endsAt) <= Date.parse(startsAt))
    faults.endsAt = 'order';
  if (Object.keys(faults).length > 0 || startsAt === undefined || endsAt === undefined)
    return { faults };
  return {
    body: {
      title: draft.title.trim(),
      membershipId: draft.membershipId === ALL ? null : draft.membershipId,
      calendarId: draft.calendarId === ALL ? null : draft.calendarId,
      startsAt,
      endsAt,
    },
  };
}
