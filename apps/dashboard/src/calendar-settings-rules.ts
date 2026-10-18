// What Settings → Calendars works out before it draws: the types a calendar can be, the
// units its numbers are typed in, the words of a week's hours, the form a calendar is
// edited as and the bodies that form is saved with, checked by the contract's own schemas
// so the messages are the server's.
import {
  BOOKABLE_CALENDAR_KINDS,
  CALENDAR_LIMITS,
  createCalendarInput,
  updateCalendarAvailabilityInput,
  updateCalendarInput,
  type BotProtection,
  type CalendarConfiguration,
  type CalendarKind,
  type CalendarUserAvailabilityProfile,
  type ListCalendarsQuery,
  type User,
} from '@repo/contracts';
import type * as z from 'zod';

/** Whether a calendar of this type can take bookings today (decision 1). */
export const isBookableKind = (kind: CalendarKind): boolean =>
  BOOKABLE_CALENDAR_KINDS.includes(kind);

/**
 * The types a new calendar can be: only those that take bookings, in the screenshot's
 * order. The others come back to the chooser when their booking is built.
 */
export const chooserKinds: readonly CalendarKind[] = BOOKABLE_CALENDAR_KINDS;

/** The types a calendar's type can be changed to: the bookable ones, and the one it is. */
export const kindChoices = (current: CalendarKind): readonly CalendarKind[] =>
  isBookableKind(current) ? chooserKinds : [...chooserKinds, current];

// Units. Everything is stored in minutes; the selects beside the numbers are the form's.

export const units = ['minutes', 'hours', 'days'] as const;
export type Unit = (typeof units)[number];
const unitMinutes: Readonly<Record<Unit, number>> = { minutes: 1, hours: 60, days: 1440 };

export interface Amount {
  readonly value: string;
  readonly unit: Unit;
}

/** Minutes as the form shows them: in the largest unit offered that holds them exactly. */
export function amountOf(minutes: number | null, offered: readonly Unit[]): Amount {
  const first = offered[0] ?? 'minutes';
  if (minutes === null) return { value: '', unit: first };
  const unit =
    minutes === 0
      ? first
      : (offered.toReversed().find((each) => minutes % unitMinutes[each] === 0) ?? first);
  return { value: String(minutes / unitMinutes[unit]), unit };
}

/** A whole number typed into a box: null for nothing, NaN for anything else. */
export function wholeOf(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** An amount in minutes: null for nothing typed, NaN for what is not a whole number. */
export function minutesOf(amount: Amount): number | null {
  const whole = wholeOf(amount.value);
  return whole === null ? null : whole * unitMinutes[amount.unit];
}

// The booking link.

/** The slug suggested for a name: what the contract's SLUG accepts, at most 63 characters. */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

/** What comes before a calendar's slug in its public address. */
export const bookingPrefix = (agency: string, business: string): string =>
  `/book/${agency}/${business}/`;

export const bookingAddress = (
  origin: string,
  agency: string,
  business: string,
  slug: string,
): string => `${origin}${bookingPrefix(agency, business)}${slug}`;

// Hours.

export interface Hours {
  readonly weekday: number;
  readonly startTime: string;
  readonly endTime: string;
}
export interface HoursDraft extends Hours {
  readonly key: string;
}
export interface RangeDraft {
  readonly key: string;
  readonly startTime: string;
  readonly endTime: string;
}
export interface OverrideDraft {
  readonly key: string;
  readonly date: string;
  readonly ranges: readonly RangeDraft[];
}

/** The end of the day: a time input cannot hold it, so the form has a box for it. */
export const MIDNIGHT = '24:00';

/** What a new calendar opens: Monday to Friday, eight to five, as the page copied shows. */
export function defaultWeeklyHours(): HoursDraft[] {
  return [1, 2, 3, 4, 5].map((weekday) => ({
    key: crypto.randomUUID(),
    weekday,
    startTime: '08:00',
    endTime: '17:00',
  }));
}

export type HoursSummary =
  | { readonly kind: 'none' }
  | { readonly kind: 'varied' }
  | {
      readonly kind: 'same';
      readonly days: 'weekdays' | 'every_day' | readonly number[];
      readonly startTime: string;
      readonly endTime: string;
    };

/** A week's hours in a line: the days and the one range they share, when they share one. */
export function hoursSummary(hours: readonly Hours[]): HoursSummary {
  const [first] = hours;
  if (first === undefined) return { kind: 'none' };
  const days = [...new Set(hours.map((each) => each.weekday))].toSorted((a, b) => a - b);
  const same = hours.every(
    (each) => each.startTime === first.startTime && each.endTime === first.endTime,
  );
  if (!same || days.length !== hours.length) return { kind: 'varied' };
  const named = days.join() === '1,2,3,4,5' ? 'weekdays' : days.length === 7 ? 'every_day' : days;
  return { kind: 'same', days: named, startTime: first.startTime, endTime: first.endTime };
}

/** A clock time as the locale writes it: 17:00 as 5:00 PM. */
export function clockWords(time: string, locale: string): string {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2026, 0, 1, hours % 24, minutes)));
}

const clockOf = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** The hours a member is booked in: their own when they keep a schedule, else the calendar's. */
export function hoursOfMember(
  profile: CalendarUserAvailabilityProfile | null,
  calendarHours: readonly Hours[],
): Hours[] {
  if (profile === null || profile.inheritCalendarHours)
    return calendarHours.map(({ weekday, startTime, endTime }) => ({
      weekday,
      startTime,
      endTime,
    }));
  return profile.weeklyHours.map((each) => ({
    weekday: each.weekday,
    startTime: clockOf(each.startMinute),
    endTime: clockOf(each.endMinute),
  }));
}

// People.

export interface Person {
  readonly membershipId: string;
  readonly name: string;
  readonly email: string;
}

/**
 * Who can be put on a calendar: people of this business's own team who have joined. The
 * agency's staff and people still invited are refused by the server (decision 2).
 */
export function eligiblePeople(users: readonly User[]): Person[] {
  return users.flatMap((user) =>
    user.userType === 'account' && user.status === 'active' && user.membershipId !== null
      ? [{ membershipId: user.membershipId, name: user.name, email: user.email }]
      : [],
  );
}

// Colours and images.

export const isHexColor = (value: string): boolean =>
  /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value.trim());

/** The colour a swatch input can hold: #rrggbb, without the transparency. */
export const swatchOf = (value: string): string =>
  isHexColor(value) ? value.trim().toLowerCase().slice(0, 7) : '#000000';

const imageTypes: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const imageAccept = imageTypes.join(',');

/** Why a chosen file cannot be a calendar's logo or cover, before it is sent. */
export function imageProblem(file: {
  readonly type: string;
  readonly size: number;
}): 'type' | 'size' | undefined {
  if (!imageTypes.includes(file.type)) return 'type';
  return file.size > CALENDAR_LIMITS.imageBytes ? 'size' : undefined;
}

/** The merge fields the server fills in an appointment's title. */
export const mergeFields = [
  '{{contact.name}}',
  '{{contact.firstName}}',
  '{{contact.lastName}}',
  '{{contact.email}}',
  '{{contact.phone}}',
] as const;

// The form.

// google_meet: a Meet from the member's connected Google Calendar.
export const locationKinds = ['custom', 'phone', 'address', 'google_meet'] as const;
export type LocationKind = (typeof locationKinds)[number];

export interface LocationDraft {
  readonly key: string;
  readonly kind: LocationKind;
  readonly value: string;
  /** Null until "Add display label" is pressed. */
  readonly label: string | null;
}
export interface MemberDraft {
  readonly membershipId: string;
  readonly weight: string;
  readonly locations: readonly LocationDraft[];
}

export const durationUnits = ['minutes', 'hours'] as const satisfies readonly Unit[];
export const noticeUnits = ['minutes', 'hours', 'days'] as const satisfies readonly Unit[];

/** A calendar as its form holds it: text as typed, numbers with the unit chosen for them. */
export interface CalendarDraft {
  readonly kind: CalendarKind;
  readonly name: string;
  readonly description: string;
  readonly bookingSlug: string;
  readonly timezone: string;
  readonly isActive: boolean;
  readonly groupId: string | null;
  readonly logoFileId: string | null;
  readonly inviteTitle: string;
  readonly members: readonly MemberDraft[];
  readonly weeklyHours: readonly HoursDraft[];
  readonly dateOverrides: readonly OverrideDraft[];
  readonly interval: Amount;
  readonly duration: Amount;
  readonly extraDurations: readonly (Amount & { readonly key: string })[];
  readonly notice: Amount;
  readonly dateRange: string;
  readonly countAvailableDaysOnly: boolean;
  readonly bufferBefore: Amount;
  readonly bufferAfter: Amount;
  readonly maxPerDay: string;
  readonly maxPerSlot: string;
  readonly lookBusy: boolean;
  readonly lookBusyPercent: string;
  readonly consentEnabled: boolean;
  readonly consentText: string;
  readonly botProtection: BotProtection;
  readonly confirmationSenderId: string | null;
  readonly assignContactToMember: boolean;
  readonly skipAssignIfOwned: boolean;
  readonly allowReschedule: boolean;
  readonly rescheduleCutoff: Amount;
  readonly allowCancel: boolean;
  readonly cancelCutoff: Amount;
  readonly coverFileId: string | null;
  readonly widgetStyle: 'neo' | 'classic';
  readonly primaryColor: string;
  readonly backgroundColor: string;
  readonly buttonText: string;
}

type Settings = Omit<
  z.output<typeof createCalendarInput>,
  'members' | 'weeklyHours' | 'dateOverrides'
>;

function draftOfSettings(
  settings: Settings,
): Omit<CalendarDraft, 'members' | 'weeklyHours' | 'dateOverrides'> {
  return {
    kind: settings.kind,
    name: settings.name,
    description: settings.description,
    bookingSlug: settings.bookingSlug,
    timezone: settings.timezone,
    isActive: settings.isActive,
    groupId: settings.groupId,
    logoFileId: settings.logoFileId,
    inviteTitle: settings.inviteTitle,
    interval: amountOf(settings.slotIntervalMinutes, durationUnits),
    duration: amountOf(settings.slotMinutes, durationUnits),
    extraDurations: settings.extraDurationMinutes.map((minutes) => ({
      key: crypto.randomUUID(),
      ...amountOf(minutes, durationUnits),
    })),
    notice: amountOf(settings.minNoticeMinutes, noticeUnits),
    dateRange: String(settings.maxDaysAhead),
    countAvailableDaysOnly: settings.countAvailableDaysOnly,
    bufferBefore: amountOf(settings.bufferBeforeMinutes, durationUnits),
    bufferAfter: amountOf(settings.bufferAfterMinutes, durationUnits),
    maxPerDay: settings.maxPerDay === null ? '' : String(settings.maxPerDay),
    maxPerSlot: settings.maxPerSlot === null ? '' : String(settings.maxPerSlot),
    lookBusy: settings.lookBusyPercent > 0,
    lookBusyPercent: String(settings.lookBusyPercent),
    consentEnabled: settings.consentEnabled,
    consentText: settings.consentText,
    botProtection: settings.botProtection,
    confirmationSenderId: settings.confirmationSenderId,
    assignContactToMember: settings.assignContactToMember,
    skipAssignIfOwned: settings.skipAssignIfOwned,
    allowReschedule: settings.allowReschedule,
    rescheduleCutoff: amountOf(settings.rescheduleCutoffMinutes, noticeUnits),
    allowCancel: settings.allowCancel,
    cancelCutoff: amountOf(settings.cancelCutoffMinutes, noticeUnits),
    coverFileId: settings.coverFileId,
    widgetStyle: settings.widgetStyle,
    primaryColor: settings.primaryColor,
    backgroundColor: settings.backgroundColor,
    buttonText: settings.buttonText,
  };
}

/** A new calendar of a type: a draft, every setting at the contract's default. */
export function newDraft(kind: CalendarKind, timezone: string): CalendarDraft {
  const defaults = createCalendarInput.parse({
    // Never shown: the name and the link are written over just below.
    name: '0',
    bookingSlug: '0',
    kind,
    timezone,
    members: [],
    weeklyHours: [],
    dateOverrides: [],
  });
  return {
    ...draftOfSettings(defaults),
    name: '',
    bookingSlug: '',
    members: [],
    weeklyHours: defaultWeeklyHours(),
    dateOverrides: [],
  };
}

/** A saved calendar as the form holds it. Someone who left the team is not carried over. */
export function draftOf(configuration: CalendarConfiguration): CalendarDraft {
  return {
    ...draftOfSettings(configuration.calendar),
    members: configuration.members.flatMap((member) =>
      member.membershipId === null
        ? []
        : [
            {
              membershipId: member.membershipId,
              weight: String(member.weight),
              locations: member.locations.map((location) => ({
                key: crypto.randomUUID(),
                ...location,
              })),
            },
          ],
    ),
    weeklyHours: configuration.weeklyHours.map((hours) => ({
      ...hours,
      key: crypto.randomUUID(),
    })),
    dateOverrides: configuration.dateOverrides.map((override) => ({
      key: crypto.randomUUID(),
      date: override.date,
      ranges: override.ranges.map((range) => ({ ...range, key: crypto.randomUUID() })),
    })),
  };
}

/** A required number: what was typed, or NaN, which the contract refuses under its field. */
const required = (value: number | null): number => value ?? Number.NaN;

function settingsOf(draft: CalendarDraft): Record<string, unknown> {
  return {
    kind: draft.kind,
    name: draft.name,
    description: draft.description,
    bookingSlug: draft.bookingSlug.trim(),
    timezone: draft.timezone.trim(),
    isActive: draft.isActive,
    groupId: draft.groupId,
    logoFileId: draft.logoFileId,
    inviteTitle: draft.inviteTitle,
    slotIntervalMinutes: minutesOf(draft.interval),
    slotMinutes: required(minutesOf(draft.duration)),
    extraDurationMinutes: draft.extraDurations.map((each) => required(minutesOf(each))),
    minNoticeMinutes: minutesOf(draft.notice) ?? 0,
    maxDaysAhead: required(wholeOf(draft.dateRange)),
    countAvailableDaysOnly: draft.countAvailableDaysOnly,
    bufferBeforeMinutes: minutesOf(draft.bufferBefore) ?? 0,
    bufferAfterMinutes: minutesOf(draft.bufferAfter) ?? 0,
    maxPerDay: wholeOf(draft.maxPerDay),
    maxPerSlot: wholeOf(draft.maxPerSlot),
    lookBusyPercent: draft.lookBusy ? required(wholeOf(draft.lookBusyPercent)) : 0,
    consentEnabled: draft.consentEnabled,
    consentText: draft.consentText,
    botProtection: draft.botProtection,
    confirmationSenderId: draft.confirmationSenderId,
    assignContactToMember: draft.assignContactToMember,
    skipAssignIfOwned: draft.skipAssignIfOwned,
    allowReschedule: draft.allowReschedule,
    rescheduleCutoffMinutes: minutesOf(draft.rescheduleCutoff),
    allowCancel: draft.allowCancel,
    cancelCutoffMinutes: minutesOf(draft.cancelCutoff),
    coverFileId: draft.coverFileId,
    widgetStyle: draft.widgetStyle,
    primaryColor: draft.primaryColor,
    backgroundColor: draft.backgroundColor,
    buttonText: draft.buttonText,
  };
}

interface Availability {
  members: { membershipId: string; weight: number; locations: unknown[] }[];
  weeklyHours: Hours[];
  dateOverrides: { date: string; ranges: { startTime: string; endTime: string }[] }[];
}

/** The team, their meeting places and the hours, as the availability save takes them. */
export function availabilityBody(draft: CalendarDraft): Availability {
  return {
    members: draft.members.map((member) => ({
      membershipId: member.membershipId,
      weight: required(wholeOf(member.weight)),
      locations: member.locations.map(({ kind, value, label }) => ({
        kind,
        value,
        label: label === null || label.trim() === '' ? null : label,
      })),
    })),
    weeklyHours: draft.weeklyHours.map(({ weekday, startTime, endTime }) => ({
      weekday,
      startTime,
      endTime,
    })),
    dateOverrides: draft.dateOverrides.map(({ date, ranges }) => ({
      date,
      ranges: ranges.map(({ startTime, endTime }) => ({ startTime, endTime })),
    })),
  };
}

/** Whether the team, a meeting place or the hours differ from what was saved. */
export function availabilityChanged(draft: CalendarDraft, saved: CalendarConfiguration): boolean {
  if (saved.members.some((member) => member.membershipId === null)) return true;
  return (
    JSON.stringify(availabilityBody(draft)) !== JSON.stringify(availabilityBody(draftOf(saved)))
  );
}

/** One thing wrong with a field: the contract's code for it, and its words. */
export interface FieldIssue {
  readonly code: string;
  readonly message: string;
  /** Where in the body it is, such as members, 0, weight. */
  readonly path: readonly string[];
}
export type Checked<Body> =
  | { readonly ok: true; readonly body: Body }
  | { readonly ok: false; readonly fields: Record<string, FieldIssue> };

function checked<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): Checked<z.output<Schema>> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, body: parsed.data };
  const fields: Record<string, FieldIssue> = {};
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? '');
    fields[field] ??= { code: issue.code, message: issue.message, path: issue.path.map(String) };
  }
  return { ok: false, fields };
}

/** A new calendar, ready to create: settings, team and hours in one body. */
export const checkCreate = (draft: CalendarDraft): Checked<z.output<typeof createCalendarInput>> =>
  checked(createCalendarInput, { ...settingsOf(draft), ...availabilityBody(draft) });

/** A saved calendar's settings, with the revision they were read at. */
export const checkSettings = (
  draft: CalendarDraft,
  revision: string,
): Checked<z.output<typeof updateCalendarInput>> =>
  checked(updateCalendarInput, { ...settingsOf(draft), revision });

/** A saved calendar's team and hours, with the revision they were read at. */
export const checkAvailability = (
  draft: CalendarDraft,
  revision: string,
): Checked<z.output<typeof updateCalendarAvailabilityInput>> =>
  checked(updateCalendarAvailabilityInput, { ...availabilityBody(draft), revision });

/**
 * What each number accepts, for the words under its box. Stated beside the contract, and
 * checked against it by this file's tests.
 */
export const numberRanges = {
  slotMinutes: { min: 5, max: 480, unit: 'minutes' },
  slotIntervalMinutes: { min: 5, max: 480, unit: 'minutes' },
  extraDurationMinutes: { min: 5, max: 480, unit: 'minutes' },
  bufferBeforeMinutes: { min: 0, max: 240, unit: 'minutes' },
  bufferAfterMinutes: { min: 0, max: 240, unit: 'minutes' },
  minNoticeMinutes: { min: 0, max: 2_147_483_647, unit: 'minutes' },
  maxDaysAhead: { min: 1, max: 730, unit: 'days' },
  maxPerDay: { min: 1, max: 1000, unit: 'count' },
  maxPerSlot: { min: 1, max: 1000, unit: 'count' },
  lookBusyPercent: { min: 0, max: 100, unit: 'percent' },
  rescheduleCutoffMinutes: { min: 0, max: 525_600, unit: 'minutes' },
  cancelCutoffMinutes: { min: 0, max: 525_600, unit: 'minutes' },
} as const satisfies Record<
  string,
  { min: number; max: number; unit: 'minutes' | 'days' | 'count' | 'percent' }
>;
export type NumberField = keyof typeof numberRanges;
export const isNumberField = (field: string): field is NumberField => field in numberRanges;

// The editor's sections.

export const sections = [
  { key: 'basic', advanced: false },
  { key: 'staff', advanced: false },
  { key: 'availability', advanced: false },
  { key: 'booking', advanced: false },
  { key: 'forms', advanced: true },
  { key: 'policies', advanced: true },
  { key: 'appearance', advanced: true },
] as const;
export type Section = (typeof sections)[number]['key'];

const fieldSections: Readonly<Record<string, Section>> = {
  name: 'basic',
  description: 'basic',
  bookingSlug: 'basic',
  groupId: 'basic',
  logoFileId: 'basic',
  inviteTitle: 'basic',
  timezone: 'basic',
  isActive: 'basic',
  kind: 'basic',
  members: 'staff',
  weeklyHours: 'availability',
  dateOverrides: 'availability',
  slotIntervalMinutes: 'booking',
  slotMinutes: 'booking',
  extraDurationMinutes: 'booking',
  minNoticeMinutes: 'booking',
  maxDaysAhead: 'booking',
  countAvailableDaysOnly: 'booking',
  bufferBeforeMinutes: 'booking',
  bufferAfterMinutes: 'booking',
  maxPerDay: 'booking',
  maxPerSlot: 'booking',
  lookBusyPercent: 'booking',
  consentEnabled: 'forms',
  consentText: 'forms',
  botProtection: 'forms',
  confirmationSenderId: 'policies',
  assignContactToMember: 'policies',
  skipAssignIfOwned: 'policies',
  allowReschedule: 'policies',
  rescheduleCutoffMinutes: 'policies',
  allowCancel: 'policies',
  cancelCutoffMinutes: 'policies',
  coverFileId: 'appearance',
  widgetStyle: 'appearance',
  primaryColor: 'appearance',
  backgroundColor: 'appearance',
  buttonText: 'appearance',
};

/** The section that shows a field of the contract; none for a field no section shows. */
export const sectionOfField = (field: string): Section | undefined => fieldSections[field];

/** The section an arrow key, Home or End moves to from one of the sections shown. */
export function sectionByKey(
  shown: readonly Section[],
  current: Section,
  key: string,
): Section | undefined {
  const index = shown.indexOf(current);
  const last = shown.length - 1;
  if (key === 'ArrowDown' || key === 'ArrowRight') return shown[index === last ? 0 : index + 1];
  if (key === 'ArrowUp' || key === 'ArrowLeft') return shown[index <= 0 ? last : index - 1];
  if (key === 'Home') return shown[0];
  if (key === 'End') return shown[last];
  return undefined;
}

// The list.

export const ALL = 'all';
export const ANYONE = 'anyone';
export const NO_GROUP = 'none';

export interface ListFilters {
  readonly q: string;
  readonly status: 'all' | 'active' | 'inactive';
  readonly kind: 'all' | CalendarKind;
  /** "all", "none" for the calendars in no group, or a group's id. */
  readonly group: string;
  /** "anyone", or a membership id. */
  readonly member: string;
}

export const noFilters: ListFilters = {
  q: '',
  status: ALL,
  kind: ALL,
  group: ALL,
  member: ANYONE,
};

/** What the list asks the server for: only the filters that are set. */
export function listQuery(
  filters: ListFilters,
  limit: number,
  after?: string,
): Partial<ListCalendarsQuery> & { limit: number } {
  const q = filters.q.trim();
  return {
    limit,
    ...(q === '' ? {} : { q }),
    ...(filters.status === ALL ? {} : { status: filters.status }),
    ...(filters.kind === ALL ? {} : { kind: filters.kind }),
    ...(filters.group === ALL ? {} : { group: filters.group }),
    ...(filters.member === ANYONE ? {} : { member: filters.member }),
    ...(after === undefined ? {} : { after }),
  };
}

export const calendarsKey = (businessId: string) => ['calendars', businessId] as const;
export const calendarKey = (businessId: string, id: string) =>
  ['calendar', businessId, id] as const;
export const calendarGroupsKey = (businessId: string) => ['calendar-groups', businessId] as const;
export const calendarPeopleKey = (businessId: string) => ['calendar-people', businessId] as const;
/** What a page leaves for the next to say once, such as "Calendar created." */
export const calendarNoticeKey = (businessId: string) => ['calendar-notice', businessId] as const;
/** What the "New calendar" modal hands the full editor when "Advanced settings" is pressed. */
export const calendarCarryKey = (businessId: string) => ['calendar-carry', businessId] as const;

const draftFields: Readonly<Partial<Record<keyof CalendarDraft, string>>> = {
  duration: 'slotMinutes',
  interval: 'slotIntervalMinutes',
  extraDurations: 'extraDurationMinutes',
  notice: 'minNoticeMinutes',
  dateRange: 'maxDaysAhead',
  bufferBefore: 'bufferBeforeMinutes',
  bufferAfter: 'bufferAfterMinutes',
  lookBusy: 'lookBusyPercent',
  rescheduleCutoff: 'rescheduleCutoffMinutes',
  cancelCutoff: 'cancelCutoffMinutes',
};

/** The contract's field a part of the form is saved as: what a refusal of it is filed under. */
export const fieldOfDraft = (key: string): string => draftFields[key as keyof CalendarDraft] ?? key;

/** The problems left once some parts of the form were changed: theirs are forgotten. */
export function problemsAfter(
  problems: Readonly<Record<string, string>>,
  changed: Partial<CalendarDraft>,
): Record<string, string> {
  const cleared = new Set(Object.keys(changed).map(fieldOfDraft));
  return Object.fromEntries(Object.entries(problems).filter(([field]) => !cleared.has(field)));
}

/** The largest logo or cover, in megabytes, for the words beside the drop zone. */
export const imageMegabytes = String(CALENDAR_LIMITS.imageBytes / 1_000_000);
