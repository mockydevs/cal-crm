import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, type ReactElement } from 'react';
import { withIntegrationsWords } from '../integrations/words-loader';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/settings/integrations');

// Settings → Integrations. The provider's sign-in comes back here with `?integration=` and
// `?outcome=`, which the page says once and then clears. The page's words are a catalog of
// their own, fetched beside it (lingui.config.ts): the page is shown once both have arrived.
export const Route = createFileRoute('/_app/b/$slug/settings/integrations')({
  validateSearch: (
    search: Record<string, unknown>,
  ): { integration?: string; outcome?: string } => ({
    ...(typeof search['integration'] === 'string' ? { integration: search['integration'] } : {}),
    ...(typeof search['outcome'] === 'string' ? { outcome: search['outcome'] } : {}),
  }),
  component: Integrations,
});

const IntegrationsPage = lazy(() => withIntegrationsWords(import('../integrations/settings-page')));

function Integrations(): ReactElement {
  const { integration, outcome } = route.useSearch();
  const navigate = route.useNavigate();
  const onArrived = useCallback(() => {
    void navigate({ search: {}, replace: true });
  }, [navigate]);
  return (
    <Suspense fallback={null}>
      <IntegrationsPage integration={integration} outcome={outcome} onArrived={onArrived} />
    </Suspense>
  );
}
