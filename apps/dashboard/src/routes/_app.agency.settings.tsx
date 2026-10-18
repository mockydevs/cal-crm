import { Trans } from '@lingui/react/macro';
import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import type { ReactElement } from 'react';

export const Route = createFileRoute('/_app/agency/settings')({ component: AgencySettings });
function AgencySettings(): ReactElement {
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-6">
      <nav
        aria-labelledby="agency-settings-label"
        className="flex max-w-60 flex-[1_1_200px] flex-col gap-0.5"
      >
        <span
          id="agency-settings-label"
          className="px-3.5 pb-2.5 text-sm font-semibold text-muted-foreground"
        >
          <Trans>Settings</Trans>
        </span>
        <Link
          to="/agency/settings/team"
          className="flex min-h-10 items-center rounded-full px-3.5 text-md hover:bg-muted data-[status=active]:bg-secondary data-[status=active]:font-semibold"
        >
          <Trans>Team and roles</Trans>
        </Link>
        <Link
          to="/agency/settings/apps"
          className="flex min-h-10 items-center rounded-full px-3.5 text-md hover:bg-muted data-[status=active]:bg-secondary data-[status=active]:font-semibold"
        >
          <Trans>Apps and API keys</Trans>
        </Link>
        <Link
          to="/agency/settings/marketplace-apps"
          className="flex min-h-10 items-center rounded-full px-3.5 text-md hover:bg-muted data-[status=active]:bg-secondary data-[status=active]:font-semibold"
        >
          <Trans>Marketplace apps</Trans>
        </Link>
        <Link
          to="/agency/settings/ai-models"
          className="flex min-h-10 items-center rounded-full px-3.5 text-md hover:bg-muted data-[status=active]:bg-secondary data-[status=active]:font-semibold"
        >
          <Trans>AI models</Trans>
        </Link>
        <Link
          to="/agency"
          className="flex min-h-10 items-center rounded-full px-3.5 text-sm text-muted-foreground hover:bg-muted"
        >
          <Trans>Back to businesses</Trans>
        </Link>
      </nav>
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-[18px]">
        <Outlet />
      </div>
    </div>
  );
}
