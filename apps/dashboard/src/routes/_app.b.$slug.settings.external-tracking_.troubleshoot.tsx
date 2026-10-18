import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { withExternalTrackingWords } from '../external-tracking/words';

// Settings → External Tracking → Troubleshoot. The tab's words are a catalog of their own, fetched
// beside it (lingui.config.ts): the tab is shown once both have arrived.
export const Route = createFileRoute('/_app/b/$slug/settings/external-tracking_/troubleshoot')({
  component: ExternalTrackingTroubleshoot,
});

const Tab = lazy(() => withExternalTrackingWords(import('../external-tracking/troubleshoot-tab')));

function ExternalTrackingTroubleshoot(): ReactElement {
  return (
    <Suspense fallback={null}>
      <Tab />
    </Suspense>
  );
}
