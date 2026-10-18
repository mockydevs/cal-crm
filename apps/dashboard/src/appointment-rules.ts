// What the appointment list and the appointment panels work out before they draw: the
// question the list asks `listAppointments`, the order a heading asks for, and what a
// booking or a move sends, from the form as it stands. Wall times are the business's, as
// the calendar draws them, or this machine's where no zone is given. No contract schema is
// read here.
import type { AppointmentRow } from '@repo/contracts';
import { instantAt, wallClock, type AppointmentTab } from './calendar-rules';
import { dueInstant } from './task-rules';

export type AppointmentSort = 'startsAt' | 'title' | 'createdAt';
export interface AppointmentOrder {
  readonly sort: AppointmentSort;
  readonly direction: 'asc' | 'desc';
}

/** Soonest first, as the server orders the list when nothing is asked. */
export const soonestFirst: AppointmentOrder = { sort: 'startsAt', direction: 'asc' };

/** The order after a heading is pressed: the other way round on its own column, A to Z on a new one. */
export function ordered(current: AppointmentOrder, sort: AppointmentSort): AppointmentOrder {
  if (current.sort !== sort) return { sort, direction: 'asc' };
  return { sort, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

export const ANY = 'all';
export type AppointmentStatusName = AppointmentRow['status'];

export interface AppointmentFilters {
  readonly view: AppointmentTab;
  readonly status: AppointmentStatusName | typeof ANY;
  /** A calendar id, or ANY. */
  readonly calendar: string;
  /** A membership id, or ANY. */
  readonly user: string;
  readonly q: string;
}

export const noAppointmentFilters: AppointmentFilters = {
  view: 'upcoming',
  status: ANY,
  calendar: ANY,
  user: ANY,
  q: '',
};

export interface AppointmentListQuery extends AppointmentOrder {
  readonly view: AppointmentTab;
  readonly limit: number;
  readonly status?: AppointmentStatusName;
  readonly calendar?: string;
  readonly user?: string;
  readonly q?: string;
  readonly after?: string;
}

/** The question the list asks the server: `listAppointments` filters on exactly these. */
export function appointmentQueryOf(
  filters: AppointmentFilters,
  order: AppointmentOrder,
  limit: number,
  after: string | undefined,
): AppointmentListQuery {
  const q = filters.q.trim();
  return {
    view: filters.view,
    sort: order.sort,
    direction: order.direction,
    limit,
    ...(filters.status === ANY ? {} : { status: filters.status }),
    ...(filters.calendar === ANY ? {} : { calendar: filters.calendar }),
    ...(filters.user === ANY ? {} : { user: filters.user }),
    ...(q === '' ? {} : { q }),
    ...(after === undefined ? {} : { after }),
  };
}

/** Whether anything but the tab narrows the list. */
export function narrowed(filters: AppointmentFilters): boolean {
  return (
    filters.status !== ANY ||
    filters.calendar !== ANY ||
    filters.user !== ANY ||
    filters.q.trim() !== ''
  );
}

const part = (value: number, length = 2): string => String(value).padStart(length, '0');

/**
 * An instant as the wall time to the minute, as a date-and-time input holds it: in the zone
 * given, or this machine's.
 */
export function wallTime(instant: string | Date, zone?: string): string {
  const date = new Date(instant);
  if (zone === undefined)
    return `${part(date.getFullYear(), 4)}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
  const { day, minutes } = wallClock(date.getTime(), zone);
  return `${part(day.getUTCFullYear(), 4)}-${part(day.getUTCMonth() + 1)}-${part(day.getUTCDate())}T${part(Math.floor(minutes / 60))}:${part(minutes % 60)}`;
}

/** The next half hour, where a new appointment's time starts. */
export function nextHalfHour(now: Date, zone?: string): string {
  const step = 30 * 60_000;
  return wallTime(new Date((Math.floor(now.getTime() / step) + 1) * step), zone);
}

/**
 * The instant a wall time in a zone names: undefined for no time at all, or for one the
 * zone's clock never shows (the hour lost in spring). This machine's zone when none is given.
 */
export function instantOfWall(wall: string, zone?: string): string | undefined {
  if (zone === undefined) return dueInstant(wall);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(wall);
  if (match === null) return undefined;
  const [year, month, date, hour, minute] = match.slice(1).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    date === undefined ||
    hour === undefined ||
    minute === undefined
  )
    return undefined;
  const day = new Date(Date.UTC(year, month - 1, date));
  const instant = new Date(instantAt(day, hour * 60 + minute, zone));
  return wallTime(instant, zone) === wall ? instant.toISOString() : undefined;
}

/** The calendar's choice of who an appointment is with, or whoever it is with already. */
export const NO_CHOICE = 'none';

export interface AppointmentDraft {
  readonly calendarId: string;
  readonly contactId: string | undefined;
  /** Wall times, as the inputs hold them. */
  readonly start: string;
  readonly end: string;
  /** A membership id, or NO_CHOICE. */
  readonly assignee: string;
  readonly title: string;
  readonly status: 'booked' | 'confirmed';
  readonly location: string;
  readonly notes: string;
  readonly ignoreAvailability: boolean;
}

/** What is wrong with a draft before it is sent, by field: the screen puts it in words. */
export type DraftFault = 'missing' | 'no_such_time' | 'ends_before_start';
export type DraftFaults = Partial<
  Record<'calendarId' | 'contactId' | 'startsAt' | 'endsAt', DraftFault>
>;

interface When {
  readonly startsAt: string;
  readonly endsAt?: string;
  readonly ignoreAvailability: boolean;
}

/** The start, and the end when the calendar's slot length is not to decide it. */
function when(
  draft: AppointmentDraft,
  zone: string | undefined,
): { readonly when?: When; readonly faults: DraftFaults } {
  const faults: DraftFaults = {};
  const startsAt = draft.start === '' ? undefined : instantOfWall(draft.start, zone);
  if (draft.start === '') faults.startsAt = 'missing';
  else if (startsAt === undefined) faults.startsAt = 'no_such_time';
  let endsAt: string | undefined;
  if (draft.ignoreAvailability) {
    endsAt = draft.end === '' ? undefined : instantOfWall(draft.end, zone);
    if (draft.end === '') faults.endsAt = 'missing';
    else if (endsAt === undefined) faults.endsAt = 'no_such_time';
    else if (startsAt !== undefined && !(Date.parse(endsAt) > Date.parse(startsAt)))
      faults.endsAt = 'ends_before_start';
  }
  if (startsAt === undefined || Object.keys(faults).length > 0) return { faults };
  return {
    faults,
    when: {
      startsAt,
      ...(endsAt === undefined ? {} : { endsAt }),
      ignoreAvailability: draft.ignoreAvailability,
    },
  };
}

export interface BookingBody extends When {
  readonly requestId: string;
  readonly calendarId: string;
  readonly contactId: string;
  readonly assignee?: string;
  readonly title?: string;
  readonly status: 'booked' | 'confirmed';
  readonly location?: string;
  readonly notes: string;
}

/** What `createAppointment` is sent, or what the draft still lacks. */
export function bookingOf(
  draft: AppointmentDraft,
  requestId: string,
  zone?: string,
): { readonly body: BookingBody } | { readonly faults: DraftFaults } {
  const timed = when(draft, zone);
  const faults: DraftFaults = {
    ...(draft.calendarId === '' ? { calendarId: 'missing' as const } : {}),
    ...(draft.contactId === undefined ? { contactId: 'missing' as const } : {}),
    ...timed.faults,
  };
  if (timed.when === undefined || draft.contactId === undefined || draft.calendarId === '')
    return { faults };
  const title = draft.title.trim();
  const location = draft.location.trim();
  return {
    body: {
      requestId,
      calendarId: draft.calendarId,
      contactId: draft.contactId,
      ...timed.when,
      ...(draft.assignee === NO_CHOICE ? {} : { assignee: draft.assignee }),
      ...(title === '' ? {} : { title }),
      status: draft.status,
      ...(location === '' ? {} : { location }),
      notes: draft.notes,
    },
  };
}

export interface MoveBody extends When {
  readonly revision: string;
  readonly assignee?: string;
}

/** What `rescheduleAppointment` is sent, or what the draft still lacks. */
export function moveOf(
  draft: AppointmentDraft,
  revision: string,
  zone?: string,
): { readonly body: MoveBody } | { readonly faults: DraftFaults } {
  const timed = when(draft, zone);
  if (timed.when === undefined) return { faults: timed.faults };
  return {
    body: {
      revision,
      ...timed.when,
      ...(draft.assignee === NO_CHOICE ? {} : { assignee: draft.assignee }),
    },
  };
}
