import { createFileRoute, getRouteApi, Navigate } from '@tanstack/react-router';
import { lazy, Suspense, type ReactElement } from 'react';
import { paymentsSearchOf } from '../payments-search';
import { useBusiness } from '../workspace';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/payments_/$');

// The whole Payments module: what follows /payments/ says which of its pages shows
// (payments-rules.ts). The pages are fetched here, not by the route, so that the first load
// carries only this file's few lines.
const PaymentsPage = lazy(async () => ({ default: (await import('../payments')).PaymentsPage }));

export const Route = createFileRoute('/_app/b/$slug/payments_/$')({
  validateSearch: paymentsSearchOf,
  component: PaymentsRoute,
});

function PaymentsRoute(): ReactElement {
  const business = useBusiness();
  const { _splat } = route.useParams();
  const search = route.useSearch();
  // Payments opens on its first tab, Invoices, as GoHighLevel's does.
  if (_splat === undefined || _splat === '') {
    return (
      <Navigate
        to="/b/$slug/payments/$"
        params={{ slug: business.slug, _splat: 'invoices' }}
        replace
      />
    );
  }
  return (
    <Suspense fallback={null}>
      <PaymentsPage key={business.id} splat={_splat} search={search} />
    </Suspense>
  );
}
