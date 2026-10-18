import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { NotFound } from '../shell/not-found';
import { loadSiteEditorWords } from '../sites-words';
import { useBusiness } from '../workspace';

// The page editor of a funnel step or a website page:
// /sites/funnels/{site}/pages/{page}/edit, and the same under /websites. It has the whole
// window, as the workflow builder has. The editor's code, the canvas library it stands on
// and its own words are fetched only when this address opens: nothing of them is in the
// first load, nor in the funnel's page that links here.
const SiteEditorPage = lazy(async () => {
  const [editor] = await Promise.all([import('../site-editor/editor'), loadSiteEditorWords()]);
  return { default: editor.default };
});

export const Route = createFileRoute('/_app/b/$slug/sites_/$kind/$siteId/pages/$pageId/edit')({
  staticData: { fullWindow: () => true },
  component: SiteEditorRoute,
});

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/sites_/$kind/$siteId/pages/$pageId/edit');

const KINDS = { funnels: 'funnel', websites: 'website' } as const;

function SiteEditorRoute(): ReactElement {
  const business = useBusiness();
  const { kind, siteId, pageId } = route.useParams();
  const known = kind === 'funnels' || kind === 'websites';
  if (!known || !/^site_[0-9a-z]{26}$/.test(siteId) || !/^spg_[0-9a-z]{26}$/.test(pageId))
    return <NotFound />;
  return (
    <Suspense fallback={null}>
      <SiteEditorPage
        key={`${business.id}:${pageId}`}
        kind={KINDS[kind]}
        siteId={siteId}
        pageId={pageId}
      />
    </Suspense>
  );
}
