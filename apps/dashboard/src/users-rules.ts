// What Settings → Users works out before it draws: what a row says, what the filter asks
// the server for, where the arrow keys take the form's tabs, whether the form may be saved
// and what it then sends, and a person's hours as the availability endpoints keep them, in
// minutes.
import {
  addUserInput,
  updateUserInput,
  USER_LIMITS,
  type CalendarUserAvailabilityProfile,
  type NoteDocument,
  type UserDetail,
  type UserList,
} from '@repo/contracts';
import type * as z from 'zod';
import { issuesOf, rejection } from './problems';

export type Role = UserList['roles'][number];

/** Everything the Users pages have read of a workspace: a change to one person stales it all. */
export const usersKey = (workspace: string) => ['users', workspace] as const;
/** What the Add and Edit pages leave for the list to say once, when they go back to it. */
export const usersNoticeKey = (workspace: string) => ['users-notice', workspace] as const;

/** A role's name inside the User type badge: "Account - admin". */
export const roleWord = (roleName: string): string => roleName.toLocaleLowerCase();

/** The Phone number cell: a dash for none, and the extension apart for the page to word. */
export function phoneWords(
  phone: string | null,
  extension: string | null,
): { readonly number: string; readonly extension: string | null } {
  return phone === null ? { number: '-', extension: null } : { number: phone, extension };
}

/** The User role filter's value for everyone. Never a role's id. */
export const ANY_ROLE = 'all';
export const AGENCY_TYPE = 'type:agency';
export const ACCOUNT_TYPE = 'type:account';

/** What the filter asks the list for: a kind of user, one role, or nothing. */
export function filterQuery(value: string): {
  readonly role?: string;
  readonly type?: 'agency' | 'account';
} {
  if (value === ANY_ROLE) return {};
  if (value === AGENCY_TYPE) return { type: 'agency' };
  if (value === ACCOUNT_TYPE) return { type: 'account' };
  return { role: value };
}

const isOwnerRole = (role: Role): boolean => role.isBuiltin && role.key === 'owner';

/** The roles a person can be given: ownership is never given here. */
export const assignableRoles = (roles: readonly Role[]): Role[] =>
  roles.filter((role) => !isOwnerRole(role));

/**
 * The role a new person starts with: everyday work, the built-in member, or else the role
 * allowing least. Never whichever sorts first, which is Admin.
 */
export function defaultRole(roles: readonly Role[]): Role | undefined {
  const offered = assignableRoles(roles);
  return (
    offered.find((role) => role.isBuiltin && role.key === 'member') ??
    offered.toSorted((one, other) => one.permissions.length - other.permissions.length)[0]
  );
}

export const userTabs = ['info', 'roles', 'calls', 'availability', 'calendars'] as const;
export type UserTab = (typeof userTabs)[number];

/** The tab after this one, for Next; none after the last. */
export const tabAfter = (tab: UserTab): UserTab | undefined => userTabs[userTabs.indexOf(tab) + 1];

/** Where a key takes the tab list from a tab: round the ends, as a tab list does. */
export function tabByKey(tab: UserTab, key: string): UserTab | undefined {
  const at = userTabs.indexOf(tab);
  const count = userTabs.length;
  if (key === 'ArrowDown' || key === 'ArrowRight') return userTabs[(at + 1) % count];
  if (key === 'ArrowUp' || key === 'ArrowLeft') return userTabs[(at + count - 1) % count];
  if (key === 'Home') return userTabs[0];
  if (key === 'End') return userTabs[count - 1];
  return undefined;
}

/** A phone as the form holds it: E.164 or nothing, and whether what is typed is a number. */
export interface PhoneDraft {
  readonly value: string | null;
  readonly valid: boolean;
}

/** A signature as the form holds it: a document or nothing, and whether the editor's text fits one. */
export interface SignatureDraft {
  readonly document: NoteDocument | null;
  readonly valid: boolean;
}

export interface UserDraft {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: PhoneDraft;
  readonly extension: string;
  readonly avatarFileId: string | null;
  readonly roleId: string;
  readonly calendarId: string | null;
  readonly signatureEnabled: boolean;
  readonly signature: SignatureDraft;
}

/** The form as it opens: the person being edited, or nobody yet with the role given. */
export function draftOf(user: UserDetail | undefined, roleId: string): UserDraft {
  return {
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    email: user?.email ?? '',
    phone: { value: user?.phone ?? null, valid: true },
    extension: user?.extension ?? '',
    avatarFileId: user?.avatarFileId ?? null,
    roleId: user?.roleId ?? roleId,
    calendarId: user?.calendarId ?? null,
    signatureEnabled: user?.signature.enabled ?? false,
    signature: { document: user?.signature.document ?? null, valid: true },
  };
}

/** The form's fields that are on the User info tab; the role is on its own. */
export const infoFields = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'extension',
  'avatarFileId',
  'calendarId',
  'signature',
] as const;

export type CheckedDraft =
  | { readonly ok: true; readonly mode: 'add'; readonly body: z.output<typeof addUserInput> }
  | { readonly ok: true; readonly mode: 'edit'; readonly body: z.output<typeof updateUserInput> }
  | { readonly ok: false; readonly fields: Record<string, string> };

/**
 * Whether the form may be saved, and what it sends. The API's own schema checks it, so the
 * messages are the server's; what only the form knows (a number that is not one, an empty
 * address, a signature too long for a document) is said in the words it is given.
 */
export function checkDraft(
  draft: UserDraft,
  mode: 'add' | 'edit',
  words: { readonly email: string; readonly phone: string; readonly signature: string },
): CheckedDraft {
  const extension = draft.extension.trim();
  const details = {
    firstName: draft.firstName,
    lastName: draft.lastName,
    phone: draft.phone.value,
    extension: extension === '' ? null : extension,
    avatarFileId: draft.avatarFileId,
    roleId: draft.roleId,
    calendarId: draft.calendarId,
    signature: { enabled: draft.signatureEnabled, document: draft.signature.document },
  };
  const local: Record<string, string> = {};
  if (mode === 'add' && draft.email.trim() === '') local['email'] = words.email;
  if (!draft.phone.valid) local['phone'] = words.phone;
  if (!draft.signature.valid) local['signature'] = words.signature;
  const parsed =
    mode === 'add'
      ? addUserInput.safeParse({ email: draft.email, ...details })
      : updateUserInput.safeParse(details);
  const fields = {
    ...(parsed.success ? {} : rejection(issuesOf(parsed.error)).fields),
    ...local,
  };
  // A number that is not one explains itself; "give a number for the extension" would not.
  if (local['phone'] !== undefined && extension !== '' && /^[0-9]{1,10}$/.test(extension))
    delete fields['extension'];
  if (!parsed.success || Object.keys(fields).length > 0) return { ok: false, fields };
  return mode === 'add'
    ? { ok: true, mode, body: addUserInput.parse({ email: draft.email, ...details }) }
    : { ok: true, mode, body: parsed.data };
}

const avatarTypes: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** What a file input offers for a profile image. */
export const avatarAccept = avatarTypes.join(',');

/** Why a chosen file cannot be a profile image, before it is sent: its type, or its size. */
export function avatarProblem(file: {
  readonly type: string;
  readonly size: number;
}): 'type' | 'size' | undefined {
  if (!avatarTypes.includes(file.type)) return 'type';
  return file.size > USER_LIMITS.avatarBytes ? 'size' : undefined;
}

/** The end of the day: a time input cannot hold it, so the form has a box for it. */
export const MIDNIGHT = '24:00';

/** Minutes from midnight as a clock time, such as 545 as 09:05. */
export function clockOf(minute: number): string {
  const hours = String(Math.floor(minute / 60)).padStart(2, '0');
  return `${hours}:${String(minute % 60).padStart(2, '0')}`;
}

/** A clock time as minutes from midnight; none for a time not filled in. */
export function minuteOf(clock: string): number | undefined {
  const found = /^(\d{2}):(\d{2})$/.exec(clock);
  return found === null ? undefined : Number(found[1]) * 60 + Number(found[2]);
}

export interface HoursDraft {
  readonly key: string;
  readonly weekday: number;
  readonly startTime: string;
  readonly endTime: string;
}

export interface AvailabilityDraft {
  readonly timezone: string;
  readonly inheritCalendarHours: boolean;
  readonly weeklyHours: readonly HoursDraft[];
  /** Listed, not edited here: sent back as they were read. */
  readonly dateOverrides: CalendarUserAvailabilityProfile['dateOverrides'];
}

/**
 * A person's schedule as the form holds it. Someone with none stored follows each
 * calendar's hours, which is what the form then starts on, in the time zone given.
 */
export function availabilityDraft(
  profile: CalendarUserAvailabilityProfile | null,
  timezone: string,
): AvailabilityDraft {
  return {
    timezone: profile?.timezone ?? timezone,
    inheritCalendarHours: profile?.inheritCalendarHours ?? true,
    weeklyHours: (profile?.weeklyHours ?? []).map((hours) => ({
      key: crypto.randomUUID(),
      weekday: hours.weekday,
      startTime: clockOf(hours.startMinute),
      endTime: clockOf(hours.endMinute),
    })),
    dateOverrides: profile?.dateOverrides ?? [],
  };
}

/** The schedule to save, in minutes; not ok while any hours lack a time or end too early. */
export function availabilityProfile(
  draft: AvailabilityDraft,
):
  | { readonly ok: true; readonly profile: CalendarUserAvailabilityProfile }
  | { readonly ok: false } {
  const weeklyHours: CalendarUserAvailabilityProfile['weeklyHours'] = [];
  for (const hours of draft.weeklyHours) {
    const startMinute = minuteOf(hours.startTime);
    const endMinute = minuteOf(hours.endTime);
    if (startMinute === undefined || endMinute === undefined || endMinute <= startMinute)
      return { ok: false };
    weeklyHours.push({ weekday: hours.weekday, startMinute, endMinute });
  }
  return {
    ok: true,
    profile: {
      timezone: draft.timezone,
      inheritCalendarHours: draft.inheritCalendarHours,
      weeklyHours,
      dateOverrides: draft.dateOverrides,
    },
  };
}
