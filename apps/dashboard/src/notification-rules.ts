// What the top bar's bell works out before it draws: the number on it, and the page of this
// dashboard a notification opens. A notification names what it is about, never an address,
// so the mapping to pages lives here.
import type { NotificationTarget, UnreadNotificationCount } from '@repo/contracts';

/** The number on the bell: nothing when all are read, and "99+" past what the server counts. */
export function bellCount(count: UnreadNotificationCount | undefined): string | undefined {
  if (count === undefined || count.unread === 0) return undefined;
  return count.more ? `${String(count.unread)}+` : String(count.unread);
}

/** A page in a business, as the router takes it. */
export type NotificationPlace =
  | { readonly to: '/b/$slug/inbox'; readonly search: { readonly conversation: string } }
  | { readonly to: '/b/$slug/automations'; readonly search: { readonly automation: string } }
  | { readonly to: '/b/$slug/tasks' }
  | { readonly to: '/b/$slug/calendar'; readonly search: { readonly appointment: string } }
  | { readonly to: '/b/$slug/settings/forms' }
  | { readonly to: '/b/$slug/settings/ai-models' }
  | { readonly to: '/b/$slug/settings/calendars/connections' };

/**
 * The page that shows what a notification is about. A conversation, a workflow and an
 * appointment open on the one named; a task and a form open the page that lists them,
 * which has no address for one of them.
 */
export function notificationPlace(target: NotificationTarget): NotificationPlace {
  switch (target.kind) {
    case 'conversation':
      return { to: '/b/$slug/inbox', search: { conversation: target.id } };
    case 'automation':
      return { to: '/b/$slug/automations', search: { automation: target.id } };
    case 'task':
      return { to: '/b/$slug/tasks' };
    case 'appointment':
      return { to: '/b/$slug/calendar', search: { appointment: target.id } };
    case 'form':
      return { to: '/b/$slug/settings/forms' };
    case 'ai_settings':
      return { to: '/b/$slug/settings/ai-models' };
    case 'calendar_connections':
      return { to: '/b/$slug/settings/calendars/connections' };
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago something happened, in the largest whole unit: "5 minutes ago", "yesterday". */
export function timeAgo(then: string, now: number, locale: string): string {
  const passed = Math.max(0, now - new Date(then).getTime());
  const words = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (passed < MINUTE) return words.format(0, 'minute');
  if (passed < HOUR) return words.format(-Math.floor(passed / MINUTE), 'minute');
  if (passed < DAY) return words.format(-Math.floor(passed / HOUR), 'hour');
  return words.format(-Math.floor(passed / DAY), 'day');
}
