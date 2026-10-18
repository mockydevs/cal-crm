// Media Storage: the business's library of files, as a page of its own.
import { useLingui } from '@lingui/react/macro';
import type { ReactElement } from 'react';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';
import { MediaLibrary } from './library';

export function MediaStoragePage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  return (
    <MediaLibrary
      // Another business is another library: nothing chosen or typed carries over.
      key={business.id}
      businessId={business.id}
      mode="manage"
      frame={({ actions, body }) => (
        <Page title={t`Media Storage`} actions={actions ?? undefined}>
          {body}
        </Page>
      )}
    />
  );
}
