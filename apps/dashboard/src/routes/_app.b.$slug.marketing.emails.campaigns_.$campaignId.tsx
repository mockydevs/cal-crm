import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { withCampaignsWords } from '../campaigns-words';

// One email campaign: its editor while it is a draft, its status and results after. The
// page's words are a catalog of their own, fetched beside it (lingui.config.ts).
export const Route = createFileRoute('/_app/b/$slug/marketing/emails/campaigns_/$campaignId')({
  component: CampaignRoute,
});

const CampaignPage = lazy(() => withCampaignsWords(import('../campaigns/campaign-page')));

function CampaignRoute(): ReactElement {
  return (
    <Suspense fallback={null}>
      <CampaignPage />
    </Suspense>
  );
}
