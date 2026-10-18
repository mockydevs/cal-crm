// What a calendar's own settings decide about an appointment booked on it: what it is
// called, where it takes place, and whether the person who booked may still move or cancel
// it.
import { calendarMemberLocation } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import * as z from 'zod';

// A merge field is a dotted path; anything else in braces is left as written.
const MERGE_TOKEN = /\{\{\s*([a-z][a-z_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\s*\}\}/g;
const TITLE_MAX = 200;

/**
 * An appointment's title from the calendar's invite title, with the merge fields it knows
 * filled in. A field with nothing to say leaves nothing; a title left empty is the
 * calendar's own name.
 */
export function inviteTitleOf(
  template: string,
  values: Readonly<Record<string, string | undefined>>,
  calendarName: string,
): string {
  const filled = template
    .replace(MERGE_TOKEN, (_token, path: string) => values[path]?.trim() ?? '')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return (filled === '' ? calendarName : filled).slice(0, TITLE_MAX);
}

/** What a booking page knows of the person booking, by merge field. */
export function bookerValues(contact: {
  readonly firstName?: string | null | undefined;
  readonly lastName?: string | null | undefined;
  readonly email: string;
  readonly phone?: string | undefined;
}): Record<string, string | undefined> {
  const name = [contact.firstName, contact.lastName]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(' ');
  return {
    'contact.firstName': contact.firstName ?? undefined,
    'contact.lastName': contact.lastName ?? undefined,
    'contact.name': name === '' ? contact.email : name,
    'contact.email': contact.email,
    'contact.phone': contact.phone,
  };
}

const places = z.array(calendarMemberLocation).catch([]);

/**
 * Where the member meets on this calendar: the first of their places, or nowhere named. A
 * Google Meet counts only while the member's Google Calendar is connected with a linked
 * calendar, the only way a Meet is made. Otherwise the next of their places is given
 * instead, or none: never a "Google Meet" that no link will follow.
 */
export async function meetingPlaceOf(
  trx: DatabaseTransaction,
  businessId: string,
  calendarId: string,
  userId: string,
): Promise<string | null> {
  const member = await trx
    .selectFrom('calendar.calendar_members')
    .select('locations')
    .where('business_id', '=', businessId)
    .where('calendar_id', '=', calendarId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  const all = places.parse(member?.locations ?? []);
  if (!all.some((place) => place.kind === 'google_meet')) return all[0]?.value ?? null;
  const linked = await trx
    .selectFrom('calendar.google_connections')
    .select('id')
    .where('business_id', '=', businessId)
    .where('user_id', '=', userId)
    .where('status', '=', 'connected')
    .where('write_calendar_id', 'is not', null)
    .executeTakeFirst();
  const usable = linked === undefined ? all.filter((place) => place.kind !== 'google_meet') : all;
  return usable[0]?.value ?? null;
}

const wordsFor = (minutes: number): string => {
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day' : `${String(minutes / 1440)} days`;
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${String(minutes / 60)} hours`;
  return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
};

/**
 * Why the person who booked may not move or cancel the appointment now, if the calendar
 * says so: it does not allow it at all, or its link stopped working some time before the
 * meeting. Nothing when they may.
 */
export function policyRefusal(
  policy: { readonly allowed: boolean; readonly cutoffMinutes: number | null },
  action: 'reschedule' | 'cancel',
  startsAt: Date,
  now: Date,
): string | undefined {
  const doing = action === 'reschedule' ? 'rescheduled' : 'cancelled';
  if (!policy.allowed)
    return `This appointment can't be ${doing} online. Contact the business instead.`;
  if (
    policy.cutoffMinutes !== null &&
    now.getTime() > startsAt.getTime() - policy.cutoffMinutes * 60_000
  )
    return `This appointment can no longer be ${doing} online: that was possible until ${wordsFor(policy.cutoffMinutes)} before it. Contact the business instead.`;
  return undefined;
}
