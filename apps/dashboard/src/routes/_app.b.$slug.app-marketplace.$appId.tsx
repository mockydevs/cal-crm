import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, useMemo, type ReactElement } from 'react';
import { apiIn } from '../api';
import { loadMarketplaceWords } from '../marketplace-words';
import { useBusiness } from '../workspace';

// An app's page in the App Marketplace: what it asks for, Install App and Uninstall.
export const Route = createFileRoute('/_app/b/$slug/app-marketplace/$appId')({
  component: MarketplaceAppRoute,
});

const MarketplaceAppPage = lazy(async () => {
  const [page] = await Promise.all([import('../marketplace-app'), loadMarketplaceWords()]);
  return { default: page.MarketplaceAppPage };
});

function MarketplaceAppRoute(): ReactElement {
  const business = useBusiness();
  const { appId } = Route.useParams();
  const client = useMemo(() => apiIn(business.id), [business.id]);
  return (
    <Suspense fallback={null}>
      <MarketplaceAppPage
        key={`${business.id}:${appId}`}
        client={client}
        businessId={business.id}
        slug={business.slug}
        appId={appId}
      />
    </Suspense>
  );
}
