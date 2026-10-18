// What the top bar's bell reads and writes: one person's notifications in the business they
// work in, how many are unread, and which kinds they chose to receive.
//
// A notification never carries an address to open. It names what it is about as a typed
// reference (`target`), and the dashboard decides which of its own pages shows that. It
// carries no message text and no contact's details either: `record` is read when the list
// is, from the record as it is then.
import * as z from 'zod';

import { actor } from './activity.js';
import { defineEndpoint } from './endpoints.js';
import { publicId, recordId } from './ids.js';
import { timestamp } from './timestamps.js';

/**
 * Every kind of notification, in the order the preferences list them. Each is one switch
 * in a person's preferences. The database holds the same list (migration 0056).
 */
export const notificationKinds = [
  // A conversation was given to you.
  'conversation.assigned',
  // A contact wrote in a conversation that is yours.
  'message.received',
  // A contact wrote in any other conversation: nobody's yet, or someone else's.
  'message.received_other',
  // A contact you follow wrote, in a conversation that is not yours.
  'message.received_following',
  'task.assigned',
  // A task of yours is due soon: as long before its due time as you chose.
  'task.reminder',
  // A task of yours reached its due time, still open.
  'task.due',
  // An appointment that is yours was booked, moved or cancelled.
  'appointment.booked',
  'appointment.rescheduled',
  'appointment.cancelled',
  // Someone filled in a form you manage.
  'form.submitted',
  // The business's monthly AI spending limit was reached.
  'ai.limit_reached',
  // What an automation's "Notify the team" step says.
  'automation.notice',
  // Your Google Calendar stopped answering: expired or revoked.
  'calendar.google_disconnected',
  // An integration of the business stopped working and needs someone who manages them.
  'integration.needs_attention',
] as const;

export type NotificationKind = (typeof notificationKinds)[number];

/** How many notifications a page of the list holds. */
export const NOTIFICATION_PAGE_SIZE = 25;

/** The most unread notifications the bell counts: beyond it, it shows this many "and more". */
export const UNREAD_NOTIFICATIONS_SHOWN = 99;

/** Whether a kind is received when the person never chose: every kind is. */
export const NOTIFICATION_DEFAULT_IN_APP = true;

export const notificationTarget = z
  .discriminatedUnion('kind', [
    z.looseObject({ kind: z.literal('conversation'), id: publicId('conversation') }),
    z.looseObject({ kind: z.literal('task'), id: publicId('task') }),
    z.looseObject({ kind: z.literal('form'), id: publicId('form') }),
    z.looseObject({ kind: z.literal('appointment'), id: publicId('appointment') }),
    z.looseObject({ kind: z.literal('automation'), id: publicId('automation') }),
    z.looseObject({ kind: z.literal('ai_settings') }),
    z.looseObject({ kind: z.literal('calendar_connections') }),
    z.looseObject({ kind: z.literal('integrations') }),
  ])
  .meta({
    id: 'NotificationTarget',
    description:
      "What the notification is about, for the dashboard to open: a kind and that kind's id, never an address. `ai_settings` is the business's own AI settings, `calendar_connections` your own calendar connections and `integrations` the business's integrations; none has an id.",
  });

export type NotificationTarget = z.infer<typeof notificationTarget>;

export const notification = z
  .looseObject({
    id: publicId('notification'),
    kind: z.enum(notificationKinds),
    target: notificationTarget,
    record: z
      .looseObject({
        id: recordId,
        name: z.string().nullable().meta({
          description: "The record's name as it is now. Null when it has none.",
        }),
        trashed: z.boolean(),
      })
      .nullable()
      .meta({
        description:
          'The contact, company or deal it is about, read when the list is. Null when it is about none.',
      }),
    title: z
      .string()
      .nullable()
      .meta({
        description:
          "The target's own name when the notification was made: a task's title, a form's, an appointment's or an automation's name. Null for a conversation and for AI settings.",
        examples: ['Call the venue back'],
      }),
    body: z.string().nullable().meta({
      description:
        "Only for `automation.notice`: the words the automation's step was given, with its merge fields filled in.",
    }),
    actor: actor.meta({
      description: 'Who or what caused it. Never you: nobody is told of what they did themselves.',
    }),
    readAt: timestamp.nullable(),
    createdAt: timestamp,
  })
  .meta({
    id: 'Notification',
    description: 'Something one team member is told inside the app.',
  });

export type Notification = z.infer<typeof notification>;

export const notificationList = z
  .looseObject({
    items: z.array(notification).meta({ description: 'Newest first.' }),
    nextCursor: publicId('notification').nullable().meta({
      description: 'Pass it as after to read the next page. Null on the last page.',
    }),
  })
  .meta({ id: 'NotificationList', description: 'A page of your notifications.' });

export type NotificationList = z.infer<typeof notificationList>;

export const unreadNotificationCount = z
  .looseObject({
    unread: z
      .int()
      .min(0)
      .max(UNREAD_NOTIFICATIONS_SHOWN)
      .meta({
        description: `How many of your notifications here are unread, counted up to ${String(UNREAD_NOTIFICATIONS_SHOWN)}.`,
      }),
    more: z.boolean().meta({
      description: `Whether there are more unread than that: the bell then shows "${String(UNREAD_NOTIFICATIONS_SHOWN)}+".`,
    }),
  })
  .meta({ id: 'UnreadNotificationCount' });

export type UnreadNotificationCount = z.infer<typeof unreadNotificationCount>;

export const listNotificationsQuery = z.strictObject({
  state: z.enum(['all', 'unread']).default('all'),
  after: publicId('notification')
    .optional()
    .meta({ description: "Start after this notification: the previous page's nextCursor." }),
});

export const markAllNotificationsReadInput = z
  .strictObject({
    through: publicId('notification').meta({
      description:
        'The newest notification you were shown. Everything up to it is marked read; what arrived after it stays unread.',
    }),
  })
  .meta({ id: 'MarkAllNotificationsReadInput' });

/** The longest a task reminder may come before the task is due: 30 days, in minutes. */
export const MAX_TASK_REMINDER_MINUTES = 43_200;

const remindMinutes = z.int().min(1).max(MAX_TASK_REMINDER_MINUTES).nullable().meta({
  description:
    'task.reminder only: how many minutes before a task assigned to you is due you are reminded, up to 30 days. null: no reminder.',
});

const preference = z.looseObject({
  kind: z.enum(notificationKinds),
  inApp: z.boolean().meta({ description: 'Whether you are told of this kind inside the app.' }),
  remindMinutes: remindMinutes.optional(),
});

export const notificationPreferences = z
  .looseObject({
    items: z.array(preference).meta({ description: 'Every kind, in a fixed order.' }),
  })
  .meta({
    id: 'NotificationPreferences',
    description: 'Which kinds of notification you receive in this business.',
  });

export type NotificationPreferences = z.infer<typeof notificationPreferences>;

export const updateNotificationPreferencesInput = z
  .strictObject({
    items: z
      .array(
        z
          .strictObject({
            kind: z.enum(notificationKinds),
            inApp: z.boolean(),
            remindMinutes: remindMinutes.optional(),
          })
          .refine((item) => item.remindMinutes === undefined || item.kind === 'task.reminder', {
            path: ['remindMinutes'],
            error: 'Only a task reminder has a time.',
          }),
      )
      .min(1)
      .max(notificationKinds.length)
      .refine((items) => new Set(items.map((item) => item.kind)).size === items.length, {
        error: 'Name each kind once.',
      })
      .meta({ description: 'The kinds to change. Kinds left out stay as they are.' }),
  })
  .meta({ id: 'UpdateNotificationPreferencesInput' });

const notificationParams = z.object({ id: publicId('notification') });

export const listNotifications = defineEndpoint({
  operationId: 'listNotifications',
  method: 'get',
  path: '/notifications',
  summary: 'List your notifications',
  group: 'Notifications',
  query: listNotificationsQuery,
  response: {
    status: 200,
    description: `Your notifications where you work, newest first, ${String(NOTIFICATION_PAGE_SIZE)} at a time. Nobody else's are ever listed.`,
    schema: notificationList,
  },
});

export const getUnreadNotificationCount = defineEndpoint({
  operationId: 'getUnreadNotificationCount',
  method: 'get',
  path: '/notifications/unread-count',
  summary: 'Count your unread notifications',
  group: 'Notifications',
  response: {
    status: 200,
    description: 'The number the bell shows. Cheap to read on every page.',
    schema: unreadNotificationCount,
  },
});

export const markNotificationRead = defineEndpoint({
  operationId: 'markNotificationRead',
  method: 'post',
  path: '/notifications/{id}/read',
  summary: 'Mark one of your notifications read',
  group: 'Notifications',
  params: notificationParams,
  response: {
    status: 200,
    description: 'The notification, read. Marking it again changes nothing.',
    schema: notification,
  },
});

export const markAllNotificationsRead = defineEndpoint({
  operationId: 'markAllNotificationsRead',
  method: 'post',
  path: '/notifications/read-all',
  summary: 'Mark your notifications read, up to one you were shown',
  group: 'Notifications',
  body: markAllNotificationsReadInput,
  response: {
    status: 200,
    description: 'How many are unread afterwards.',
    schema: unreadNotificationCount,
  },
});

export const getNotificationPreferences = defineEndpoint({
  operationId: 'getNotificationPreferences',
  method: 'get',
  path: '/notification-preferences',
  summary: 'Read which notifications you receive in this business',
  group: 'Notifications',
  response: { status: 200, description: 'Every kind, on or off.', schema: notificationPreferences },
});

export const updateNotificationPreferences = defineEndpoint({
  operationId: 'updateNotificationPreferences',
  method: 'put',
  path: '/notification-preferences',
  summary: 'Choose which notifications you receive in this business',
  group: 'Notifications',
  body: updateNotificationPreferencesInput,
  response: {
    status: 200,
    description: 'Your preferences after the change.',
    schema: notificationPreferences,
  },
});

/** The bell's endpoints, in the order the reference lists them. */
export const notificationEndpoints = [
  listNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  getNotificationPreferences,
  updateNotificationPreferences,
] as const;
