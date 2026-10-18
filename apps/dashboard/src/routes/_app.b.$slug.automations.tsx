import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { AutomationsPage } from '../automations';
import { automationsSearch } from '../automation-search';

export const Route = createFileRoute('/_app/b/$slug/automations')({
  validateSearch: automationsSearch,
  // An open workflow is the builder, which has the whole window.
  staticData: { fullWindow: (search) => typeof search['automation'] === 'string' },
  component: AutomationsRoute,
});

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/automations');

function AutomationsRoute(): ReactElement {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <AutomationsPage
      search={search}
      onSearch={(next, how) => {
        void navigate({ search: next, replace: how?.replace ?? false });
      }}
    />
  );
}
