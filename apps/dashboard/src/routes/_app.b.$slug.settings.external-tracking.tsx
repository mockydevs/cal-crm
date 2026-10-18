import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { withExternalTrackingWords } from '../external-tracking/words';

// Settings → External Tracking → Installation. The tab's words are a catalog of their own, fetched
// beside it (lingui.config.ts): the tab is shown once both have arrived.
export const Route = createFileRoute('/_app/b/$slug/settings/external-tracking')({
  component: ExternalTrackingInstallation,
});

const Tab = lazy(() => withExternalTrackingWords(import('../external-tracking/installation-tab')));

function ExternalTrackingInstallation(): ReactElement {
  return (
    <Suspense fallback={null}>
      <Tab />
    </Suspense>
  );
}
