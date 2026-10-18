import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { campaignsSearchOf } from '../campaigns-search';
import { withCampaignsWords } from '../campaigns-words';
import { useBusiness } from '../workspace';

// Marketing → Emails → Campaigns, the first of Emails' pages, as GoHighLevel orders them.
// The page's words are a catalog of their own, fetched beside it (lingui.config.ts): the
// page is shown once both have arrived. It reads its address through the route's API.
const route = getRouteApi('/_app/b/$slug/marketing/emails/campaigns');

export const Route = createFileRoute('/_app/b/$slug/marketing/emails/campaigns')({
  validateSearch: campaignsSearchOf,
  component: CampaignsRoute,
});

const CampaignsPage = lazy(() => withCampaignsWords(import('../campaigns/list-page')));

function CampaignsRoute(): ReactElement {
  const business = useBusiness();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <Suspense fallback={null}>
      <CampaignsPage
        // Another business has other campaigns: start again when the address changes.
        key={business.id}
        search={search}
        onSearch={(change) => {
          void navigate({ search: change });
        }}
      />
    </Suspense>
  );
}
