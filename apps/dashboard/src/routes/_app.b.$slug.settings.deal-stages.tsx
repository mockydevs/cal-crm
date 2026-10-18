import { createFileRoute, redirect } from '@tanstack/react-router';
import { pipelinesSearch } from '../pipelines-search';

// Pipelines were once listed in Settings too. They have one place now, the Pipelines tab of
// Opportunities; an old link or bookmark lands there, with whatever it had open.
export const Route = createFileRoute('/_app/b/$slug/settings/deal-stages')({
  validateSearch: pipelinesSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: '/b/$slug/deals/pipelines', params, search, replace: true });
  },
});
