import { createFileRoute, redirect } from '@tanstack/react-router';

// Trigger links were first a page of Conversations. The page is Marketing's now, as
// GoHighLevel has it; an old link or bookmark lands there, with whatever its address carried.
export const Route = createFileRoute('/_app/b/$slug/inbox_/trigger-links')({
  beforeLoad: ({ params, location }) => {
    throw redirect({
      to: '/b/$slug/marketing/trigger-links',
      params,
      search: location.search,
      hash: location.hash,
      replace: true,
    });
  },
});
