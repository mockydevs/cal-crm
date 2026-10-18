import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { Page } from '../shell/page';
import { TagsPanel } from '../tags';
import { useBusiness } from '../workspace';

// Tags had a tab beside the fields until Custom Fields became a page of its own.
export const Route = createFileRoute('/_app/b/$slug/settings/tags')({
  component: TagsPage,
});

function TagsPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  return (
    <Page title={t`Tags`}>
      <TagsPanel key={business.id} />
    </Page>
  );
}
