import { createFileRoute, redirect } from '@tanstack/react-router';

// "Launchpad" was a sidebar entry with nothing behind it. What is missing on a page is now
// the assistant's to say; the old address opens it full screen, so a bookmark still leads
// somewhere.
export const Route = createFileRoute('/_app/b/$slug/launchpad')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/b/$slug/assistant', params: { slug: params.slug }, replace: true });
  },
});
