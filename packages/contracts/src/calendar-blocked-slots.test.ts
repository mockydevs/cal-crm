import { expect, it } from 'vitest';
import {
  blockedSlotEndpoints,
  blockedSlotInput,
  updateBlockedSlotInput,
} from './calendar-blocked-slots.js';

const member = 'mem_01h455vb4pex5vsknk084sn02q';
const calendar = 'cal_01h455vb4pex5vsknk084sn02q';
const block = {
  membershipId: member,
  startsAt: '2026-10-01T10:00:00Z',
  endsAt: '2026-10-01T11:00:00Z',
};

it('blocks a member everywhere by default, with an empty title', () => {
  expect(blockedSlotInput.parse(block)).toEqual({ ...block, calendarId: null, title: '' });
});

it('blocks a member on one calendar, or a whole calendar, but never nobody', () => {
  expect(blockedSlotInput.safeParse({ ...block, calendarId: calendar }).success).toBe(true);
  expect(
    blockedSlotInput.safeParse({ ...block, membershipId: null, calendarId: calendar }).success,
  ).toBe(true);
  const nobody = blockedSlotInput.safeParse({ ...block, membershipId: null });
  expect(nobody.error?.issues).toMatchObject([
    { path: ['membershipId'], message: 'Choose a team member, a calendar, or both.' },
  ]);
});

it.each([
  { startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T10:00:00Z' },
  { startsAt: '2026-10-01T10:00:00.000002Z', endsAt: '2026-10-01T10:00:00.000001Z' },
  { startsAt: '2026-10-01T10:00:00Z', endsAt: '2026-10-01T12:00:00+03:00' },
  { startsAt: '2026-10-01T10:00:00.0000001Z', endsAt: '2026-10-01T11:00:00Z' },
  { startsAt: '0000-10-01T10:00:00Z', endsAt: '2026-10-01T11:00:00Z' },
  { startsAt: 'infinity', endsAt: '2026-10-01T10:00:00Z' },
  { startsAt: '2026-10-01T10:00:00Z', endsAt: 'infinity' },
  // Instants whose UTC year the API could not show again.
  { startsAt: '0001-01-01T00:00:00+14:00', endsAt: '2026-10-01T11:00:00Z' },
  { startsAt: '2026-10-01T10:00:00Z', endsAt: '9999-12-31T23:59:59-14:00' },
  { startsAt: '2026-10-01T10:00:00Z', endsAt: '9999-12-31T23:59:59.999999-00:01' },
])('refuses a malformed or empty time %j', (times) => {
  expect(blockedSlotInput.safeParse({ ...block, ...times }).success).toBe(false);
});

it('keeps microseconds, across the Unix epoch too, up to the first and last the API can show', () => {
  for (const times of [
    { startsAt: '2026-10-01T10:00:00.000001Z', endsAt: '2026-10-01T10:00:00.000002Z' },
    { startsAt: '1969-12-31T23:59:59.999999Z', endsAt: '1970-01-01T00:00:00.000001Z' },
    { startsAt: '0001-01-01T00:00:00Z', endsAt: '9999-12-31T23:59:59.999999Z' },
  ])
    expect(blockedSlotInput.safeParse({ ...block, ...times }).success).toBe(true);
});

it('trims the title and bounds it, and a change needs the revision it was read at', () => {
  expect(blockedSlotInput.parse({ ...block, title: '  Lunch  ' }).title).toBe('Lunch');
  expect(blockedSlotInput.safeParse({ ...block, title: 'x'.repeat(1001) }).success).toBe(false);
  expect(blockedSlotInput.safeParse({ ...block, ownerId: 'someone' }).success).toBe(false);
  const revision = 'a'.repeat(64);
  expect(updateBlockedSlotInput.safeParse({ ...block, revision }).success).toBe(true);
  expect(updateBlockedSlotInput.safeParse(block).success).toBe(false);
  expect(updateBlockedSlotInput.safeParse({ ...block, membershipId: null, revision }).success).toBe(
    false,
  );
});

it("serves the five calls, each one by a blocked slot id but the member's list", () => {
  expect(blockedSlotEndpoints.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'get /calendars/users/{membershipId}/blocked-slots',
    'get /calendars/blocked-slots/{blockedSlotId}',
    'post /calendars/blocked-slots',
    'put /calendars/blocked-slots/{blockedSlotId}',
    'delete /calendars/blocked-slots/{blockedSlotId}',
  ]);
  for (const endpoint of blockedSlotEndpoints.filter(
    (each) => each.operationId !== 'listBlockedSlots',
  ))
    if ('params' in endpoint) {
      expect(
        endpoint.params.safeParse({ blockedSlotId: 'blk_01h455vb4pex5vsknk084sn02q' }).success,
      ).toBe(true);
      expect(endpoint.params.safeParse({ blockedSlotId: calendar }).success).toBe(false);
    }
});
