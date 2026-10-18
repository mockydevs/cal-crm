// What the "New calendar" form and its editor hold beyond a calendar's first settings.
import { describe, expect, it } from 'vitest';

import {
  calendarGroupInput,
  createCalendarInput,
  listCalendarsQuery,
  updateCalendarInput,
} from './calendars.js';

const draft = {
  name: 'Consultation',
  timezone: 'Africa/Nairobi',
  bookingSlug: 'consultation',
  kind: 'personal',
  members: [],
  weeklyHours: [],
  dateOverrides: [],
};
const paths = (parsed: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  parsed.error?.issues.map((issue) => issue.path.join('/'));
const member = 'mem_01h455vb4pex5vsknk084sn02q';

describe('a new calendar', () => {
  it('starts from the form’s defaults', () => {
    expect(createCalendarInput.parse(draft)).toMatchObject({
      groupId: null,
      logoFileId: null,
      inviteTitle: '{{contact.name}}',
      slotMinutes: 30,
      slotIntervalMinutes: null,
      extraDurationMinutes: [],
      maxPerDay: null,
      maxPerSlot: null,
      countAvailableDaysOnly: false,
      lookBusyPercent: 0,
      consentEnabled: true,
      consentText: '',
      assignContactToMember: true,
      skipAssignIfOwned: false,
      allowReschedule: true,
      rescheduleCutoffMinutes: null,
      allowCancel: true,
      cancelCutoffMinutes: null,
      coverFileId: null,
      widgetStyle: 'neo',
      primaryColor: '#178af6',
      backgroundColor: '#ffffff',
      buttonText: '',
    });
  });

  it.each([
    [{ slotIntervalMinutes: 4 }, 'slotIntervalMinutes'],
    [{ slotIntervalMinutes: 481 }, 'slotIntervalMinutes'],
    [{ extraDurationMinutes: [15, 30, 45, 60, 90, 120] }, 'extraDurationMinutes'],
    [{ extraDurationMinutes: [45, 45] }, 'extraDurationMinutes'],
    [{ extraDurationMinutes: [4] }, 'extraDurationMinutes/0'],
    [{ maxPerDay: 0 }, 'maxPerDay'],
    [{ maxPerSlot: 0 }, 'maxPerSlot'],
    [{ lookBusyPercent: 101 }, 'lookBusyPercent'],
    [{ rescheduleCutoffMinutes: -1 }, 'rescheduleCutoffMinutes'],
    [{ cancelCutoffMinutes: 525_601 }, 'cancelCutoffMinutes'],
    [{ widgetStyle: 'modern' }, 'widgetStyle'],
    [{ primaryColor: 'blue' }, 'primaryColor'],
    [{ backgroundColor: '#fff' }, 'backgroundColor'],
    [{ inviteTitle: '  ' }, 'inviteTitle'],
    [{ buttonText: 'a'.repeat(41) }, 'buttonText'],
    [{ consentText: 'a'.repeat(1001) }, 'consentText'],
    [{ groupId: 'cal_01h455vb4pex5vsknk084sn02q' }, 'groupId'],
  ])('refuses %j', (changed, path) => {
    expect(paths(createCalendarInput.safeParse({ ...draft, ...changed }))).toEqual([path]);
  });

  it('takes a colour with or without transparency, in any case', () => {
    expect(
      createCalendarInput.parse({
        ...draft,
        primaryColor: ' #178AF6FF ',
        backgroundColor: '#FFFFFF',
      }),
    ).toMatchObject({ primaryColor: '#178af6ff', backgroundColor: '#ffffff' });
  });

  it("keeps where each member meets, up to five places, the first being an appointment's", () => {
    const place = { kind: 'custom', value: ' 12 Harbor Road ' };
    const parsed = createCalendarInput.parse({
      ...draft,
      members: [{ membershipId: member, weight: 1, locations: [place] }],
    });
    expect(parsed.members).toEqual([
      {
        membershipId: member,
        weight: 1,
        locations: [{ kind: 'custom', value: '12 Harbor Road', label: null }],
      },
    ]);
    expect(
      createCalendarInput.parse({ ...draft, members: [{ membershipId: member, weight: 1 }] })
        .members[0]?.locations,
    ).toEqual([]);
    const withPlaces = (locations: unknown[]) =>
      createCalendarInput.safeParse({
        ...draft,
        members: [{ membershipId: member, weight: 1, locations }],
      });
    expect(withPlaces(Array.from({ length: 6 }, () => place)).success).toBe(false);
    expect(withPlaces([{ kind: 'zoom', value: 'made for you' }]).success).toBe(false);
    expect(withPlaces([{ kind: 'phone', value: ' ' }]).success).toBe(false);
  });
});

describe('saving a calendar’s settings', () => {
  const settings = { ...draft, revision: 'a'.repeat(64) };
  const { members: _members, weeklyHours: _hours, dateOverrides: _overrides, ...saved } = settings;

  it('takes the whole of them, and switches on only a type that can be booked', () => {
    expect(updateCalendarInput.safeParse({ ...saved, lookBusyPercent: 25 }).success).toBe(true);
    expect(
      paths(updateCalendarInput.safeParse({ ...saved, kind: 'class', isActive: true })),
    ).toEqual(['isActive']);
    expect(updateCalendarInput.safeParse({ ...saved, kind: 'class' }).success).toBe(true);
  });
});

describe('listing calendars', () => {
  it('searches and filters by status, type, group and person', () => {
    expect(listCalendarsQuery.parse({})).toEqual({ limit: 25 });
    expect(
      listCalendarsQuery.parse({
        q: ' strategy ',
        status: 'inactive',
        kind: 'round_robin',
        group: 'none',
        member,
        limit: '10',
      }),
    ).toEqual({
      q: 'strategy',
      status: 'inactive',
      kind: 'round_robin',
      group: 'none',
      member,
      limit: 10,
    });
    expect(listCalendarsQuery.safeParse({ status: 'draft' }).success).toBe(false);
    expect(listCalendarsQuery.safeParse({ group: 'all' }).success).toBe(false);
  });
});

describe('a calendar group', () => {
  it('has a name of 1 to 120 characters', () => {
    expect(calendarGroupInput.parse({ name: ' Sales calls ' })).toEqual({ name: 'Sales calls' });
    expect(calendarGroupInput.safeParse({ name: ' ' }).success).toBe(false);
    expect(calendarGroupInput.safeParse({ name: 'a'.repeat(121) }).success).toBe(false);
  });
});
