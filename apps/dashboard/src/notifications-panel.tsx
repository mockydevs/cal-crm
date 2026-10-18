// What the top bar's bell opens: one person's notifications in the business they are
// working in, newest first, a page at a time. Opening one marks it read and goes to the
// page that shows what it is about; "Mark all as read" covers what was shown, so anything
// that arrives meanwhile stays unread. Loaded only when the bell is first opened.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type Notification,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { notificationPlace, timeAgo } from './notification-rules';

export const notificationsKey = (businessId: string) => ['b', businessId, 'notifications'] as const;

/** The sentence a notification is: who or what, and about which record or title. */
function useSentence(): (notification: Notification) => string {
  const { t } = useLingui();
  return (notification) => {
    const actor = notification.actor.name ?? t`Someone`;
    const record = notification.record?.name ?? t`A contact`;
    const title = notification.title ?? t`Untitled`;
    switch (notification.kind) {
      case 'conversation.assigned':
        return notification.record === null
          ? t`${actor} assigned you a conversation.`
          : t`${actor} assigned you the conversation with ${record}.`;
      case 'message.received':
        return t`${record} sent a message in your conversation.`;
      case 'message.received_other':
        return t`${record} sent a message.`;
      case 'message.received_following':
        return t`${record}, whom you follow, sent a message.`;
      case 'task.assigned':
        return t`${actor} assigned you a task: ${title}`;
      case 'task.reminder':
        return t`Reminder: a task is due soon: ${title}`;
      case 'task.due':
        return t`A task is due: ${title}`;
      case 'appointment.booked':
        return t`An appointment was booked: ${title}`;
      case 'appointment.rescheduled':
        return t`An appointment was moved: ${title}`;
      case 'appointment.cancelled':
        return t`An appointment was cancelled: ${title}`;
      case 'form.submitted':
        return t`Someone filled in the form ${title}.`;
      case 'ai.limit_reached':
        return t`The monthly AI spending limit was reached.`;
      case 'automation.notice':
        return notification.body ?? t`The workflow ${title} sent a notice.`;
      case 'calendar.google_disconnected':
        return t`Google Calendar was disconnected. Bookings no longer check it: connect it again.`;
    }
  };
}

export default function NotificationsPanel({
  businessId,
  slug,
  onNavigate,
}: {
  readonly businessId: string;
  readonly slug: string;
  /** Called when a notification is opened, so the bell can close. */
  readonly onNavigate: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const cache = useQueryClient();
  const api = apiIn(businessId);
  const sentence = useSentence();
  const [unreadOnly, setUnreadOnly] = useState(false);
  // One moment for every row, taken when the panel is drawn.
  const [now] = useState(() => Date.now());

  const list = useInfiniteQuery({
    queryKey: [...notificationsKey(businessId), 'list', unreadOnly],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      api.request(listNotifications, {
        query: {
          state: unreadOnly ? 'unread' : 'all',
          ...(pageParam === undefined ? {} : { after: pageParam }),
        },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const newest = items[0];
  const anyUnread = items.some((each) => each.readAt === null);

  const refresh = () => cache.invalidateQueries({ queryKey: notificationsKey(businessId) });
  const readOne = useMutation({
    mutationFn: (notification: Notification) =>
      api.request(markNotificationRead, { params: { id: notification.id } }),
    onSettled: refresh,
  });
  const readAll = useMutation({
    mutationFn: (through: string) => api.request(markAllNotificationsRead, { body: { through } }),
    onSettled: refresh,
  });

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label={t`Which notifications`} className="flex gap-1">
          <Button
            variant={unreadOnly ? 'quiet' : 'secondary'}
            size="small"
            aria-pressed={!unreadOnly}
            onClick={() => {
              setUnreadOnly(false);
            }}
          >
            <Trans>All</Trans>
          </Button>
          <Button
            variant={unreadOnly ? 'secondary' : 'quiet'}
            size="small"
            aria-pressed={unreadOnly}
            onClick={() => {
              setUnreadOnly(true);
            }}
          >
            <Trans>Unread</Trans>
          </Button>
        </div>
        <Button
          variant="quiet"
          size="small"
          disabled={newest === undefined || !anyUnread || readAll.isPending}
          onClick={() => {
            if (newest !== undefined) readAll.mutate(newest.id);
          }}
        >
          <Trans>Mark all as read</Trans>
        </Button>
      </div>
      {readAll.isError || readOne.isError ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          <Trans>That wasn't saved. Check your connection and try again.</Trans>
        </p>
      ) : null}
      {list.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading notifications…</Trans>
        </p>
      ) : null}
      {list.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>
            <Trans>The notifications couldn't be loaded.</Trans>
          </p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void list.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {list.data !== undefined && items.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {unreadOnly ? (
            <Trans>You have read everything.</Trans>
          ) : (
            <Trans>No notifications yet.</Trans>
          )}
        </p>
      ) : null}
      {items.length === 0 ? null : (
        <ul aria-label={t`Notifications`} className="flex min-w-0 flex-col">
          {items.map((notification) => {
            const unread = notification.readAt === null;
            return (
              <li key={notification.id} className="border-t border-border first:border-t-0">
                <Link
                  {...notificationPlace(notification.target)}
                  params={{ slug }}
                  className="flex min-h-11 min-w-0 items-start gap-2 rounded-control px-1.5 py-2 -outline-offset-2 hover:bg-muted"
                  onClick={() => {
                    if (unread) readOne.mutate(notification);
                    onNavigate();
                  }}
                >
                  <span
                    aria-hidden
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${unread ? 'bg-primary' : 'bg-transparent'}`}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span
                      className={`text-sm wrap-anywhere ${unread ? 'font-medium text-foreground' : 'text-body'}`}
                    >
                      {sentence(notification)}
                      {unread ? (
                        <span className="sr-only">
                          {' '}
                          <Trans>(unread)</Trans>
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {timeAgo(notification.createdAt, now, i18n.locale)}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {list.hasNextPage ? (
        <Button
          variant="secondary"
          size="small"
          className="self-start"
          disabled={list.isFetchingNextPage}
          onClick={() => {
            void list.fetchNextPage();
          }}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </div>
  );
}
