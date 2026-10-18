import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { formsSearch } from '../forms-search';
import { loadFormsWords } from '../forms-words';

// ?form= opens that form: the assistant links to a form it made this way, and a reload or
// Back keeps or closes it.
export const Route = createFileRoute('/_app/b/$slug/settings/forms')({
  validateSearch: formsSearch,
  component: FormsRoute,
});

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/settings/forms');

// The page's words are a catalog of their own, fetched beside it (lingui.config.ts): the
// page is shown once both have arrived.
const FormsPage = lazy(async () => {
  const [forms] = await Promise.all([import('../forms'), loadFormsWords()]);
  return { default: forms.FormsPage };
});

function FormsRoute(): ReactElement {
  const { form } = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <Suspense fallback={null}>
      <FormsPage
        form={form}
        onForm={(next) => {
          void navigate({ search: next === undefined ? {} : { form: next } });
        }}
      />
    </Suspense>
  );
}
