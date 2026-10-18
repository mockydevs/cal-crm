import { expect, it } from 'vitest';
import * as z from 'zod';
import {
  contactPreferenceChanges,
  contactPreferences,
  contactPreferencesInput,
  DO_NOT_CONTACT_REASON_MAX,
  DO_NOT_CONTACT_REASON_MIN,
  listTimeZones,
  refineContactPreferences,
  timeZoneList,
} from './contact-preferences.js';
import { parseInput } from './validation.js';

const revision = 'a'.repeat(64);
const reason = 'Asked by phone not to be contacted again.';

const issuesOf = (input: unknown): { path: string; code: string }[] => {
  try {
    parseInput(contactPreferencesInput, input);
    return [];
  } catch (error) {
    return z
      .object({ issues: z.array(z.object({ path: z.string(), code: z.string() })) })
      .parse(error)
      .issues.map(({ path, code }) => ({ path, code }));
  }
};

it('takes a time zone by its IANA name in any case, trimmed, and null to clear it', () => {
  for (const timeZone of [
    'Africa/Nairobi',
    'africa/nairobi',
    'Asia/Calcutta',
    'Asia/Kolkata',
    'UTC',
    'Etc/UTC',
    'America/New_York',
    'America/Argentina/ComodRivadavia',
    'US/Eastern',
  ])
    expect(
      contactPreferencesInput.parse({ timeZone, preferencesRevision: revision }).timeZone,
      timeZone,
    ).toBe(timeZone);
  expect(
    contactPreferencesInput.parse({ timeZone: '  Africa/Nairobi ', preferencesRevision: revision })
      .timeZone,
  ).toBe('Africa/Nairobi');
  expect(
    contactPreferencesInput.parse({ timeZone: null, preferencesRevision: revision }).timeZone,
  ).toBeNull();
});

it('refuses what is not a time zone name: offsets, blanks, spaces and other types', () => {
  for (const timeZone of [
    '',
    '   ',
    '+03:00',
    '-05:00',
    'UTC+3',
    'GMT+3',
    'America/New York',
    'Nairobi',
    'x'.repeat(65),
    3,
    true,
  ])
    expect(issuesOf({ timeZone, preferencesRevision: revision }), String(timeZone)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/timeZone' })]),
    );
});

it('says what a time zone looks like when the value is not one', () => {
  expect(() =>
    parseInput(contactPreferencesInput, { timeZone: '+03:00', preferencesRevision: revision }),
  ).toThrow(
    expect.objectContaining({
      issues: [
        expect.objectContaining({
          path: '/timeZone',
          message: "This isn't a time zone, such as Africa/Nairobi.",
        }),
      ],
    }),
  );
});

it('needs the revision with a change to the time zone or to do not contact', () => {
  expect(issuesOf({ timeZone: 'UTC' })).toEqual([
    { path: '/preferencesRevision', code: 'revision_required' },
  ]);
  expect(issuesOf({ timeZone: null })).toEqual([
    { path: '/preferencesRevision', code: 'revision_required' },
  ]);
  expect(issuesOf({ doNotContact: false, doNotContactReason: reason })).toEqual([
    { path: '/preferencesRevision', code: 'revision_required' },
  ]);
  for (const preferencesRevision of ['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)])
    expect(issuesOf({ timeZone: 'UTC', preferencesRevision })).toEqual([
      expect.objectContaining({ path: '/preferencesRevision' }),
    ]);
  // Nothing of these is sent: nothing is asked for.
  expect(issuesOf({})).toEqual([]);
  expect(issuesOf({ preferencesRevision: revision })).toEqual([]);
});

it('needs a reason to turn do not contact on, and to turn it off', () => {
  for (const doNotContact of [true, false]) {
    expect(issuesOf({ doNotContact, preferencesRevision: revision })).toEqual([
      { path: '/doNotContactReason', code: 'reason_required' },
    ]);
    expect(
      contactPreferencesInput.parse({
        doNotContact,
        doNotContactReason: `  ${reason} `,
        preferencesRevision: revision,
      }),
    ).toEqual({ doNotContact, doNotContactReason: reason, preferencesRevision: revision });
  }
  for (const doNotContactReason of ['', '   ', 'x'.repeat(DO_NOT_CONTACT_REASON_MIN - 1)])
    expect(
      issuesOf({ doNotContact: true, doNotContactReason, preferencesRevision: revision }),
      doNotContactReason,
    ).toEqual([expect.objectContaining({ path: '/doNotContactReason' })]);
  for (const length of [DO_NOT_CONTACT_REASON_MIN, DO_NOT_CONTACT_REASON_MAX])
    expect(
      issuesOf({
        doNotContact: true,
        doNotContactReason: 'x'.repeat(length),
        preferencesRevision: revision,
      }),
    ).toEqual([]);
  expect(
    issuesOf({
      doNotContact: true,
      doNotContactReason: 'x'.repeat(DO_NOT_CONTACT_REASON_MAX + 1),
      preferencesRevision: revision,
    }),
  ).toEqual([expect.objectContaining({ path: '/doNotContactReason' })]);
});

it('refuses a reason that comes with no change to do not contact', () => {
  expect(
    issuesOf({ timeZone: 'UTC', doNotContactReason: reason, preferencesRevision: revision }),
  ).toEqual([{ path: '/doNotContactReason', code: 'reason_unexpected' }]);
});

it('refuses a do not contact that is not true or false, and fields it does not know', () => {
  for (const doNotContact of ['true', 1, null])
    expect(
      issuesOf({ doNotContact, doNotContactReason: reason, preferencesRevision: revision }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/doNotContact' })]));
  expect(issuesOf({ timezone: 'UTC' })).toEqual([{ path: '/timezone', code: 'unrecognized_keys' }]);
});

it('fits into a larger change: the shape and the rule work on any object that has them', () => {
  const change = z
    .strictObject({ firstName: z.string().optional(), ...contactPreferenceChanges })
    .superRefine(refineContactPreferences);
  expect(change.parse({ firstName: 'Maya' })).toEqual({ firstName: 'Maya' });
  expect(change.safeParse({ firstName: 'Maya', timeZone: 'UTC' }).success).toBe(false);
  expect(
    change.parse({ firstName: 'Maya', timeZone: 'UTC', preferencesRevision: revision }),
  ).toEqual({ firstName: 'Maya', timeZone: 'UTC', preferencesRevision: revision });
});

it('shows the time zone, the flag and the revision on a contact', () => {
  const shown = z.looseObject(contactPreferences);
  expect(
    shown.parse({ timeZone: null, doNotContact: false, preferencesRevision: revision }),
  ).toEqual({ timeZone: null, doNotContact: false, preferencesRevision: revision });
  for (const missing of ['timeZone', 'doNotContact', 'preferencesRevision'])
    expect(
      shown.safeParse({
        timeZone: 'UTC',
        doNotContact: true,
        preferencesRevision: revision,
        [missing]: undefined,
      }).success,
      missing,
    ).toBe(false);
});

it('lists time zone names at GET /time-zones, for anyone in the business', () => {
  expect(listTimeZones).toMatchObject({ method: 'get', path: '/time-zones', group: 'Contacts' });
  expect(listTimeZones.response.schema).toBe(timeZoneList);
  expect(timeZoneList.parse({ items: ['Africa/Nairobi', 'UTC'] })).toEqual({
    items: ['Africa/Nairobi', 'UTC'],
  });
  expect(timeZoneList.safeParse({ items: [3] }).success).toBe(false);
  expect(timeZoneList.safeParse({}).success).toBe(false);
});
