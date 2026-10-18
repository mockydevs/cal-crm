import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { withLeadSourcesWords } from '../lead-sources-words';

// Settings → Lead Sources: the tracking link builder. The tab's words are a catalog of their own, fetched
// beside it (lingui.config.ts): the tab is shown once both have arrived.
export const Route = createFileRoute('/_app/b/$slug/settings/lead-sources_/tracking-links')({
  component: LeadSourcesLinksTab,
});

const LinksTab = lazy(() => withLeadSourcesWords(import('../lead-sources/links-tab')));

function LeadSourcesLinksTab(): ReactElement {
  return (
    <Suspense fallback={null}>
      <LinksTab />
    </Suspense>
  );
}
