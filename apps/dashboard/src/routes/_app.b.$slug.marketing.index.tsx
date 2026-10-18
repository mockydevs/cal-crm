import { createFileRoute, redirect } from '@tanstack/react-router';

// Marketing opens on its first tab, Emails, which opens on its campaigns.
export const Route = createFileRoute('/_app/b/$slug/marketing/')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/b/$slug/marketing/emails/campaigns', params, replace: true });
  },
});
