import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { PipelinesPage } from '../pipelines';
import { pipelinesSearch } from '../pipelines-search';

// The Pipelines tab of Opportunities. `deals_` keeps it out of the opportunities page's own
// route: it is a page beside it, not inside it.
export const Route = createFileRoute('/_app/b/$slug/deals_/pipelines')({
  validateSearch: pipelinesSearch,
  component: OpportunityPipelines,
});

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/deals_/pipelines');

function OpportunityPipelines(): ReactElement {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <PipelinesPage
      opened={search}
      navigate={(next, options) => {
        void navigate({ search: next, ...options });
      }}
    />
  );
}
