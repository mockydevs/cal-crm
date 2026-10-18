import { notificationKinds } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import {
  dueSource,
  eventSource,
  formNotifyOf,
  holdersOf,
  idIn,
  kindOf,
  preferencesOf,
  recipientsOf,
  shortened,
  type MemberRole,
} from './rules.js';

const sam = '01890a5d-ac96-774b-bcce-b302099a8057';
const dana = '01890a5d-ac96-774b-bcce-b302099a8058';
const amina = '01890a5d-ac96-774b-bcce-b302099a8059';

describe('who is told', () => {
  it('is each candidate once, in the order given, without the blanks', () => {
    expect(recipientsOf([dana, null, sam, undefined, dana], { kind: 'system', id: null })).toEqual([
      dana,
      sam,
    ]);
    expect(recipientsOf([], { kind: 'system', id: null })).toEqual([]);
  });

  it('is never the person who caused it', () => {
    expect(recipientsOf([sam, dana], { kind: 'user', id: sam })).toEqual([dana]);
    expect(recipientsOf([sam], { kind: 'user', id: sam })).toEqual([]);
  });

  it.each(['automation', 'api_key', 'ai_agent', 'contact', 'form', 'import', 'system'] as const)(
    'still includes a person whose id a %s happens to carry: only a person causes as a person',
    (kind) => {
      expect(recipientsOf([sam], { kind, id: sam })).toEqual([sam]);
    },
  );
});

describe('who holds a permission', () => {
  const member = (
    userId: string,
    scope: 'agency' | 'business',
    key: string,
    custom?: readonly string[],
  ): MemberRole => ({
    userId,
    scope,
    key,
    isBuiltin: custom === undefined,
    permissions: custom ?? [],
  });

  it('in a business is whoever a built-in role allows, business or agency staff', () => {
    const members = [
      member(sam, 'business', 'owner'),
      member(dana, 'business', 'member'),
      member(amina, 'agency', 'admin'),
    ];
    expect(holdersOf(members, ['ai.manage'], 'business')).toEqual([sam, amina]);
    expect(holdersOf(members, ['conversations.reply'], 'business')).toEqual([sam, dana, amina]);
  });

  it('never includes a viewer, who may change nothing', () => {
    expect(
      holdersOf([member(dana, 'business', 'viewer')], ['conversations.reply'], 'business'),
    ).toEqual([]);
  });

  it('follows a custom role’s own list, and ignores keys the catalog does not have', () => {
    const members = [
      member(sam, 'business', 'front_desk', ['forms.manage', 'not.a.permission']),
      member(dana, 'business', 'support', ['conversations.reply']),
    ];
    expect(holdersOf(members, ['forms.manage'], 'business')).toEqual([sam]);
    expect(holdersOf(members, ['ai.manage'], 'business')).toEqual([]);
  });

  it('is any one of several permissions, and each person once', () => {
    const members = [
      member(sam, 'business', 'support', ['conversations.reply']),
      member(sam, 'agency', 'owner'),
      member(dana, 'business', 'triage', ['conversations.manage']),
      member(amina, 'business', 'bookkeeper', ['deals.manage']),
    ];
    expect(holdersOf(members, ['conversations.reply', 'conversations.manage'], 'business')).toEqual(
      [sam, dana],
    );
  });

  it('at the agency is only the agency’s own staff', () => {
    const members = [member(sam, 'business', 'owner'), member(amina, 'agency', 'owner')];
    expect(holdersOf(members, ['ai.manage'], 'agency')).toEqual([amina]);
  });
});

describe('preferences', () => {
  it('are every kind turned on for someone who never chose', () => {
    expect(preferencesOf([])).toEqual({
      items: notificationKinds.map((kind) =>
        kind === 'task.reminder'
          ? { kind, inApp: true, remindMinutes: null }
          : { kind, inApp: true },
      ),
    });
  });

  it('keep what was chosen for a kind, and the default for the rest, in the catalog’s order', () => {
    const preferences = preferencesOf([
      { kind: 'task.due', in_app: false },
      { kind: 'message.received_other', in_app: false },
      { kind: 'conversation.assigned', in_app: true },
    ]);
    expect(preferences.items.map(({ kind }) => kind)).toEqual([...notificationKinds]);
    expect(preferences.items.filter(({ inApp }) => !inApp).map(({ kind }) => kind)).toEqual([
      'message.received_other',
      'task.due',
    ]);
  });

  it('carry the reminder time chosen for task reminders, and none on any other kind', () => {
    const preferences = preferencesOf([
      { kind: 'task.reminder', in_app: true, remind_minutes: 30 },
      { kind: 'task.due', in_app: true, remind_minutes: null },
    ]);
    expect(preferences.items.filter((item) => 'remindMinutes' in item)).toEqual([
      { kind: 'task.reminder', inApp: true, remindMinutes: 30 },
    ]);
  });

  it('leave out a stored kind the catalog no longer has', () => {
    expect(preferencesOf([{ kind: 'review.received', in_app: false }]).items).toHaveLength(
      notificationKinds.length,
    );
    expect(kindOf('review.received')).toBeUndefined();
    expect(kindOf('task.due')).toBe('task.due');
  });
});

describe('an id in an event’s payload', () => {
  it('is read when it is one of our ids', () => {
    expect(idIn({ assignedUserId: sam }, 'assignedUserId')).toBe(sam);
  });

  it.each([
    ['is missing', {}],
    ['is not text', { assignedUserId: 7 }],
    ['is a public id', { assignedUserId: 'mem_01h455vb4pex5vsknk084sn02q' }],
    ['is a UUID of another version', { assignedUserId: '5f0c9e3a-8b1d-4c2e-9f3a-1b2c3d4e5f60' }],
    ['is SQL', { assignedUserId: "'; drop table notifications.notifications; --" }],
  ])('is none when it %s', (_name, payload) => {
    expect(idIn(payload, 'assignedUserId')).toBeUndefined();
  });

  it.each([[null], ['text'], [7], [undefined]])('is none in a payload that is %s', (payload) => {
    expect(idIn(payload, 'assignedUserId')).toBeUndefined();
  });
});

describe('text a notification holds', () => {
  it('is trimmed, and null when nothing is left', () => {
    expect(shortened('  Call the venue back ', 300)).toBe('Call the venue back');
    expect(shortened('   ', 300)).toBeNull();
    expect(shortened(null, 300)).toBeNull();
    expect(shortened(undefined, 300)).toBeNull();
  });

  it('is cut to its length with an ellipsis, counting characters and not their bytes', () => {
    expect(shortened('abcdef', 6)).toBe('abcdef');
    expect(shortened('abcdefg', 6)).toBe('abcde…');
    const cut = shortened('😀'.repeat(10), 4);
    expect(cut).toBe('😀😀😀…');
    expect(Array.from(cut ?? '')).toHaveLength(4);
  });
});

describe('what a notification is made once from', () => {
  it('is the event, or the task and its due time', () => {
    expect(eventSource(sam)).toBe(`event:${sam}`);
    expect(dueSource(sam, new Date('2026-10-12T09:00:00.000Z'))).toBe(
      `task.due:${sam}:2026-10-12T09:00:00.000Z`,
    );
    expect(dueSource(sam, new Date('2026-10-12T09:00:00.000Z'))).not.toBe(
      dueSource(sam, new Date('2026-10-13T09:00:00.000Z')),
    );
  });
});

describe('who a form says to tell of a submission', () => {
  const member = 'mem_01h455vb4pex5vsknk084sn02q';

  it('is what its published definition names', () => {
    for (const notify of [
      { mode: 'managers' },
      { mode: 'nobody' },
      { mode: 'contact_owner' },
      { mode: 'members', memberIds: [member] },
    ])
      expect(formNotifyOf({ fields: [], notify })).toEqual(notify);
  });

  it('is the people who manage forms when it names nothing, or nothing that can be read', () => {
    for (const definition of [
      // A form published before forms could say, one that is not published, and a
      // definition from before the builder.
      { fields: [] },
      null,
      undefined,
      'form',
      [],
      [{ notify: { mode: 'nobody' } }],
      { notify: null },
      { notify: 'nobody' },
      { notify: { mode: 'everyone' } },
      { notify: { mode: 'members' } },
      { notify: { mode: 'members', memberIds: [] } },
      { notify: { mode: 'members', memberIds: ['maya@example.test'] } },
      { notify: { mode: 'nobody', memberIds: [member] } },
    ])
      expect(formNotifyOf(definition), JSON.stringify(definition)).toEqual({ mode: 'managers' });
  });
});
