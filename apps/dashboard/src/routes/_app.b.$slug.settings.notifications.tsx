import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';

import { loadTaskRecurrenceWords } from '../task-recurrence-words';

// Settings → My Notifications, fetched with its words, which are a catalog of their own.
export const Route = createFileRoute('/_app/b/$slug/settings/notifications')({
  component: NotificationsRoute,
});

const NotificationSettingsPage = lazy(async () => {
  const [page] = await Promise.all([import('../notification-settings'), loadTaskRecurrenceWords()]);
  return { default: page.NotificationSettingsPage };
});

function NotificationsRoute(): ReactElement {
  return (
    <Suspense fallback={null}>
      <NotificationSettingsPage />
    </Suspense>
  );
}
