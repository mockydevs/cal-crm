import {
  calendar,
  calendarConfiguration,
  createCalendarInput,
  updateCalendarInput,
  type CalendarConfiguration,
  type User,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  amountOf,
  availabilityBody,
  availabilityChanged,
  bookingAddress,
  bookingPrefix,
  checkAvailability,
  checkCreate,
  checkSettings,
  chooserKinds,
  clockWords,
  defaultWeeklyHours,
  draftOf,
  eligiblePeople,
  fieldOfDraft,
  hoursOfMember,
  hoursSummary,
  imageProblem,
  isBookableKind,
  isHexColor,
  listQuery,
  kindChoices,
  minutesOf,
  newDraft,
  numberRanges,
  problemsAfter,
  sectionByKey,
  sectionOfField,
  sections,
  slugFromName,
  swatchOf,
  type CalendarDraft,
} from './calendar-settings-rules';

const memberId = 'mem_01h455vb4pex5vsknk084sn02q';
const otherId = 'mem_01h455vb4pex5vsknk084sn02r';
const revision = 'a'.repeat(64);

const strip = (hours: readonly { weekday: number; startTime: string; endTime: string }[]) =>
  hours.map(({ weekday, startTime, endTime }) => ({ weekday, startTime, endTime }));

function saved(rest: Partial<CalendarConfiguration> = {}): CalendarConfiguration {
  return calendarConfiguration.parse({
    calendar: calendar.parse({
      id: 'cal_01h455vb4pex5vsknk084sn02q',
      name: 'Consultation',
      kind: 'round_robin',
      timezone: 'Africa/Nairobi',
      bookingSlug: 'consultation',
      supported: true,
      bookable: false,
      createdAt: '2026-10-09T09:00:00Z',
      updatedAt: '2026-10-09T09:00:00Z',
    }),
    members: [{ membershipId: memberId, weight: 2, locations: [] }],
    weeklyHours: [{ weekday: 1, startTime: '09:00', endTime: '17:00' }],
    dateOverrides: [],
    revision,
    canManage: true,
    ...rest,
  });
}

function person(rest: Partial<User>): User {
  return {
    id: memberId,
    membershipId: memberId,
    invitationId: null,
    status: 'active',
    firstName: 'Dana',
    lastName: 'Brooks',
    name: 'Dana Brooks',
    email: 'dana@example.test',
    phone: null,
    extension: null,
    avatarFileId: null,
    userType: 'account',
    roleId: 'role_01h455vb4pex5vsknk084sn02q',
    roleKey: 'admin',
    roleName: 'Admin',
    isSelf: false,
    isOwner: false,
    canEdit: true,
    canRemove: true,
    ...rest,
  };
}

describe('calendar types', () => {
  it('offers a new calendar only the types that take bookings', () => {
    expect(chooserKinds).toEqual(['personal', 'round_robin']);
  });

  it('lets a draft of another type keep its type, or become one that takes bookings', () => {
    expect(kindChoices('personal')).toEqual(['personal', 'round_robin']);
    expect(kindChoices('round_robin')).toEqual(['personal', 'round_robin']);
    expect(kindChoices('class')).toEqual(['personal', 'round_robin', 'class']);
  });

  it('knows which types take bookings today', () => {
    expect(isBookableKind('personal')).toBe(true);
    expect(isBookableKind('round_robin')).toBe(true);
    for (const kind of ['class', 'collective', 'service', 'event'] as const)
      expect(isBookableKind(kind)).toBe(false);
  });
});

describe('units', () => {
  it('shows minutes in the largest unit offered that holds them exactly', () => {
    expect(amountOf(30, ['minutes', 'hours'])).toEqual({ value: '30', unit: 'minutes' });
    expect(amountOf(120, ['minutes', 'hours'])).toEqual({ value: '2', unit: 'hours' });
    expect(amountOf(90, ['minutes', 'hours'])).toEqual({ value: '90', unit: 'minutes' });
    expect(amountOf(2880, ['minutes', 'hours', 'days'])).toEqual({ value: '2', unit: 'days' });
    expect(amountOf(1440, ['minutes', 'hours'])).toEqual({ value: '24', unit: 'hours' });
  });

  it('keeps nothing and zero in the first unit offered', () => {
    expect(amountOf(null, ['minutes', 'hours'])).toEqual({ value: '', unit: 'minutes' });
    expect(amountOf(0, ['minutes', 'hours'])).toEqual({ value: '0', unit: 'minutes' });
  });

  it('turns an amount back into minutes, nothing into null and nonsense into NaN', () => {
    expect(minutesOf({ value: '45', unit: 'minutes' })).toBe(45);
    expect(minutesOf({ value: '2', unit: 'hours' })).toBe(120);
    expect(minutesOf({ value: '3', unit: 'days' })).toBe(4320);
    expect(minutesOf({ value: ' ', unit: 'days' })).toBeNull();
    expect(minutesOf({ value: '1.5', unit: 'hours' })).toBeNaN();
    expect(minutesOf({ value: 'soon', unit: 'minutes' })).toBeNaN();
  });
});

describe('the booking link', () => {
  it('suggests a slug from the name', () => {
    expect(slugFromName('Outbound reach')).toBe('outbound-reach');
    expect(slugFromName('  R - 15 Min. VIP Partner!  ')).toBe('r-15-min-vip-partner');
    expect(slugFromName('Café Zürich')).toBe('cafe-zurich');
    expect(slugFromName('---')).toBe('');
    expect(slugFromName('a'.repeat(80))).toHaveLength(63);
  });

  it('is the public page of this business, not the vendor’s widget address', () => {
    expect(bookingPrefix('bluebird', 'harbor')).toBe('/book/bluebird/harbor/');
    expect(bookingAddress('https://crm.example', 'bluebird', 'harbor', 'tours')).toBe(
      'https://crm.example/book/bluebird/harbor/tours',
    );
  });
});

describe('the hours summary', () => {
  it('starts a new calendar on weekdays from eight to five', () => {
    expect(strip(defaultWeeklyHours())).toEqual(
      [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: '08:00', endTime: '17:00' })),
    );
    expect(hoursSummary(defaultWeeklyHours())).toEqual({
      kind: 'same',
      days: 'weekdays',
      startTime: '08:00',
      endTime: '17:00',
    });
  });

  it('names every day, or the days themselves, when they share one range', () => {
    const all = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      startTime: '09:00',
      endTime: '24:00',
    }));
    expect(hoursSummary(all)).toMatchObject({ kind: 'same', days: 'every_day' });
    expect(
      hoursSummary([
        { weekday: 3, startTime: '10:00', endTime: '12:00' },
        { weekday: 1, startTime: '10:00', endTime: '12:00' },
      ]),
    ).toEqual({ kind: 'same', days: [1, 3], startTime: '10:00', endTime: '12:00' });
  });

  it('says so when there are no hours or they differ by day', () => {
    expect(hoursSummary([])).toEqual({ kind: 'none' });
    expect(
      hoursSummary([
        { weekday: 1, startTime: '10:00', endTime: '12:00' },
        { weekday: 2, startTime: '09:00', endTime: '12:00' },
      ]),
    ).toEqual({ kind: 'varied' });
    expect(
      hoursSummary([
        { weekday: 1, startTime: '08:00', endTime: '12:00' },
        { weekday: 1, startTime: '13:00', endTime: '17:00' },
      ]),
    ).toEqual({ kind: 'varied' });
  });

  it('writes a clock time as the locale does', () => {
    expect(clockWords('08:00', 'en')).toBe('8:00 AM');
    expect(clockWords('17:00', 'en')).toBe('5:00 PM');
    expect(clockWords('24:00', 'en')).toBe('12:00 AM');
  });

  it('uses a member’s own hours when they have a schedule, else the calendar’s', () => {
    const calendarHours = [{ weekday: 1, startTime: '08:00', endTime: '17:00' }];
    expect(hoursOfMember(null, calendarHours)).toEqual(calendarHours);
    expect(
      hoursOfMember(
        {
          timezone: 'UTC',
          inheritCalendarHours: true,
          weeklyHours: [{ weekday: 2, startMinute: 540, endMinute: 600 }],
          dateOverrides: [],
        },
        calendarHours,
      ),
    ).toEqual(calendarHours);
    expect(
      hoursOfMember(
        {
          timezone: 'UTC',
          inheritCalendarHours: false,
          weeklyHours: [{ weekday: 2, startMinute: 540, endMinute: 1440 }],
          dateOverrides: [],
        },
        calendarHours,
      ),
    ).toEqual([{ weekday: 2, startTime: '09:00', endTime: '24:00' }]);
  });
});

describe('who can be on a calendar', () => {
  it('offers only people of the account who have joined', () => {
    const people = [
      person({}),
      person({ id: otherId, membershipId: otherId, name: 'Ava Agency', userType: 'agency' }),
      person({ id: 'inv_1', membershipId: null, name: 'Sam Okoro', status: 'invited' }),
    ];
    expect(eligiblePeople(people)).toEqual([
      { membershipId: memberId, name: 'Dana Brooks', email: 'dana@example.test' },
    ]);
  });
});

describe('a new calendar', () => {
  const draft = (change: Partial<CalendarDraft> = {}): CalendarDraft => ({
    ...newDraft('personal', 'Africa/Nairobi'),
    name: 'Venue tours',
    bookingSlug: 'venue-tours',
    ...change,
  });

  it('starts as a draft with the contract’s defaults and weekday hours', () => {
    const start = newDraft('class', 'Africa/Nairobi');
    expect(start).toMatchObject({
      kind: 'class',
      isActive: false,
      timezone: 'Africa/Nairobi',
      duration: { value: '30', unit: 'minutes' },
      interval: { value: '', unit: 'minutes' },
      notice: { value: '1', unit: 'hours' },
      dateRange: '60',
      maxPerDay: '',
      maxPerSlot: '',
      lookBusy: false,
      inviteTitle: '{{contact.name}}',
      consentEnabled: true,
      widgetStyle: 'neo',
      primaryColor: '#178af6',
      backgroundColor: '#ffffff',
    });
    expect(start.weeklyHours).toHaveLength(5);
  });

  it('builds one body the contract accepts, in minutes and days', () => {
    const checked = checkCreate(
      draft({
        members: [
          {
            membershipId: memberId,
            weight: '1',
            locations: [{ key: 'k', kind: 'phone', value: ' +254 700 ', label: null }],
          },
        ],
        duration: { value: '1', unit: 'hours' },
        interval: { value: '15', unit: 'minutes' },
        extraDurations: [{ key: 'e', value: '45', unit: 'minutes' }],
        notice: { value: '2', unit: 'days' },
        dateRange: '30',
        bufferBefore: { value: '10', unit: 'minutes' },
        bufferAfter: { value: '', unit: 'minutes' },
        maxPerDay: '8',
        lookBusy: true,
        lookBusyPercent: '25',
        rescheduleCutoff: { value: '2', unit: 'hours' },
      }),
    );
    if (!checked.ok) throw new Error(JSON.stringify(checked.fields));
    expect(createCalendarInput.parse(checked.body)).toEqual(checked.body);
    expect(Object.keys(checked.body)).not.toContain('isRecurring');
    expect(checked.body).toMatchObject({
      name: 'Venue tours',
      kind: 'personal',
      isActive: false,
      slotMinutes: 60,
      slotIntervalMinutes: 15,
      extraDurationMinutes: [45],
      minNoticeMinutes: 2880,
      maxDaysAhead: 30,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 0,
      maxPerDay: 8,
      maxPerSlot: null,
      lookBusyPercent: 25,
      rescheduleCutoffMinutes: 120,
      cancelCutoffMinutes: null,
      members: [
        {
          membershipId: memberId,
          weight: 1,
          locations: [{ kind: 'phone', value: '+254 700', label: null }],
        },
      ],
    });
    expect(checked.body.weeklyHours).toHaveLength(5);
  });

  it('sends no look-busy share while the switch is off', () => {
    const checked = checkCreate(draft({ lookBusy: false, lookBusyPercent: '40' }));
    expect(checked.ok && checked.body.lookBusyPercent).toBe(0);
  });

  it('names the fields that are wrong, by the contract’s names', () => {
    const checked = checkCreate(
      draft({
        name: ' ',
        bookingSlug: 'Not A Slug',
        duration: { value: '', unit: 'minutes' },
        dateRange: '0',
        primaryColor: 'blue',
        weeklyHours: [{ key: 'h', weekday: 1, startTime: '', endTime: '17:00' }],
      }),
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(Object.keys(checked.fields).sort()).toEqual(
      ['bookingSlug', 'maxDaysAhead', 'name', 'primaryColor', 'slotMinutes', 'weeklyHours'].sort(),
    );
    expect(checked.fields['primaryColor']?.message).toBe('Use a colour such as #178af6.');
  });

  it('keeps the contract’s sentence for a type that cannot be switched on', () => {
    const checked = checkCreate(draft({ kind: 'class', isActive: true }));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.fields['isActive']?.message).toBe(
      "This type of calendar can't take bookings yet. Save it as a draft.",
    );
  });
});

describe('a saved calendar', () => {
  it('round-trips through the form without changing anything', () => {
    const configuration = saved();
    const draft = draftOf(configuration);
    const settings = checkSettings(draft, revision);
    if (!settings.ok) throw new Error(JSON.stringify(settings.fields));
    const {
      id: _id,
      groupName: _groupName,
      supported: _supported,
      bookable: _bookable,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...settingsSaved
    } = configuration.calendar;
    expect(settings.body).toEqual(updateCalendarInput.parse({ ...settingsSaved, revision }));
    expect(availabilityChanged(draft, configuration)).toBe(false);
  });

  it('shows saved minutes in the unit that reads best', () => {
    const configuration = saved();
    const draft = draftOf({
      ...configuration,
      calendar: {
        ...configuration.calendar,
        slotMinutes: 120,
        slotIntervalMinutes: 30,
        minNoticeMinutes: 1440,
        extraDurationMinutes: [45, 60],
        lookBusyPercent: 30,
        cancelCutoffMinutes: 60,
      },
    });
    expect(draft.duration).toEqual({ value: '2', unit: 'hours' });
    expect(draft.interval).toEqual({ value: '30', unit: 'minutes' });
    expect(draft.notice).toEqual({ value: '1', unit: 'days' });
    expect(draft.extraDurations.map(({ value, unit }) => ({ value, unit }))).toEqual([
      { value: '45', unit: 'minutes' },
      { value: '1', unit: 'hours' },
    ]);
    expect(draft.lookBusy).toBe(true);
    expect(draft.lookBusyPercent).toBe('30');
    expect(draft.cancelCutoff).toEqual({ value: '1', unit: 'hours' });
  });

  it('sends members with their weight and places, and hours without the form’s keys', () => {
    const draft = draftOf(saved());
    const body = availabilityBody({
      ...draft,
      members: [
        ...draft.members,
        {
          membershipId: otherId,
          weight: '3',
          locations: [{ key: 'k', kind: 'custom', value: 'Room 2', label: 'Office' }],
        },
      ],
    });
    expect(body).toEqual({
      members: [
        { membershipId: memberId, weight: 2, locations: [] },
        {
          membershipId: otherId,
          weight: 3,
          locations: [{ kind: 'custom', value: 'Room 2', label: 'Office' }],
        },
      ],
      weeklyHours: [{ weekday: 1, startTime: '09:00', endTime: '17:00' }],
      dateOverrides: [],
    });
  });

  it('knows when the team, a place or the hours changed', () => {
    const configuration = saved();
    const draft = draftOf(configuration);
    expect(availabilityChanged({ ...draft, weeklyHours: [] }, configuration)).toBe(true);
    expect(
      availabilityChanged(
        {
          ...draft,
          members: draft.members.map((member) => ({
            ...member,
            locations: [{ key: 'k', kind: 'address', value: '1 Pier Road', label: null }],
          })),
        },
        configuration,
      ),
    ).toBe(true);
    expect(availabilityChanged({ ...draft, name: 'Renamed' }, configuration)).toBe(false);
  });

  it('counts a member who left the team as a change, so saving removes them', () => {
    const configuration = saved({
      members: [
        { membershipId: memberId, weight: 2, locations: [] },
        { membershipId: null, weight: 1, locations: [] },
      ],
    });
    const draft = draftOf(configuration);
    expect(draft.members.map((member) => member.membershipId)).toEqual([memberId]);
    expect(availabilityChanged(draft, configuration)).toBe(true);
  });

  it('checks the team and hours with the revision they were read at', () => {
    const checked = checkAvailability(draftOf(saved()), revision);
    expect(checked.ok && checked.body.revision).toBe(revision);
    const wrong = checkAvailability(
      {
        ...draftOf(saved()),
        members: [
          {
            membershipId: memberId,
            weight: '1',
            locations: [{ key: 'k', kind: 'custom', value: '', label: null }],
          },
        ],
      },
      revision,
    );
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.fields['members']?.message).toBe('Write the meeting location.');
  });
});

describe('number ranges', () => {
  it('match what the contract accepts', () => {
    const base = {
      name: 'A',
      kind: 'personal',
      timezone: 'UTC',
      bookingSlug: 'a',
      members: [],
      weeklyHours: [],
      dateOverrides: [],
    };
    for (const [field, { min, max }] of Object.entries(numberRanges)) {
      const value = (number: number) => (field === 'extraDurationMinutes' ? [number] : number);
      expect(createCalendarInput.safeParse({ ...base, [field]: value(min) }).success, field).toBe(
        true,
      );
      expect(createCalendarInput.safeParse({ ...base, [field]: value(max) }).success, field).toBe(
        true,
      );
      expect(
        createCalendarInput.safeParse({ ...base, [field]: value(min - 1) }).success,
        field,
      ).toBe(false);
      expect(
        createCalendarInput.safeParse({ ...base, [field]: value(max + 1) }).success,
        field,
      ).toBe(false);
    }
  });
});

describe('colours and images', () => {
  it('accepts #rrggbb and #rrggbbaa, as the contract does', () => {
    expect(isHexColor('#178af6')).toBe(true);
    expect(isHexColor('#178AF6FF')).toBe(true);
    expect(isHexColor('178af6')).toBe(false);
    expect(isHexColor('#fff')).toBe(false);
    expect(swatchOf('#178AF6ff')).toBe('#178af6');
    expect(swatchOf('nope')).toBe('#000000');
  });

  it('refuses a file that is not an image or is too big, before sending it', () => {
    expect(imageProblem({ type: 'image/png', size: 10 })).toBeUndefined();
    expect(imageProblem({ type: 'image/webp', size: 2_500_000 })).toBeUndefined();
    expect(imageProblem({ type: 'application/pdf', size: 10 })).toBe('type');
    expect(imageProblem({ type: 'image/jpeg', size: 2_500_001 })).toBe('size');
  });
});

describe('the sections', () => {
  it('lists four sections, then three under Advanced settings, and none with nothing behind it', () => {
    expect(sections.filter((each) => !each.advanced).map((each) => each.key)).toEqual([
      'basic',
      'staff',
      'availability',
      'booking',
    ]);
    expect(sections.filter((each) => each.advanced).map((each) => each.key)).toEqual([
      'forms',
      'policies',
      'appearance',
    ]);
  });

  it('finds the section that shows a field', () => {
    expect(sectionOfField('name')).toBe('basic');
    expect(sectionOfField('isActive')).toBe('basic');
    expect(sectionOfField('members')).toBe('staff');
    expect(sectionOfField('weeklyHours')).toBe('availability');
    expect(sectionOfField('maxPerSlot')).toBe('booking');
    expect(sectionOfField('consentText')).toBe('forms');
    expect(sectionOfField('cancelCutoffMinutes')).toBe('policies');
    expect(sectionOfField('primaryColor')).toBe('appearance');
    expect(sectionOfField('somethingElse')).toBeUndefined();
    // Settings that did nothing are gone from the contract, so no section shows them.
    for (const gone of ['isRecurring', 'formId', 'formFirst', 'stickyContacts', 'allowGuests']) {
      expect(sectionOfField(gone)).toBeUndefined();
    }
  });

  it('moves between the sections shown with the arrow keys', () => {
    const shown = ['basic', 'staff', 'availability', 'booking'] as const;
    expect(sectionByKey(shown, 'basic', 'ArrowDown')).toBe('staff');
    expect(sectionByKey(shown, 'booking', 'ArrowDown')).toBe('basic');
    expect(sectionByKey(shown, 'basic', 'ArrowUp')).toBe('booking');
    expect(sectionByKey(shown, 'staff', 'Home')).toBe('basic');
    expect(sectionByKey(shown, 'staff', 'End')).toBe('booking');
    expect(sectionByKey(shown, 'staff', 'a')).toBeUndefined();
  });
});

describe('the list’s query', () => {
  it('sends only the filters that are set', () => {
    expect(
      listQuery({ q: '', status: 'all', kind: 'all', group: 'all', member: 'anyone' }, 20),
    ).toEqual({ limit: 20 });
    expect(
      listQuery(
        {
          q: ' tours ',
          status: 'inactive',
          kind: 'class',
          group: 'none',
          member: memberId,
        },
        50,
        'cal_01h455vb4pex5vsknk084sn02q',
      ),
    ).toEqual({
      limit: 50,
      q: 'tours',
      status: 'inactive',
      kind: 'class',
      group: 'none',
      member: memberId,
      after: 'cal_01h455vb4pex5vsknk084sn02q',
    });
  });
});

describe('problems', () => {
  it('forgets what was wrong with a part of the form once it changes', () => {
    const problems = { slotMinutes: 'a', name: 'b', maxDaysAhead: 'c' };
    expect(problemsAfter(problems, { duration: { value: '30', unit: 'minutes' } })).toEqual({
      name: 'b',
      maxDaysAhead: 'c',
    });
    expect(problemsAfter(problems, { name: 'x', dateRange: '3' })).toEqual({ slotMinutes: 'a' });
    expect(fieldOfDraft('lookBusy')).toBe('lookBusyPercent');
    expect(fieldOfDraft('members')).toBe('members');
  });
});

describe('bot protection', () => {
  it('starts off, is saved as chosen, and is shown in the forms section', () => {
    const draft = newDraft('personal', 'America/New_York');
    expect(draft.botProtection).toBe('off');
    const checked = checkSettings(
      { ...draft, name: 'Consult', bookingSlug: 'consult', botProtection: 'altcha' },
      'a'.repeat(64),
    );
    expect(checked.ok && checked.body.botProtection).toBe('altcha');
    expect(sectionOfField('botProtection')).toBe('forms');
  });
});
