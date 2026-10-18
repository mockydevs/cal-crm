// A contact's time zone and do-not-contact flag, changed through the contact command
// (crm.contacts.timezone and do_not_contact). Sending reads both: with quiet hours on it
// refuses a contact whose time zone PostgreSQL doesn't list under exactly the stored name,
// and it refuses a contact marked do not contact on every channel. So a time zone is stored
// only as PostgreSQL itself spells it.
import { createHash } from 'node:crypto';
import type { CommandContext } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  isTimeZone,
  NotFoundError,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { sql } from 'kysely';

/** The two values, as the API names them. */
export interface ContactPreferenceValues {
  readonly timeZone: string | null;
  readonly doNotContact: boolean;
}

/** What a contact shows of them: the values and the revision a change must name. */
export interface ContactPreferences extends ContactPreferenceValues {
  readonly preferencesRevision: string;
}

/** The contact's row, as far as these settings go. Lock it before changing them. */
export interface ContactPreferenceRow {
  readonly id: string;
  readonly timezone: string | null;
  readonly do_not_contact: boolean;
}

/** The part of a contact change that is about these settings; the contract checked it. */
export interface ContactPreferenceChange {
  readonly timeZone?: string | null | undefined;
  readonly doNotContact?: boolean | undefined;
  readonly preferencesRevision?: string | undefined;
}

/** Names the values a change was based on, so a change over someone else's is refused. */
export function preferencesRevisionOf(values: ContactPreferenceValues): string {
  return createHash('sha256')
    .update(JSON.stringify([values.timeZone, values.doNotContact]))
    .digest('hex');
}

/** The settings of a stored contact, as the API shows them. */
export function preferencesOf(
  row: Pick<ContactPreferenceRow, 'timezone' | 'do_not_contact'>,
): ContactPreferences {
  const values = { timeZone: row.timezone, doNotContact: row.do_not_contact };
  return { ...values, preferencesRevision: preferencesRevisionOf(values) };
}

const unknownTimeZone = (): ValidationError =>
  new ValidationError([
    {
      path: '/timeZone',
      code: 'time_zone_unknown',
      message: "This isn't a time zone this server knows, such as Africa/Nairobi.",
    },
  ]);

/** The zones a server takes: PostgreSQL's names that the app can use, and how to find one. */
interface TimeZones {
  /** In order, as the API lists them. */
  readonly names: readonly string[];
  readonly byLowerCase: ReadonlyMap<string, string>;
  /** By the name ICU files a zone under, which is the same for a zone's old and new names. */
  readonly byCanonical: ReadonlyMap<string, readonly string[]>;
}

/** Reads the zones this server takes; see timeZoneReader. */
export type TimeZoneReader = (trx: DatabaseTransaction) => Promise<TimeZones>;

const canonicalOf = (name: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;

/** A region zone (Area/Place) or UTC: the only names a contact's time zone may be. */
const isRegionZone = (name: string): boolean => name.includes('/') || name === 'UTC';

/**
 * A reader of pg_timezone_names that keeps what it read for a while: the list changes only
 * when PostgreSQL's time zone data does, and reading it means PostgreSQL opening every
 * zone's file. Names the app's own check refuses, such as posixrules, are left out, and so
 * is every name that is not a region zone or UTC: EST, MST or EST5EDT is a fixed offset or
 * an old rule, not a place.
 */
export function timeZoneReader(keepMs = 3_600_000, now: () => number = Date.now): TimeZoneReader {
  let kept: { readonly until: number; readonly zones: TimeZones } | undefined;
  return async (trx) => {
    if (kept !== undefined && now() < kept.until) return kept.zones;
    const { rows } = await sql<{
      name: string;
    }>`select name from pg_catalog.pg_timezone_names`.execute(trx);
    const names = rows
      .map((row) => row.name)
      .filter((name) => isTimeZone(name) && isRegionZone(name))
      .sort();
    const byCanonical = new Map<string, string[]>();
    for (const name of names) {
      const canonical = canonicalOf(name);
      byCanonical.set(canonical, [...(byCanonical.get(canonical) ?? []), name]);
    }
    const zones = {
      names,
      byLowerCase: new Map(names.map((name) => [name.toLowerCase(), name])),
      byCanonical,
    };
    kept = { until: now() + keepMs, zones };
    return zones;
  };
}

const serverTimeZones = timeZoneReader();

/** The time zone names a contact can have on this server, in order. */
export async function readTimeZones(
  trx: DatabaseTransaction,
  zones: TimeZoneReader = serverTimeZones,
): Promise<readonly string[]> {
  return (await zones(trx)).names;
}

/**
 * US abbreviations and names people write for a time zone, as the region zone they mean.
 * An abbreviation is a fixed offset in PostgreSQL (EST is UTC-5 all year), so kept as it
 * is it would put quiet hours an hour off all summer (TCPA, 47 CFR 64.1200(c)(1): 8 a.m. to
 * 9 p.m. at the called party's location).
 */
const US_ZONE_NAMES: Readonly<Record<string, string>> = {
  EST: 'America/New_York',
  EDT: 'America/New_York',
  EASTERN: 'America/New_York',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  CENTRAL: 'America/Chicago',
  MDT: 'America/Denver',
  MOUNTAIN: 'America/Denver',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  PACIFIC: 'America/Los_Angeles',
  AKST: 'America/Anchorage',
  AKDT: 'America/Anchorage',
  ALASKA: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  HAWAII: 'Pacific/Honolulu',
};

/**
 * The time zone as PostgreSQL spells it, or undefined when this server has no such zone.
 * The name must pass the app's own check (an IANA name, no fixed offset) and be one
 * PostgreSQL lists: sending matches the stored value against pg_timezone_names exactly, so
 * a name in another letter case would count as no time zone at all. A listed alias is kept
 * as given. A place name PostgreSQL doesn't list becomes the listed name of the same zone:
 * browsers still say Asia/Calcutta, and a server may list only Asia/Kolkata. Abbreviations
 * such as EAT, which Intl takes, are not zones here: only a region zone or UTC is, and the
 * US names above become theirs.
 */
export async function findTimeZone(
  trx: DatabaseTransaction,
  value: string,
  zones: TimeZoneReader = serverTimeZones,
): Promise<string | undefined> {
  const trimmed = value.trim();
  // A US abbreviation or name means a region zone with its summer time; one that names
  // no single zone (MST: Denver keeps summer time, Phoenix does not) is refused.
  const candidate = US_ZONE_NAMES[trimmed.toUpperCase()] ?? trimmed;
  if (!candidate.includes('/') && candidate.toUpperCase() !== 'UTC') return undefined;
  if (!isTimeZone(candidate)) return undefined;
  const { byLowerCase, byCanonical } = await zones(trx);
  const listed = byLowerCase.get(candidate.toLowerCase());
  if (listed !== undefined || !candidate.includes('/')) return listed;
  const canonical = canonicalOf(candidate);
  const same = byCanonical.get(canonical) ?? [];
  return same.includes(canonical) ? canonical : same[0];
}

/** The time zone as PostgreSQL spells it (findTimeZone), or a refusal on the field. */
export async function resolveTimeZone(
  trx: DatabaseTransaction,
  value: string,
  zones: TimeZoneReader = serverTimeZones,
): Promise<string> {
  const zone = await findTimeZone(trx, value, zones);
  if (zone === undefined) throw unknownTimeZone();
  return zone;
}

/**
 * Applies the time zone and do-not-contact part of a contact change to a locked, live
 * contact, and gives the fields to list in the command's contact.updated event: timeZone
 * when it changed, never its value. A change to do not contact is reported here, as its
 * own event on the contact's timeline, and is not in that list.
 *
 * A change based on values someone else has since changed is refused and changes nothing.
 * The reason for a do-not-contact change is part of the command's input, which the audit
 * log keeps with the actor; it goes into no event, since events can't be erased.
 *
 * It takes no lock beyond the contact's row. Queueing a message holds the business's row
 * while it waits for the contact's, so taking the business's here could deadlock; the send
 * check reads the committed flag, so a message checked after this commits is refused.
 */
export async function changeContactPreferences(
  trx: DatabaseTransaction,
  command: CommandContext,
  businessId: string,
  row: ContactPreferenceRow,
  change: ContactPreferenceChange,
): Promise<string[]> {
  if (change.timeZone === undefined && change.doNotContact === undefined) return [];
  if (preferencesRevisionOf(preferencesOf(row)) !== change.preferencesRevision)
    throw new ConflictError(
      "This contact's time zone or do not contact setting changed after you opened it. Reload the page and try again.",
    );
  const timeZone =
    change.timeZone === undefined || change.timeZone === null
      ? change.timeZone
      : await resolveTimeZone(trx, change.timeZone);
  const zoneChanged = timeZone !== undefined && timeZone !== row.timezone;
  const flagChanged =
    change.doNotContact !== undefined && change.doNotContact !== row.do_not_contact;
  if (!zoneChanged && !flagChanged) return [];
  const { numUpdatedRows } = await trx
    .updateTable('crm.contacts')
    .set({
      ...(zoneChanged ? { timezone: timeZone } : {}),
      ...(flagChanged ? { do_not_contact: change.doNotContact } : {}),
    })
    .where('business_id', '=', businessId)
    .where('id', '=', row.id)
    .executeTakeFirst();
  // The row was handed over as this business's, locked. If it isn't, nothing was written,
  // and saying that do not contact changed would be a lie on the contact's timeline.
  if (numUpdatedRows !== 1n) throw new NotFoundError('Contact', toPublicId('contact', row.id));
  if (flagChanged)
    await command.emit({
      type: change.doNotContact ? 'contact.do_not_contact_set' : 'contact.do_not_contact_cleared',
      subject: { kind: 'contact', id: row.id },
      records: [row.id],
    });
  return zoneChanged ? ['timeZone'] : [];
}
