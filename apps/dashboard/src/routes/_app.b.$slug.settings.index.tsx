import { createFileRoute, redirect } from '@tanstack/react-router';

// Settings opens on its first page.
export const Route = createFileRoute('/_app/b/$slug/settings/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/b/$slug/settings/business', params, replace: true });
  },
});
