import { Trans, useLingui } from '@lingui/react/macro';
import { EmptyState } from '@repo/ui/components/empty-state';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { BusinessList } from '../shell/business-list';
import { Page } from '../shell/page';
import { meQuery } from '../workspace';

// Where the app opens, as after signing in: in the person's business when they have just
// one, at the agency for its staff, and otherwise on a list of their businesses to choose
// from.
export const Route = createFileRoute('/_app/')({
  beforeLoad: async ({ context }) => {
    const { agencyStaff, businesses } = await context.queryClient.query(meQuery);
    const [only, ...others] = businesses;
    if (only !== undefined && others.length === 0) {
      throw redirect({ to: '/b/$slug', params: { slug: only.slug }, replace: true });
    }
    if (agencyStaff) throw redirect({ to: '/agency', replace: true });
  },
  component: ChooseBusinessPage,
});

function ChooseBusinessPage(): ReactElement {
  const { t } = useLingui();
  const { businesses } = useSuspenseQuery(meQuery).data;
  return (
    <Page title={t`Choose a business`}>
      {businesses.length > 0 ? (
        <BusinessList businesses={businesses} />
      ) : (
        <EmptyState
          icon={<Building2 strokeWidth={1.8} />}
          title={<Trans>No business is open to you</Trans>}
          description={
            <Trans>
              The businesses you belong to are closed for now. Ask your agency to open one again.
            </Trans>
          }
        />
      )}
    </Page>
  );
}
