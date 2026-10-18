import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { activateLocale, i18n } from './i18n';
import { PageUnavailable } from './page-unavailable';
import { routeTree } from './routeTree.gen';
import './styles.css';

const queryClient = new QueryClient();
const router = createRouter({
  routeTree,
  context: { queryClient },
  // A page whose code didn't arrive, or that failed while drawing, says so and offers a
  // reload, in the product's own words.
  defaultErrorComponent: PageUnavailable,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

await activateLocale('en');

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html has no #root element');
}

createRoot(container).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
