import { createFileRoute, redirect } from '@tanstack/react-router';

// Emails opens on Campaigns, the first of its pages, as GoHighLevel orders them.
export const Route = createFileRoute('/_app/b/$slug/marketing/emails/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/b/$slug/marketing/emails/campaigns', params, replace: true });
  },
});
