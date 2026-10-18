// A contact's time zone and do-not-contact setting, as the contact page reads and changes
// them through the contact's own endpoints (crm's contact-settings.ts). No React here:
// what the server showed, the time zones the picker offers and how typing finds one, and
// what a change must carry. The server decides in the end: it checks the time zone against
// its own list and the reason against its own limits, and refuses a change based on
// settings someone else has since changed.
import { DO_NOT_CONTACT_REASON_MAX, DO_NOT_CONTACT_REASON_MIN } from '@repo/contracts';
import * as z from 'zod';

/** The reason's limits: the contact contract's own. */
export const REASON_MIN = DO_NOT_CONTACT_REASON_MIN;
export const REASON_MAX = DO_NOT_CONTACT_REASON_MAX;

const shown = z.object({
  timeZone: z.string().nullable(),
  doNotContact: z.boolean(),
  preferencesRevision: z.string().min(1),
});

/** The two settings and the revision a change to either must name. */
export type ContactPreferences = z.infer<typeof shown>;

/** The settings a contact shows, or nothing when what the server sent has none. */
export function preferencesOf(contact: unknown): ContactPreferences | undefined {
  const parsed = shown.safeParse(contact);
  return parsed.success ? parsed.data : undefined;
}

/** What a change to the settings sends with the contact's other fields left out. */
export interface PreferenceChange {
  readonly timeZone?: string | null;
  readonly doNotContact?: boolean;
  readonly doNotContactReason?: string;
  readonly preferencesRevision: string;
}

/**
 * The change that sets or removes the time zone, or nothing when it is already this. It
 * names the revision the form opened with, not the newest one, so a change made by someone
 * else while the form was open is refused instead of written over.
 */
export function timeZoneChange(
  opened: ContactPreferences,
  chosen: string | null,
): PreferenceChange | undefined {
  if (chosen === opened.timeZone) return undefined;
  return { timeZone: chosen, preferencesRevision: opened.preferencesRevision };
}

export type ReasonProblem = 'missing' | 'too_short' | 'too_long';

/** What is wrong with a reason as written, if anything. Spaces around it don't count. */
export function reasonProblem(reason: string): ReasonProblem | undefined {
  const length = reason.trim().length;
  if (length === 0) return 'missing';
  if (length < REASON_MIN) return 'too_short';
  if (length > REASON_MAX) return 'too_long';
  return undefined;
}

/** What stops a change to do not contact: its reason, or the missing confirmation. */
export type DoNotContactProblem = ReasonProblem | 'unconfirmed';

export type DoNotContactAnswer =
  { readonly change: PreferenceChange } | { readonly problem: DoNotContactProblem };

/**
 * The change that turns do not contact on or off, or what stops it: both ways need a
 * reason, and the person's confirmation that they mean it.
 */
export function doNotContactChange(
  opened: ContactPreferences,
  form: { readonly reason: string; readonly confirmed: boolean },
): DoNotContactAnswer {
  const problem = reasonProblem(form.reason);
  if (problem !== undefined) return { problem };
  if (!form.confirmed) return { problem: 'unconfirmed' };
  return {
    change: {
      doNotContact: !opened.doNotContact,
      doNotContactReason: form.reason.trim(),
      preferencesRevision: opened.preferencesRevision,
    },
  };
}

/** The name this browser files a zone under: the same for a place's old and new names. */
export function canonicalZone(name: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    // A zone the server has and this browser doesn't: it stands alone.
    return name;
  }
}

/** A zone the picker offers: the name it saves, and the zone's other names on the server. */
export interface ZoneChoice {
  readonly name: string;
  readonly aliases: readonly string[];
}

/** A Region/City name; Etc/GMT+3 and its like are offsets under a place's form. */
const isPlace = (name: string): boolean => /^(?!Etc\/)[^/]+\//.test(name);

/**
 * What the picker offers, from the names the server takes: one entry for each zone, UTC
 * first. A server lists a place under every name it ever had (Asia/Calcutta and
 * Asia/Kolkata) and under names that aren't places (GB, EST, Etc/GMT+3). Names of one zone
 * become one entry, found by any of them, and saved as the contact's own name for it, else
 * the name this browser uses, else the first place name. Zones with no place name are left
 * out, except UTC and the contact's own.
 */
export function zoneChoices(
  listed: readonly string[],
  current: string | null,
  canonicalOf: (name: string) => string = canonicalZone,
  preferred: readonly string[] = Intl.supportedValuesOf('timeZone'),
): ZoneChoice[] {
  const zones = new Map<string, string[]>();
  for (const name of new Set([...listed, ...(current === null ? [] : [current])])) {
    const zone = canonicalOf(name);
    zones.set(zone, [...(zones.get(zone) ?? []), name]);
  }
  const choices: ZoneChoice[] = [];
  for (const names of zones.values()) {
    const sorted = [...names].sort((first, second) => first.localeCompare(second, 'en'));
    const name =
      sorted.find((each) => each === 'UTC') ??
      sorted.find((each) => each === current) ??
      sorted.find((each) => preferred.includes(each) && isPlace(each)) ??
      sorted.find(isPlace);
    if (name !== undefined) choices.push({ name, aliases: sorted.filter((each) => each !== name) });
  }
  const rank = (choice: ZoneChoice): number => (choice.name === 'UTC' ? 0 : 1);
  return choices.sort(
    (first, second) => rank(first) - rank(second) || first.name.localeCompare(second.name, 'en'),
  );
}

/** One zone in the picker. */
export interface ZoneOption {
  /** The name the server takes. */
  readonly value: string;
  /** The name with spaces for its underscores. */
  readonly label: string;
  /** Its offset now and what people call it, such as "GMT+3 · East Africa Time". */
  readonly detail?: string;
  /** The zone's other names, which also find it. */
  readonly keywords?: readonly string[];
}

function zonePart(
  name: string,
  locale: string,
  at: Date,
  style: 'shortOffset' | 'longGeneric',
): string | undefined {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: name, timeZoneName: style })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
  } catch {
    // A zone this browser doesn't know, or a style it can't write: the name still shows.
    return undefined;
  }
}

/** A zone as the picker lists it: its name, and its offset at `at` with its everyday name. */
export function zoneOption(choice: ZoneChoice, locale: string, at: Date): ZoneOption {
  const { name, aliases } = choice;
  const parts = [
    zonePart(name, locale, at, 'shortOffset'),
    zonePart(name, locale, at, 'longGeneric'),
  ].filter((part) => part !== undefined);
  // Some zones have no everyday name, and the browser repeats the offset for it.
  const detail = [...new Set(parts)].join(' · ');
  return {
    value: name,
    label: name.replaceAll('_', ' '),
    ...(detail === '' ? {} : { detail }),
    ...(aliases.length === 0 ? {} : { keywords: aliases }),
  };
}

/**
 * Whether a zone fits what is typed: every word typed is somewhere in its names or its
 * detail, in any order and any letter case. A name's parts count as words however they are
 * joined, so "new york" finds America/New_York. So do "nairobi", "east africa", "gmt+3",
 * and "kolkata" for a zone listed as Asia/Calcutta.
 */
export function zoneMatches(option: ZoneOption, typed: string): boolean {
  const text =
    `${option.value} ${(option.keywords ?? []).join(' ')} ${option.detail ?? ''}`.toLowerCase();
  return typed
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}
