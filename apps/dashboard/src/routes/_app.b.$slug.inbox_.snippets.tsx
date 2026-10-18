import { createFileRoute, redirect } from '@tanstack/react-router';

// Snippets were first a page of Conversations. The page is Marketing's now, as GoHighLevel
// has it; an old link or bookmark lands there, with whatever its address carried.
export const Route = createFileRoute('/_app/b/$slug/inbox_/snippets')({
  beforeLoad: ({ params, location }) => {
    throw redirect({
      to: '/b/$slug/marketing/snippets',
      params,
      search: location.search,
      hash: location.hash,
      replace: true,
    });
  },
});
