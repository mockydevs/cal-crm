import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';

import { loadContactBulkWords } from '../contact-bulk-words';

// The Bulk Actions tab of Contacts, fetched with its words, which are a catalog of their own.
export const Route = createFileRoute('/_app/b/$slug/contacts/bulk-actions')({
  component: BulkActionsRoute,
});

const ContactBulkActionsPage = lazy(async () => {
  const [page] = await Promise.all([import('../contact-bulk-actions'), loadContactBulkWords()]);
  return { default: page.ContactBulkActionsPage };
});

function BulkActionsRoute(): ReactElement {
  return (
    <Suspense fallback={null}>
      <ContactBulkActionsPage />
    </Suspense>
  );
}
