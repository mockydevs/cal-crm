import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { withLeadSourcesWords } from '../lead-sources-words';

// Settings → Lead Sources: the business's own rules. The tab's words are a catalog of their own, fetched
// beside it (lingui.config.ts): the tab is shown once both have arrived.
export const Route = createFileRoute('/_app/b/$slug/settings/lead-sources')({
  component: LeadSourcesRulesTab,
});

const RulesTab = lazy(() => withLeadSourcesWords(import('../lead-sources/rules-tab')));

function LeadSourcesRulesTab(): ReactElement {
  return (
    <Suspense fallback={null}>
      <RulesTab />
    </Suspense>
  );
}
