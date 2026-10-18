// The bell in the top bar: how many notifications are unread in the business the page is
// in, and the list of them when it is opened. The count is read again every minute and when
// the window is returned to; the list is loaded the first time the bell is opened.
import { Trans, useLingui } from '@lingui/react/macro';
import { getUnreadNotificationCount } from '@repo/contracts';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@repo/ui/components/popover';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { lazy, Suspense, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { bellCount } from '../notification-rules';

const NotificationsPanel = lazy(() => import('../notifications-panel'));

const COUNT_EVERY_MS = 60_000;

export function NotificationsBell({
  businessId,
  slug,
}: {
  readonly businessId: string;
  readonly slug: string;
}): ReactElement {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const count = useQuery({
    // Under the key the panel refreshes, so reading one there updates the number here.
    queryKey: ['b', businessId, 'notifications', 'unread-count'],
    queryFn: () => apiIn(businessId).request(getUnreadNotificationCount, {}),
    refetchInterval: COUNT_EVERY_MS,
    retry: false,
  });
  const shown = bellCount(count.data);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={shown === undefined ? t`Notifications` : t`Notifications, ${shown} unread`}
        className="relative flex size-11 items-center justify-center rounded-full text-body hover:bg-muted data-popup-open:bg-muted lg:size-9"
      >
        <Bell aria-hidden className="size-5" strokeWidth={1.8} />
        {shown === undefined ? null : (
          <span
            aria-hidden
            className="absolute top-1 right-0.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[11px] leading-4 font-medium text-destructive-foreground lg:top-0 lg:-right-0.5"
          >
            {shown}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(380px,calc(100vw-1rem))]">
        <PopoverTitle>
          <Trans>Notifications</Trans>
        </PopoverTitle>
        <Suspense
          fallback={
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading notifications…</Trans>
            </p>
          }
        >
          <NotificationsPanel
            businessId={businessId}
            slug={slug}
            onNavigate={() => {
              setOpen(false);
            }}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
