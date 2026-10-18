import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { templatesSearchOf } from '../templates-search';
import { withTemplatesWords } from '../templates-words';
import { useBusiness } from '../workspace';

// Marketing → Emails → Templates, where GoHighLevel has them. The page and its words are
// fetched together, apart from the route (lingui.config.ts): the page is shown once both
// have arrived. The page reads its address through the route's API, not through `Route`.
const route = getRouteApi('/_app/b/$slug/marketing/emails/templates');

export const Route = createFileRoute('/_app/b/$slug/marketing/emails/templates')({
  validateSearch: templatesSearchOf,
  component: TemplatesRoute,
});

const TemplatesPage = lazy(() => withTemplatesWords(import('../templates/page')));

function TemplatesRoute(): ReactElement {
  const business = useBusiness();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <Suspense fallback={null}>
      <TemplatesPage
        // Another business has other templates: start again when the address changes.
        key={business.id}
        search={search}
        onSearch={(change) => {
          void navigate({ search: change });
        }}
      />
    </Suspense>
  );
}
