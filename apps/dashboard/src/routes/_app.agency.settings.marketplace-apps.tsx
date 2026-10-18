import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { api } from '../api';
import { loadMarketplaceWords } from '../marketplace-words';
import { meQuery } from '../workspace';

// Agency settings → Marketplace apps: the apps the agency publishes to its businesses.
export const Route = createFileRoute('/_app/agency/settings/marketplace-apps')({
  component: AgencyMarketplaceAppsRoute,
});

const AgencyMarketplaceAppsPage = lazy(async () => {
  const [page] = await Promise.all([import('../marketplace-agency'), loadMarketplaceWords()]);
  return { default: page.AgencyMarketplaceAppsPage };
});

function AgencyMarketplaceAppsRoute(): ReactElement {
  const { agency } = useSuspenseQuery(meQuery).data;
  return (
    <Suspense fallback={null}>
      <AgencyMarketplaceAppsPage key={agency.slug} client={api} agencyId={agency.slug} />
    </Suspense>
  );
}
