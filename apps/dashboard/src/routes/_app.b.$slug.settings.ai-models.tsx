import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';

import { loadAiSettingsWords } from '../ai-settings-words';

// Settings → AI, fetched with its words, which are a catalog of their own.
export const Route = createFileRoute('/_app/b/$slug/settings/ai-models')({
  component: AiSettingsRoute,
});

const AiSettingsPage = lazy(async () => {
  const [page] = await Promise.all([import('../ai-settings'), loadAiSettingsWords()]);
  return { default: page.AiSettingsPage };
});

function AiSettingsRoute(): ReactElement {
  return (
    <Suspense fallback={null}>
      <AiSettingsPage />
    </Suspense>
  );
}
