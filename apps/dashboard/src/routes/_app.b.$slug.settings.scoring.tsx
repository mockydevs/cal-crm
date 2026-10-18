import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { withScoringWords } from '../scoring/words-loader';

// Settings → Manage Scoring. The page's words are a catalog of their own, fetched beside it
// (lingui.config.ts): the page is shown once both have arrived.
export const Route = createFileRoute('/_app/b/$slug/settings/scoring')({
  component: ManageScoring,
});

const ManageScoringPage = lazy(() => withScoringWords(import('../scoring/settings-page')));

function ManageScoring(): ReactElement {
  return (
    <Suspense fallback={null}>
      <ManageScoringPage />
    </Suspense>
  );
}
