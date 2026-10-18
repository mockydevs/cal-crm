import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';

import { loadAiSettingsWords } from '../ai-settings-words';

// The agency's Settings → AI, fetched with its words, which are a catalog of their own.
export const Route = createFileRoute('/_app/agency/settings/ai-models')({
  component: AgencyAiSettingsRoute,
});

const AgencyAiSettingsPage = lazy(async () => {
  const [page] = await Promise.all([import('../ai-settings-agency'), loadAiSettingsWords()]);
  return { default: page.AgencyAiSettingsPage };
});

function AgencyAiSettingsRoute(): ReactElement {
  return (
    <Suspense fallback={null}>
      <AgencyAiSettingsPage />
    </Suspense>
  );
}
