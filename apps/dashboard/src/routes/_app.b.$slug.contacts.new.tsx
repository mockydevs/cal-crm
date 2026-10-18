import { createFileRoute, redirect } from '@tanstack/react-router';

// The address the new-contact page had before adding a contact became a panel over the
// list. Links and bookmarks to it still work: they open the list with the panel.
export const Route = createFileRoute('/_app/b/$slug/contacts/new')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/b/$slug/contacts',
      params,
      search: { add: 'contact' },
      replace: true,
    });
  },
});
