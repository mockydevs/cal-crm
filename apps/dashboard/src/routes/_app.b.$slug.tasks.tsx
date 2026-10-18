import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { tasksSearchOf } from '../tasks-search';
import { TasksPage } from '../tasks';
import { useBusiness } from '../workspace';

export const Route = createFileRoute('/_app/b/$slug/tasks')({
  validateSearch: tasksSearchOf,
  component: TasksRoute,
});

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/tasks');

function TasksRoute(): ReactElement {
  const business = useBusiness();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <TasksPage
      key={business.id}
      search={search}
      onSearch={(change) => {
        void navigate({ search: change });
      }}
    />
  );
}
