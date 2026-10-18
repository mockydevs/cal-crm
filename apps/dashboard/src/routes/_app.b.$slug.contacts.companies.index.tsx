import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { CompaniesPage } from '../companies-list';
import { companiesSearchOf } from '../company-search';
import { useBusiness } from '../workspace';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/contacts/companies/');

export const Route = createFileRoute('/_app/b/$slug/contacts/companies/')({
  validateSearch: companiesSearchOf,
  component: CompaniesRoute,
});

function CompaniesRoute(): ReactElement {
  const business = useBusiness();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <CompaniesPage
      key={business.id}
      search={search}
      onSearch={(change) => {
        void navigate({ search: change });
      }}
    />
  );
}
