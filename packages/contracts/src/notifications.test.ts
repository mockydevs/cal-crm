import { describe, expect, it } from 'vitest';

import {
  endpoints,
  getNotificationPreferences,
  getUnreadNotificationCount,
  listNotifications,
  listNotificationsQuery,
  markAllNotificationsRead,
  markAllNotificationsReadInput,
  markNotificationRead,
  notification,
  notificationEndpoints,
  notificationKinds,
  notificationList,
  notificationPreferences,
  notificationTarget,
  NOTIFICATION_DEFAULT_IN_APP,
  NOTIFICATION_PAGE_SIZE,
  unreadNotificationCount,
  UNREAD_NOTIFICATIONS_SHOWN,
  updateNotificationPreferences,
  updateNotificationPreferencesInput,
  type Endpoint,
} from './index.js';
import { openApiDocument } from './openapi.js';

const id = 'ntf_01h455vb4pex5vsknk084sn02q';
const at = '2026-10-10T09:00:00.000Z';
const sam = { kind: 'user', name: 'Sam Okoro', you: false };

const assigned = {
  id,
  kind: 'conversation.assigned',
  target: { kind: 'conversation', id: 'cvn_01h455vb4pex5vsknk084sn02q' },
  record: { id: 'con_01h455vb4pex5vsknk084sn02q', name: 'Jordan Lee', trashed: false },
  title: null,
  body: null,
  actor: sam,
  readAt: null,
  createdAt: at,
};

describe('the kinds of notification', () => {
  it('are these fourteen, in the order the preferences list them', () => {
    expect(notificationKinds).toEqual([
      'conversation.assigned',
      'message.received',
      'message.received_other',
      'message.received_following',
      'task.assigned',
      'task.reminder',
      'task.due',
      'appointment.booked',
      'appointment.rescheduled',
      'appointment.cancelled',
      'form.submitted',
      'ai.limit_reached',
      'automation.notice',
      'calendar.google_disconnected',
    ]);
    expect(new Set(notificationKinds).size).toBe(notificationKinds.length);
  });

  it('are all received by someone who never chose', () => {
    expect(NOTIFICATION_DEFAULT_IN_APP).toBe(true);
  });
});

describe('a notification', () => {
  it('names what it is about by kind and id, with the record as it is now', () => {
    expect(notification.parse(assigned)).toEqual(assigned);
  });

  it.each([
    ['a task', { kind: 'task', id: 'task_01h455vb4pex5vsknk084sn02q' }],
    ['a form', { kind: 'form', id: 'form_01h455vb4pex5vsknk084sn02q' }],
    ['an appointment', { kind: 'appointment', id: 'appt_01h455vb4pex5vsknk084sn02q' }],
    ['an automation', { kind: 'automation', id: 'aut_01h455vb4pex5vsknk084sn02q' }],
    ["the business's AI settings, which have no id", { kind: 'ai_settings' }],
    ['your own calendar connections, which have no id', { kind: 'calendar_connections' }],
  ])('can be about %s', (_name, target) => {
    expect(notificationTarget.parse(target)).toEqual(target);
  });

  it.each([
    ['an address', { kind: 'url', href: 'https://elsewhere.example/phish' }],
    ['an address beside a kind', 'https://elsewhere.example/phish'],
    ['an id of another kind', { kind: 'task', id: 'con_01h455vb4pex5vsknk084sn02q' }],
    ['a kind with no id', { kind: 'conversation' }],
    ['a kind the dashboard has no page for', { kind: 'secret', id }],
  ])('is never about %s', (_name, target) => {
    expect(notificationTarget.safeParse(target).success).toBe(false);
    expect(notification.safeParse({ ...assigned, target }).success).toBe(false);
  });

  it('is about no record when it has none, and may have been read', () => {
    const limit = {
      ...assigned,
      kind: 'ai.limit_reached',
      target: { kind: 'ai_settings' },
      record: null,
      actor: { kind: 'system', name: null, you: false },
      readAt: at,
    };
    expect(notification.parse(limit)).toEqual(limit);
  });

  it('refuses a kind the catalog does not have', () => {
    expect(notification.safeParse({ ...assigned, kind: 'contact.created' }).success).toBe(false);
  });

  it('comes in pages that say where the next one starts', () => {
    expect(notificationList.parse({ items: [assigned], nextCursor: id })).toEqual({
      items: [assigned],
      nextCursor: id,
    });
    expect(notificationList.parse({ items: [], nextCursor: null }).nextCursor).toBeNull();
    expect(NOTIFICATION_PAGE_SIZE).toBe(25);
  });
});

describe('listing notifications', () => {
  it('reads everything unless asked for the unread ones, from a cursor', () => {
    expect(listNotificationsQuery.parse({})).toEqual({ state: 'all' });
    expect(listNotificationsQuery.parse({ state: 'unread', after: id })).toEqual({
      state: 'unread',
      after: id,
    });
  });

  it.each([
    ['another state', { state: 'read' }],
    ['a cursor of another kind', { after: 'task_01h455vb4pex5vsknk084sn02q' }],
    ["someone else's notifications", { userId: 'mem_01h455vb4pex5vsknk084sn02q' }],
    ['a page size', { limit: 500 }],
  ])('refuses %s', (_name, query) => {
    expect(listNotificationsQuery.safeParse(query).success).toBe(false);
  });
});

describe('the unread count', () => {
  it('counts up to the number the bell shows, and says when there are more', () => {
    expect(UNREAD_NOTIFICATIONS_SHOWN).toBe(99);
    expect(unreadNotificationCount.parse({ unread: 0, more: false })).toEqual({
      unread: 0,
      more: false,
    });
    expect(unreadNotificationCount.parse({ unread: 99, more: true })).toEqual({
      unread: 99,
      more: true,
    });
  });

  it.each([[-1], [100], [1.5]])('is never %s', (unread) => {
    expect(unreadNotificationCount.safeParse({ unread, more: false }).success).toBe(false);
  });
});

describe('marking everything read', () => {
  it('names the newest notification the person was shown', () => {
    expect(markAllNotificationsReadInput.parse({ through: id })).toEqual({ through: id });
  });

  it.each([
    ['nothing', {}],
    ['a time', { through: at }],
    ['an id of another kind', { through: 'con_01h455vb4pex5vsknk084sn02q' }],
    ['whose notifications', { through: id, userId: 'mem_01h455vb4pex5vsknk084sn02q' }],
  ])('refuses %s', (_name, input) => {
    expect(markAllNotificationsReadInput.safeParse(input).success).toBe(false);
  });
});

describe('notification preferences', () => {
  it('are read as every kind, on or off', () => {
    const all = { items: notificationKinds.map((kind) => ({ kind, inApp: true })) };
    expect(notificationPreferences.parse(all)).toEqual(all);
  });

  it('are changed a kind at a time or several at once', () => {
    const input = {
      items: [
        { kind: 'message.received', inApp: false },
        { kind: 'task.due', inApp: true },
      ],
    };
    expect(updateNotificationPreferencesInput.parse(input)).toEqual(input);
  });

  it('carry how long before a task is due its reminder comes, or none', () => {
    for (const remindMinutes of [1, 15, 1440, 43_200, null]) {
      const input = { items: [{ kind: 'task.reminder', inApp: true, remindMinutes }] };
      expect(updateNotificationPreferencesInput.parse(input)).toEqual(input);
    }
    const read = { items: [{ kind: 'task.reminder', inApp: true, remindMinutes: 30 }] };
    expect(notificationPreferences.parse(read)).toEqual(read);
  });

  it.each([
    ['no kind', { items: [] }],
    ['a kind the catalog does not have', { items: [{ kind: 'contact.created', inApp: false }] }],
    [
      'a kind twice',
      {
        items: [
          { kind: 'task.due', inApp: false },
          { kind: 'task.due', inApp: true },
        ],
      },
    ],
    ['a channel that does not exist', { items: [{ kind: 'task.due', inApp: true, email: true }] }],
    ['something that is not a switch', { items: [{ kind: 'task.due', inApp: 'yes' }] }],
    [
      'a time on a kind that is not a reminder',
      { items: [{ kind: 'task.due', inApp: true, remindMinutes: 15 }] },
    ],
    [
      'a reminder no time before',
      { items: [{ kind: 'task.reminder', inApp: true, remindMinutes: 0 }] },
    ],
    [
      'a reminder more than 30 days before',
      { items: [{ kind: 'task.reminder', inApp: true, remindMinutes: 43_201 }] },
    ],
    [
      "someone else's preferences",
      { userId: 'mem_01h455vb4pex5vsknk084sn02q', items: [{ kind: 'task.due', inApp: false }] },
    ],
  ])('refuse %s', (_name, input) => {
    expect(updateNotificationPreferencesInput.safeParse(input).success).toBe(false);
  });
});

describe('the notification endpoints', () => {
  it('are these six, all part of the public API', () => {
    expect(notificationEndpoints.map((each) => [each.method, each.path, each.operationId])).toEqual(
      [
        ['get', '/notifications', 'listNotifications'],
        ['get', '/notifications/unread-count', 'getUnreadNotificationCount'],
        ['post', '/notifications/{id}/read', 'markNotificationRead'],
        ['post', '/notifications/read-all', 'markAllNotificationsRead'],
        ['get', '/notification-preferences', 'getNotificationPreferences'],
        ['put', '/notification-preferences', 'updateNotificationPreferences'],
      ],
    );
    for (const endpoint of notificationEndpoints) expect(endpoints).toContain(endpoint);
    expect([
      listNotifications,
      getUnreadNotificationCount,
      markNotificationRead,
      markAllNotificationsRead,
      getNotificationPreferences,
      updateNotificationPreferences,
    ]).toEqual([...notificationEndpoints]);
  });

  it('take no id of a person anywhere: they are always the caller’s own', () => {
    const each: readonly Endpoint[] = notificationEndpoints;
    for (const endpoint of each) {
      const names = [
        ...Object.keys(endpoint.params?.shape ?? {}),
        ...Object.keys(endpoint.query?.shape ?? {}),
      ];
      expect(names.filter((name) => /user|member|person/i.test(name))).toEqual([]);
    }
  });

  it('are described in the OpenAPI document, under Notifications', () => {
    const document = openApiDocument();
    for (const endpoint of notificationEndpoints) {
      expect(document.paths?.[endpoint.path]?.[endpoint.method]).toMatchObject({
        operationId: endpoint.operationId,
        tags: ['Notifications'],
      });
    }
    expect(document.components?.schemas).toHaveProperty('Notification');
    expect(document.components?.schemas).toHaveProperty('NotificationTarget');
  });
});
