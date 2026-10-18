import { createFileRoute, redirect } from '@tanstack/react-router';

// "Ask AI" was a sidebar entry with nothing behind it. The assistant is now on every page;
// the old address opens it full screen, so a bookmark still leads somewhere.
export const Route = createFileRoute('/_app/b/$slug/ask-ai')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/b/$slug/assistant', params: { slug: params.slug }, replace: true });
  },
});
