import type { UserDetail, UserList } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  availabilityDraft,
  availabilityProfile,
  avatarProblem,
  checkDraft,
  clockOf,
  defaultRole,
  draftOf,
  filterQuery,
  minuteOf,
  phoneWords,
  roleWord,
  tabByKey,
  userTabs,
} from './users-rules';

type Role = UserList['roles'][number];

const role = (key: string, name: string, permissions: string[], tail: string): Role => ({
  id: `role_01m4bd188ff82s0add91b7pz6${tail}`,
  name,
  key,
  isBuiltin: true,
  permissions,
});
const owner = role('owner', 'Owner', ['team.manage', 'tags.manage', 'business.profile'], '2');
const admin = role('admin', 'Admin', ['team.manage', 'tags.manage'], '3');
const member = role('member', 'Member', ['tags.manage'], '4');
const viewer = role('viewer', 'Viewer', [], '5');

const riley: UserDetail = {
  id: 'mem_01m4bd9fteedat3be9bqgx2047',
  membershipId: 'mem_01m4bd9fteedat3be9bqgx2047',
  invitationId: null,
  status: 'active',
  firstName: 'Riley',
  lastName: 'Brooks',
  name: 'Riley Brooks',
  email: 'riley@example.test',
  phone: '+13055550123',
  extension: '42',
  avatarFileId: null,
  userType: 'account',
  roleId: member.id,
  roleKey: 'member',
  roleName: 'Member',
  isSelf: false,
  isOwner: false,
  canEdit: true,
  canRemove: true,
  calendarId: null,
  signature: { enabled: false, document: null },
};

describe('what the list shows', () => {
  it('writes a role in small letters for the User type badge', () => {
    expect(roleWord('Admin')).toBe('admin');
    expect(roleWord('Front Desk')).toBe('front desk');
  });

  it('shows a dash for no phone, and the extension when there is one', () => {
    expect(phoneWords(null, null)).toEqual({ number: '-', extension: null });
    expect(phoneWords('+13055550123', null)).toEqual({ number: '+13055550123', extension: null });
    expect(phoneWords('+13055550123', '42')).toEqual({ number: '+13055550123', extension: '42' });
  });

  it('turns the User role filter into what the list is asked for', () => {
    expect(filterQuery('all')).toEqual({});
    expect(filterQuery('type:agency')).toEqual({ type: 'agency' });
    expect(filterQuery('type:account')).toEqual({ type: 'account' });
    expect(filterQuery(admin.id)).toEqual({ role: admin.id });
  });
});

describe('roles', () => {
  it('never offers the owner role', () => {
    expect(assignableRoles([owner, admin, member, viewer]).map((each) => each.key)).toEqual([
      'admin',
      'member',
      'viewer',
    ]);
  });

  it('starts a new person as a member, or else with the role allowing least', () => {
    expect(defaultRole([owner, admin, member, viewer])?.key).toBe('member');
    expect(defaultRole([owner, admin, viewer])?.key).toBe('viewer');
    expect(defaultRole([owner])).toBeUndefined();
  });
});

describe('the tabs', () => {
  it('are the five of the screenshot, in order', () => {
    expect(userTabs).toEqual(['info', 'roles', 'calls', 'availability', 'calendars']);
  });

  it('move with the arrow keys, Home and End, and stop at the ends', () => {
    expect(tabByKey('info', 'ArrowDown')).toBe('roles');
    expect(tabByKey('roles', 'ArrowRight')).toBe('calls');
    expect(tabByKey('roles', 'ArrowUp')).toBe('info');
    expect(tabByKey('roles', 'ArrowLeft')).toBe('info');
    expect(tabByKey('info', 'ArrowUp')).toBe('calendars');
    expect(tabByKey('calendars', 'ArrowDown')).toBe('info');
    expect(tabByKey('calls', 'Home')).toBe('info');
    expect(tabByKey('calls', 'End')).toBe('calendars');
    expect(tabByKey('calls', 'a')).toBeUndefined();
  });
});

describe('the form', () => {
  const words = {
    email: 'Enter an email address.',
    phone: 'Enter a valid phone number.',
    signature: 'Shorten the signature.',
  };

  it('starts empty for a new person, with the role given', () => {
    expect(draftOf(undefined, member.id)).toEqual({
      firstName: '',
      lastName: '',
      email: '',
      phone: { value: null, valid: true },
      extension: '',
      avatarFileId: null,
      roleId: member.id,
      calendarId: null,
      signatureEnabled: false,
      signature: { document: null, valid: true },
    });
  });

  it('starts from the person being edited', () => {
    expect(draftOf(riley, viewer.id)).toMatchObject({
      firstName: 'Riley',
      lastName: 'Brooks',
      email: 'riley@example.test',
      phone: { value: '+13055550123', valid: true },
      extension: '42',
      roleId: member.id,
    });
  });

  it('makes the body addUser takes, with nothing typed sent as null', () => {
    const checked = checkDraft(
      {
        ...draftOf(undefined, member.id),
        firstName: ' Sam ',
        lastName: 'Okoro',
        email: 'Sam@Example.test',
      },
      'add',
      words,
    );
    expect(checked).toEqual({
      ok: true,
      mode: 'add',
      body: {
        email: 'sam@example.test',
        firstName: 'Sam',
        lastName: 'Okoro',
        phone: null,
        extension: null,
        avatarFileId: null,
        roleId: member.id,
        calendarId: null,
        signature: { enabled: false, document: null },
      },
    });
  });

  it('makes the body updateUser takes: everything but the email', () => {
    const checked = checkDraft({ ...draftOf(riley, viewer.id), firstName: 'Rae' }, 'edit', words);
    expect(checked).toEqual({
      ok: true,
      mode: 'edit',
      body: {
        firstName: 'Rae',
        lastName: 'Brooks',
        phone: '+13055550123',
        extension: '42',
        avatarFileId: null,
        roleId: member.id,
        calendarId: null,
        signature: { enabled: false, document: null },
      },
    });
  });

  it('says which required fields are missing, in the contract’s words', () => {
    const checked = checkDraft(draftOf(undefined, member.id), 'add', words);
    expect(checked).toEqual({
      ok: false,
      fields: {
        firstName: 'Give the first name.',
        lastName: 'Give the last name.',
        email: 'Enter an email address.',
      },
    });
  });

  it('refuses an address that is not one', () => {
    const checked = checkDraft(
      { ...draftOf(riley, member.id), email: 'not an address' },
      'add',
      words,
    );
    expect(checked).toMatchObject({ ok: false, fields: { email: 'Invalid email address' } });
  });

  it('refuses a number the country does not have, and an extension with no number', () => {
    const draft = draftOf(riley, member.id);
    expect(
      checkDraft({ ...draft, phone: { value: null, valid: false } }, 'edit', words),
    ).toMatchObject({ ok: false, fields: { phone: words.phone } });
    expect(
      checkDraft({ ...draft, phone: { value: null, valid: true } }, 'edit', words),
    ).toMatchObject({ ok: false, fields: { extension: 'Give a phone number for the extension.' } });
    expect(checkDraft({ ...draft, extension: '4x' }, 'edit', words)).toMatchObject({
      ok: false,
      fields: { extension: 'Use up to 10 digits.' },
    });
  });

  it('refuses a signature the editor could not turn into a document', () => {
    expect(
      checkDraft(
        { ...draftOf(riley, member.id), signature: { document: null, valid: false } },
        'edit',
        words,
      ),
    ).toMatchObject({ ok: false, fields: { signature: words.signature } });
  });
});

describe('a profile image', () => {
  it('is a PNG, JPEG, GIF or WebP of at most 2.5 MB', () => {
    expect(avatarProblem({ type: 'image/png', size: 2_500_000 })).toBeUndefined();
    expect(avatarProblem({ type: 'image/webp', size: 1 })).toBeUndefined();
    expect(avatarProblem({ type: 'image/png', size: 2_500_001 })).toBe('size');
    expect(avatarProblem({ type: 'image/svg+xml', size: 10 })).toBe('type');
    expect(avatarProblem({ type: 'application/pdf', size: 10 })).toBe('type');
  });
});

describe('availability', () => {
  it('reads minutes as a clock time, and the end of the day as 24:00', () => {
    expect(clockOf(0)).toBe('00:00');
    expect(clockOf(545)).toBe('09:05');
    expect(clockOf(1440)).toBe('24:00');
    expect(minuteOf('09:05')).toBe(545);
    expect(minuteOf('24:00')).toBe(1440);
    expect(minuteOf('')).toBeUndefined();
  });

  it('starts someone with no schedule on the calendar’s hours, in the zone given', () => {
    expect(availabilityDraft(null, 'Africa/Nairobi')).toEqual({
      timezone: 'Africa/Nairobi',
      inheritCalendarHours: true,
      weeklyHours: [],
      dateOverrides: [],
    });
  });

  it('sends hours back in minutes, and keeps date overrides as they were', () => {
    const profile = {
      timezone: 'Africa/Nairobi',
      inheritCalendarHours: false,
      weeklyHours: [{ weekday: 1, startMinute: 540, endMinute: 1440 }],
      dateOverrides: [{ date: '2026-12-25', ranges: [] }],
    };
    const draft = availabilityDraft(profile, 'UTC');
    expect(draft.weeklyHours).toEqual([
      { key: expect.any(String) as string, weekday: 1, startTime: '09:00', endTime: '24:00' },
    ]);
    expect(availabilityProfile(draft)).toEqual({ ok: true, profile });
  });

  it('refuses hours with no time, or that end before they start', () => {
    const draft = availabilityDraft(null, 'UTC');
    expect(
      availabilityProfile({
        ...draft,
        inheritCalendarHours: false,
        weeklyHours: [{ key: 'a', weekday: 1, startTime: '', endTime: '17:00' }],
      }),
    ).toEqual({ ok: false });
    expect(
      availabilityProfile({
        ...draft,
        inheritCalendarHours: false,
        weeklyHours: [{ key: 'a', weekday: 1, startTime: '17:00', endTime: '09:00' }],
      }),
    ).toEqual({ ok: false });
  });
});
