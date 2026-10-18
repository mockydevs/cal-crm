import { createFileRoute, redirect } from '@tanstack/react-router';

// The address fields and tags shared before each had a page of its own. Links and bookmarks
// to it still work: they open Custom Fields; Tags is the entry under it in the Settings
// sidebar.
export const Route = createFileRoute('/_app/b/$slug/settings/fields-and-tags')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/b/$slug/settings/custom-fields', params, replace: true });
  },
});
