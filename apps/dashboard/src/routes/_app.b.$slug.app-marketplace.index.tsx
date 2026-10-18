import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useMemo, type ReactElement } from 'react';
import { apiIn } from '../api';
import { marketplaceSearchOf, type MarketplaceSearch } from '../marketplace-search';
import { loadMarketplaceWords } from '../marketplace-words';
import { useBusiness } from '../workspace';

// The App Marketplace: All apps or Installed, with the search and category in the
// address, so going back from an app's page finds the list as it was.
export const Route = createFileRoute('/_app/b/$slug/app-marketplace/')({
  validateSearch: marketplaceSearchOf,
  component: MarketplaceRoute,
});

const MarketplacePage = lazy(async () => {
  const [page] = await Promise.all([import('../marketplace'), loadMarketplaceWords()]);
  return { default: page.MarketplacePage };
});

function MarketplaceRoute(): ReactElement {
  const business = useBusiness();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const client = useMemo(() => apiIn(business.id), [business.id]);
  const onSearch = useCallback(
    (next: MarketplaceSearch) => {
      void navigate({ search: next, replace: true });
    },
    [navigate],
  );
  return (
    <Suspense fallback={null}>
      <MarketplacePage
        key={business.id}
        client={client}
        businessId={business.id}
        slug={business.slug}
        search={search}
        onSearch={onSearch}
      />
    </Suspense>
  );
}
