import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Page } from '../shell/page';
import { secondaryLinkClassName } from '../contacts';
import { dashboardSearchOf } from '../dashboard-search';
import { DashboardWidgetsLoader } from '../dashboard-widgets-loader';
import { OverdueTasks } from '../record-tasks';
import { useBusiness } from '../workspace';
import { MailboxAlerts } from '../mailbox-alerts';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/');

export const Route = createFileRoute('/_app/b/$slug/')({
  validateSearch: dashboardSearchOf,
  component: TodayPage,
});

function TodayPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <Page
      title={t`Dashboard`}
      actions={
        <Link
          to="/b/$slug/tasks"
          params={{ slug: business.slug }}
          search={{ assignee: 'mine' }}
          className={secondaryLinkClassName}
        >
          <Trans>My tasks</Trans>
        </Link>
      }
    >
      <MailboxAlerts key={`mailbox-alerts:${business.id}`} />
      <DashboardWidgetsLoader
        key={`widgets:${business.id}`}
        search={search}
        onSearch={(next) => {
          void navigate({ search: next, replace: true });
        }}
      />
      <OverdueTasks key={business.id} />
    </Page>
  );
}
