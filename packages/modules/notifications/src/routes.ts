// The bell's six endpoints. None runs a command: reading your own notifications, marking
// them read and choosing which kinds you receive need no permission, so every role does
// them. Each is the caller's own by construction: no endpoint takes a person's id.
import type { ApiRoute, Route } from '@repo/commands';
import {
  getNotificationPreferences,
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markAllNotificationsReadInput,
  markNotificationRead,
  parseInput,
  updateNotificationPreferences,
  updateNotificationPreferencesInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import { readPreferences, savePreferences } from './preferences.js';
import {
  countUnread,
  markAllRead,
  markRead,
  readNotifications,
  type NotificationOptions,
} from './store.js';

export function createNotificationRoutes(options: NotificationOptions): readonly ApiRoute[] {
  return [
    {
      endpoint: listNotifications,
      run({ invocation, query }, { db }) {
        const parsed = parseInput(listNotifications.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readNotifications(trx, invocation, parsed, options),
        );
      },
    } satisfies Route<typeof listNotifications>,
    {
      endpoint: getUnreadNotificationCount,
      run({ invocation }, { db }) {
        return withTenant(db, invocation.context, (trx) => countUnread(trx, invocation));
      },
    } satisfies Route<typeof getUnreadNotificationCount>,
    {
      endpoint: markNotificationRead,
      run({ invocation, params }, { db }) {
        const { id } = parseInput(markNotificationRead.params, params);
        return withTenant(db, invocation.context, (trx) => markRead(trx, invocation, id, options));
      },
    } satisfies Route<typeof markNotificationRead>,
    {
      endpoint: markAllNotificationsRead,
      run({ invocation, body }, { db }) {
        const { through } = parseInput(markAllNotificationsReadInput, body);
        return withTenant(db, invocation.context, (trx) => markAllRead(trx, invocation, through));
      },
    } satisfies Route<typeof markAllNotificationsRead>,
    {
      endpoint: getNotificationPreferences,
      run({ invocation }, { db }) {
        return withTenant(db, invocation.context, (trx) => readPreferences(trx, invocation));
      },
    } satisfies Route<typeof getNotificationPreferences>,
    {
      endpoint: updateNotificationPreferences,
      run({ invocation, body }, { db }) {
        const parsed = parseInput(updateNotificationPreferencesInput, body);
        return withTenant(db, invocation.context, (trx) =>
          savePreferences(trx, invocation, parsed),
        );
      },
    } satisfies Route<typeof updateNotificationPreferences>,
  ];
}
