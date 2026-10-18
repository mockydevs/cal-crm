import { expect, it } from 'vitest';
import {
  calendarUserAvailabilityProfile,
  calendarUserAvailability,
  updateCalendarUserAvailabilityInput,
  calendarUserAvailabilityEndpoints,
} from './calendar-user-availability.js';

const profile = {
  timezone: 'UTC',
  inheritCalendarHours: false,
  weeklyHours: [{ weekday: 4, startMinute: 0, endMinute: 1440 }],
  dateOverrides: [{ date: '2026-10-01', ranges: [] }],
};
const revision = 'a'.repeat(64);

it('distinguishes reset inheritance from an explicitly empty independent schedule', () => {
  expect(calendarUserAvailabilityProfile.parse(profile)).toEqual(profile);
  const empty = { ...profile, weeklyHours: [] };
  expect(updateCalendarUserAvailabilityInput.parse({ revision, profile: empty })).toEqual({
    revision,
    profile: empty,
  });
  expect(updateCalendarUserAvailabilityInput.parse({ revision, profile: null })).toEqual({
    revision,
    profile: null,
  });
  const result = { membershipId: 'mem_01h455vb4pex5vsknk084sn02q', profile: null, revision };
  expect(calendarUserAvailability.parse(result)).toEqual(result);
});

it.each([
  { weeklyHours: [{ weekday: 4, startMinute: 600, endMinute: 540 }] },
  {
    weeklyHours: [
      { weekday: 4, startMinute: 540, endMinute: 600 },
      { weekday: 4, startMinute: 570, endMinute: 630 },
    ],
  },
  { dateOverrides: [{ date: '2026-10-01', ranges: [{ startMinute: 600, endMinute: 540 }] }] },
  {
    dateOverrides: [
      {
        date: '2026-10-01',
        ranges: [
          { startMinute: 540, endMinute: 600 },
          { startMinute: 570, endMinute: 630 },
        ],
      },
    ],
  },
  {
    dateOverrides: [
      { date: '2026-10-01', ranges: [] },
      { date: '2026-10-01', ranges: [{ startMinute: 540, endMinute: 600 }] },
    ],
  },
])('refuses conflicting manager opening configuration %j', (changes) => {
  expect(calendarUserAvailabilityProfile.safeParse({ ...profile, ...changes }).success).toBe(false);
});

it('accepts adjacent and distinct weekday openings without conflating them', () => {
  expect(
    calendarUserAvailabilityProfile.safeParse({
      ...profile,
      weeklyHours: [
        { weekday: 4, startMinute: 0, endMinute: 600 },
        { weekday: 4, startMinute: 600, endMinute: 1440 },
        { weekday: 5, startMinute: 0, endMinute: 1440 },
      ],
    }).success,
  ).toBe(true);
});

it('keeps the manager endpoints authenticated and rejects invalid public membership IDs', () => {
  expect(
    calendarUserAvailabilityEndpoints.map(({ operationId, method, path }) => ({
      operationId,
      method,
      path,
    })),
  ).toEqual([
    {
      operationId: 'getCalendarUserAvailability',
      method: 'get',
      path: '/calendars/users/{membershipId}/availability',
    },
    {
      operationId: 'updateCalendarUserAvailability',
      method: 'put',
      path: '/calendars/users/{membershipId}/availability',
    },
  ]);
  for (const endpoint of calendarUserAvailabilityEndpoints) {
    expect('audience' in endpoint).toBe(false);
    expect(
      endpoint.params.safeParse({ membershipId: 'mem_01h455vb4pex5vsknk084sn02q' }).success,
    ).toBe(true);
    for (const membershipId of [
      '0198de17-876e-7000-aac7-9bc8ac22900d',
      'cal_01h455vb4pex5vsknk084sn02q',
    ])
      expect(endpoint.params.safeParse({ membershipId }).success).toBe(false);
  }
});

it('refuses malformed time zones, extra privileged fields, and time away in a profile', () => {
  for (const changes of [
    { timezone: '+03:00' },
    { ownerId: 'private-user' },
    // Time away is a blocked slot of its own now, not part of a profile.
    { absences: [] },
  ])
    expect(calendarUserAvailabilityProfile.safeParse({ ...profile, ...changes }).success).toBe(
      false,
    );
  expect(
    updateCalendarUserAvailabilityInput.safeParse({ profile, revision: 'not-a-revision' }).success,
  ).toBe(false);
});
