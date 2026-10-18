import { createFileRoute } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';

import { loadContactDuplicateWords } from '../contact-duplicates/words';

// Contacts → ⋯ → Manage Duplicates, fetched with its words, which are a catalog of their own.
export const Route = createFileRoute('/_app/b/$slug/contacts/duplicates')({
  component: ManageDuplicatesRoute,
});

const ManageDuplicatesPage = lazy(async () => {
  const [page] = await Promise.all([
    import('../contact-duplicates/manage-page'),
    loadContactDuplicateWords(),
  ]);
  return { default: page.ManageDuplicatesPage };
});

function ManageDuplicatesRoute(): ReactElement {
  return (
    <Suspense fallback={null}>
      <ManageDuplicatesPage />
    </Suspense>
  );
}
