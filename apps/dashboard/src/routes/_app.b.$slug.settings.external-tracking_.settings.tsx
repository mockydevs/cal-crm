import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { withExternalTrackingWords } from '../external-tracking/words';

// Settings → External Tracking → Settings. The tab's words are a catalog of their own, fetched
// beside it (lingui.config.ts): the tab is shown once both have arrived.
export const Route = createFileRoute('/_app/b/$slug/settings/external-tracking_/settings')({
  component: ExternalTrackingSettings,
});

const Tab = lazy(() => withExternalTrackingWords(import('../external-tracking/settings-tab')));

function ExternalTrackingSettings(): ReactElement {
  return (
    <Suspense fallback={null}>
      <Tab />
    </Suspense>
  );
}
