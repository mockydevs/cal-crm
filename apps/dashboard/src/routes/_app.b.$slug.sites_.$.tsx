import { createFileRoute, getRouteApi, Navigate } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { loadSitesWords } from '../sites-words';
import { useBusiness } from '../workspace';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/sites_/$');

// The whole Sites module: what follows /sites/ says which of its pages shows (sites-rules.ts).
// The pages are fetched here, not by the route, so that the first load carries only this
// file's few lines and not the list of everything the pages need.
// Their words are a catalog of their own, fetched beside them (lingui.config.ts).
const SitesPage = lazy(async () => {
  const [sites] = await Promise.all([import('../sites'), loadSitesWords()]);
  return { default: sites.SitesPage };
});

export const Route = createFileRoute('/_app/b/$slug/sites_/$')({ component: SitesRoute });

function SitesRoute(): ReactElement {
  const business = useBusiness();
  const { _splat } = route.useParams();
  // Sites opens on its first tab, Funnels, as GoHighLevel's does.
  if (_splat === undefined || _splat === '') {
    return (
      <Navigate to="/b/$slug/sites/$" params={{ slug: business.slug, _splat: 'funnels' }} replace />
    );
  }
  return (
    <Suspense fallback={null}>
      <SitesPage key={business.id} splat={_splat} />
    </Suspense>
  );
}
