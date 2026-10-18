import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { InboxPage } from '../inbox';
import { inboxSearch } from '../inbox-search';

// ?conversation= opens a conversation; the rest of the search is the list's filters.
export const Route = createFileRoute('/_app/b/$slug/inbox')({
  validateSearch: inboxSearch,
  component: InboxRoute,
});

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/inbox');

function InboxRoute(): ReactElement {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <InboxPage
      search={search}
      onSearch={(next, how) => {
        void navigate({ search: next, replace: how?.replace === true });
      }}
    />
  );
}
