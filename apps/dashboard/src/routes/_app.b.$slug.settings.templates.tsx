import { createFileRoute, redirect } from '@tanstack/react-router';

// Message templates were written under Settings before Marketing had a page. They have one
// place now, Marketing → Emails → Templates; an old link or bookmark lands there, with
// whatever its address carried.
export const Route = createFileRoute('/_app/b/$slug/settings/templates')({
  beforeLoad: ({ params, location }) => {
    throw redirect({
      to: '/b/$slug/marketing/emails/templates',
      params,
      search: location.search,
      hash: location.hash,
      replace: true,
    });
  },
});
