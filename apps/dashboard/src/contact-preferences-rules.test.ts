import { describe, expect, it } from 'vitest';
import {
  canonicalZone,
  doNotContactChange,
  preferencesOf,
  REASON_MAX,
  REASON_MIN,
  reasonProblem,
  timeZoneChange,
  zoneChoices,
  zoneMatches,
  zoneOption,
  type ContactPreferences,
  type ZoneChoice,
} from './contact-preferences-rules';

const revision = 'a'.repeat(64);
const opened = (patch: Partial<ContactPreferences> = {}): ContactPreferences => ({
  timeZone: null,
  doNotContact: false,
  preferencesRevision: revision,
  ...patch,
});

describe('what a contact shows', () => {
  it('reads the two settings and their revision from a contact, whatever else it has', () => {
    expect(
      preferencesOf({
        id: 'con_01m4bd188ff82s0add91b7pz63',
        firstName: 'Maya',
        timeZone: 'Africa/Nairobi',
        doNotContact: true,
        preferencesRevision: revision,
      }),
    ).toEqual({ timeZone: 'Africa/Nairobi', doNotContact: true, preferencesRevision: revision });
    expect(preferencesOf(opened())).toEqual(opened());
  });

  it.each([
    ['a contact from a server that has no such settings', { id: 'con_1', firstName: 'Maya' }],
    ['no time zone field', { doNotContact: false, preferencesRevision: revision }],
    ['a time zone that is not text', { ...opened(), timeZone: 3 }],
    ['a flag that is not true or false', { ...opened(), doNotContact: 'no' }],
    ['an empty revision', { ...opened(), preferencesRevision: '' }],
    ['nothing', undefined],
    ['null', null],
  ])('reads nothing from %s', (_label, contact) => {
    expect(preferencesOf(contact)).toBeUndefined();
  });
});

describe('a change to the time zone', () => {
  it('names the revision the form opened with, and sends null to remove it', () => {
    expect(timeZoneChange(opened(), 'Africa/Nairobi')).toEqual({
      timeZone: 'Africa/Nairobi',
      preferencesRevision: revision,
    });
    expect(timeZoneChange(opened({ timeZone: 'Africa/Nairobi' }), null)).toEqual({
      timeZone: null,
      preferencesRevision: revision,
    });
    expect(timeZoneChange(opened({ timeZone: 'UTC' }), 'Etc/UTC')).toMatchObject({
      timeZone: 'Etc/UTC',
    });
  });

  it('is nothing when the zone is already that one, or still none', () => {
    expect(timeZoneChange(opened(), null)).toBeUndefined();
    expect(timeZoneChange(opened({ timeZone: 'UTC' }), 'UTC')).toBeUndefined();
  });

  it('never carries do not contact or a reason', () => {
    expect(Object.keys(timeZoneChange(opened({ doNotContact: true }), 'UTC') ?? {})).toEqual([
      'timeZone',
      'preferencesRevision',
    ]);
  });
});

describe('a reason', () => {
  it.each([
    ['', 'missing'],
    ['   \n ', 'missing'],
    ['x'.repeat(REASON_MIN - 1), 'too_short'],
    [`  ${'x'.repeat(REASON_MIN - 1)}  `, 'too_short'],
    ['x'.repeat(REASON_MAX + 1), 'too_long'],
  ] as const)('%j is refused as %s', (reason, problem) => {
    expect(reasonProblem(reason)).toBe(problem);
  });

  it('is taken at both limits, not counting the spaces around it', () => {
    expect(reasonProblem('x'.repeat(REASON_MIN))).toBeUndefined();
    expect(reasonProblem('x'.repeat(REASON_MAX))).toBeUndefined();
    expect(reasonProblem(` ${'x'.repeat(REASON_MAX)} `)).toBeUndefined();
    expect([REASON_MIN, REASON_MAX]).toEqual([10, 1000]);
  });
});

describe('a change to do not contact', () => {
  const reason = 'Asked by phone to stop.';

  it('turns it the other way, with the reason trimmed and the revision the form opened with', () => {
    expect(doNotContactChange(opened(), { reason: `  ${reason}\n`, confirmed: true })).toEqual({
      change: { doNotContact: true, doNotContactReason: reason, preferencesRevision: revision },
    });
    expect(
      doNotContactChange(opened({ doNotContact: true, timeZone: 'UTC' }), {
        reason,
        confirmed: true,
      }),
    ).toEqual({
      change: { doNotContact: false, doNotContactReason: reason, preferencesRevision: revision },
    });
  });

  it.each([true, false])('needs a reason when do not contact is %j', (doNotContact) => {
    expect(doNotContactChange(opened({ doNotContact }), { reason: ' ', confirmed: true })).toEqual({
      problem: 'missing',
    });
    expect(
      doNotContactChange(opened({ doNotContact }), { reason: 'too short', confirmed: true }),
    ).toEqual({ problem: 'too_short' });
  });

  it.each([true, false])('needs the confirmation when do not contact is %j', (doNotContact) => {
    expect(doNotContactChange(opened({ doNotContact }), { reason, confirmed: false })).toEqual({
      problem: 'unconfirmed',
    });
  });

  it('names the missing reason before the missing confirmation', () => {
    expect(doNotContactChange(opened(), { reason: '', confirmed: false })).toEqual({
      problem: 'missing',
    });
  });
});

// A server's list as Debian 12 has it: places under old and new names, and names that
// aren't places. ICU files India under one of its two names, whichever build this is.
const server = [
  'Africa/Nairobi',
  'America/New_York',
  'Asia/Calcutta',
  'Asia/Kolkata',
  'EST',
  'Etc/GMT+3',
  'Etc/UTC',
  'Europe/Belfast',
  'Europe/London',
  'GB',
  'US/Eastern',
  'UTC',
];
const india = canonicalZone('Asia/Kolkata');
const otherIndia = india === 'Asia/Kolkata' ? 'Asia/Calcutta' : 'Asia/Kolkata';

describe('the zones the picker offers', () => {
  it('files a place under one name, whichever of its names it is given', () => {
    expect(['Asia/Calcutta', 'Asia/Kolkata']).toContain(india);
    expect(canonicalZone('Asia/Calcutta')).toBe(india);
    expect(canonicalZone('asia/kolkata')).toBe(india);
    expect(canonicalZone('Europe/Belfast')).toBe(canonicalZone('GB'));
    expect(canonicalZone('Africa/Nairobi')).not.toBe(india);
    // A zone the server has and this browser doesn't stands alone.
    expect(canonicalZone('Europe/Atlantis')).toBe('Europe/Atlantis');
  });

  it('offers each zone once, UTC first, under the name this browser uses, found by its others', () => {
    expect(zoneChoices(server, null)).toEqual([
      { name: 'UTC', aliases: ['Etc/UTC'] },
      { name: 'Africa/Nairobi', aliases: [] },
      { name: 'America/New_York', aliases: ['US/Eastern'] },
      { name: india, aliases: [otherIndia] },
      { name: 'Europe/London', aliases: ['Europe/Belfast', 'GB'] },
    ]);
  });

  it('offers the name the server has when it lacks the one this browser uses', () => {
    // A server without the older names, as Debian ships them from version 13.
    const lean = ['Africa/Nairobi', 'Asia/Kolkata', 'Europe/Kyiv', 'UTC'];
    expect(zoneChoices(lean, null).map((choice) => choice.name)).toEqual([
      'UTC',
      'Africa/Nairobi',
      'Asia/Kolkata',
      'Europe/Kyiv',
    ]);
  });

  it("keeps the contact's own name for its zone, even one that is not a place or not listed", () => {
    expect(zoneChoices(server, otherIndia)).toContainEqual({ name: otherIndia, aliases: [india] });
    expect(zoneChoices(server, 'GB')).toContainEqual({
      name: 'GB',
      aliases: ['Europe/Belfast', 'Europe/London'],
    });
    expect(zoneChoices(server, 'Etc/GMT+3')).toContainEqual({ name: 'Etc/GMT+3', aliases: [] });
    expect(zoneChoices(['UTC'], 'Africa/Nairobi')).toEqual([
      { name: 'UTC', aliases: [] },
      { name: 'Africa/Nairobi', aliases: [] },
    ]);
  });

  it('leaves out zones with no place name, and never offers what the server does not list', () => {
    const names = zoneChoices(server, null).map((choice) => choice.name);
    expect(names).not.toContain('EST');
    expect(names).not.toContain('Etc/GMT+3');
    const offered = zoneChoices(server, null).flatMap((choice) => [choice.name, ...choice.aliases]);
    expect(offered.every((name) => server.includes(name))).toBe(true);
  });

  it('uses the rule it is given for which names are one zone', () => {
    const byFirstPart = (name: string): string => name.split('/')[0] ?? name;
    expect(
      zoneChoices(['Asia/Kolkata', 'Asia/Tokyo', 'Europe/Paris'], null, byFirstPart, []),
    ).toEqual([
      { name: 'Asia/Kolkata', aliases: ['Asia/Tokyo'] },
      { name: 'Europe/Paris', aliases: [] },
    ]);
  });

  it('offers every place this runtime knows from a server that lists them all', () => {
    const everything = [...Intl.supportedValuesOf('timeZone'), 'UTC'];
    const choices = zoneChoices(everything, null);
    expect(choices.length).toBeGreaterThan(300);
    expect(choices[0]?.name).toBe('UTC');
    expect(new Set(choices.map((choice) => choice.name)).size).toBe(choices.length);
    expect(choices.map((choice) => choice.name)).toContain('Africa/Nairobi');
  });
});

describe('a zone in the picker', () => {
  // 15 January and 15 July 2026, at noon UTC: winter and summer in New York.
  const winter = new Date('2026-01-15T12:00:00.000Z');
  const summer = new Date('2026-07-15T12:00:00.000Z');
  const alone = (name: string): ZoneChoice => ({ name, aliases: [] });

  it('shows its name with spaces, its offset then, and what people call it', () => {
    expect(zoneOption(alone('Africa/Nairobi'), 'en', winter)).toEqual({
      value: 'Africa/Nairobi',
      label: 'Africa/Nairobi',
      detail: 'GMT+3 · East Africa Time',
    });
    expect(zoneOption({ name: 'America/New_York', aliases: ['US/Eastern'] }, 'en', winter)).toEqual(
      {
        value: 'America/New_York',
        label: 'America/New York',
        detail: 'GMT-5 · Eastern Time',
        keywords: ['US/Eastern'],
      },
    );
    expect(zoneOption(alone('America/New_York'), 'en', summer).detail).toBe('GMT-4 · Eastern Time');
  });

  it('shows the name alone for a zone this browser cannot place', () => {
    expect(zoneOption(alone('Europe/Atlantis'), 'en', winter)).toEqual({
      value: 'Europe/Atlantis',
      label: 'Europe/Atlantis',
    });
  });

  it('describes every zone it offers without failing', () => {
    const options = zoneChoices([...Intl.supportedValuesOf('timeZone'), 'UTC'], null).map(
      (choice) => zoneOption(choice, 'en', winter),
    );
    expect(options.every((option) => option.label !== '')).toBe(true);
    expect(options.filter((option) => option.detail === undefined)).toEqual([]);
  });
});

describe('finding a zone by typing', () => {
  const at = new Date('2026-01-15T12:00:00.000Z');
  const options = zoneChoices(
    [...Intl.supportedValuesOf('timeZone'), 'UTC', 'Asia/Kolkata', 'Asia/Calcutta'],
    null,
  ).map((choice) => zoneOption(choice, 'en', at));
  const found = (typed: string): string[] =>
    options.filter((option) => zoneMatches(option, typed)).map((option) => option.value);

  it('finds a city in any letter case, with or without its region', () => {
    expect(found('nairobi')).toEqual(['Africa/Nairobi']);
    expect(found('NAIROBI')).toEqual(['Africa/Nairobi']);
    expect(found('africa/nairobi')).toEqual(['Africa/Nairobi']);
    expect(found('  Africa   Nairobi ')).toEqual(['Africa/Nairobi']);
  });

  it('finds a name written with spaces or with underscores', () => {
    expect(found('new york')).toEqual(['America/New_York']);
    expect(found('new_york')).toEqual(['America/New_York']);
    expect(found('york new')).toEqual(['America/New_York']);
  });

  it('finds a place by a name it is not listed under', () => {
    expect(found('kolkata')).toEqual([india]);
    expect(found('calcutta')).toEqual([india]);
  });

  it('finds zones by what people call them and by their offset', () => {
    expect(found('east africa')).toContain('Africa/Nairobi');
    expect(found('gmt+3 africa')).toContain('Africa/Nairobi');
    expect(found('gmt+3 africa')).not.toContain('Africa/Lagos');
    expect(found('utc')[0]).toBe('UTC');
  });

  it('offers everything before anything is typed, and nothing for a place that is not there', () => {
    expect(found('')).toHaveLength(options.length);
    expect(found('   ')).toHaveLength(options.length);
    expect(found('atlantis')).toEqual([]);
    expect(found('nairobi atlantis')).toEqual([]);
  });

  it('narrows a few hundred zones to a handful within a few letters', () => {
    expect(options.length).toBeGreaterThan(300);
    expect(found('lond').length).toBeLessThanOrEqual(3);
    expect(found('kol').length).toBeLessThanOrEqual(5);
  });
});
