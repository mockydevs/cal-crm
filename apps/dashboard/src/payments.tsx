// The Payments module (GoHighLevel's Payments): Invoices, Quotes, Receipts, Products and
// Settings as tabs of one route. What follows /payments/ in the address says which page
// shows (payments-rules.ts), and each page's code is fetched when it is first opened.
import { useLingui } from '@lingui/react/macro';
import { lazy, Suspense, type ReactElement } from 'react';
import { placeOf } from './payments-rules';
import type { PaymentsSearch } from './payments-search';
import { NotFound } from './shell/not-found';

const DocumentsPage = lazy(() => import('./payments-documents'));
const DocumentPage = lazy(() => import('./payments-document'));
const ReceiptsPage = lazy(() => import('./payments-receipts'));
const ReceiptPage = lazy(async () => ({
  default: (await import('./payments-receipts')).ReceiptPage,
}));
const ProductsPage = lazy(() => import('./payments-products'));
const SettingsPage = lazy(() => import('./payments-settings'));

function pageOf(splat: string, search: PaymentsSearch): ReactElement | undefined {
  const place = placeOf(splat);
  switch (place.at) {
    case 'documents':
      return <DocumentsPage key={place.kind} kind={place.kind} />;
    case 'document':
      return (
        <DocumentPage
          key={`${place.kind}:${place.id ?? 'new'}`}
          kind={place.kind}
          id={place.id}
          search={search}
        />
      );
    case 'receipts':
      return <ReceiptsPage />;
    case 'receipt':
      return <ReceiptPage key={place.id} id={place.id} />;
    case 'products':
      return <ProductsPage />;
    case 'settings':
      return <SettingsPage />;
    case 'nowhere':
      return undefined;
  }
}

export function PaymentsPage({
  splat,
  search,
}: {
  readonly splat: string;
  readonly search: PaymentsSearch;
}): ReactElement {
  const { t } = useLingui();
  const page = pageOf(splat, search);
  if (page === undefined) return <NotFound />;
  return (
    <Suspense
      fallback={
        <p role="status" className="text-sm text-muted-foreground">
          {t`Loading…`}
        </p>
      }
    >
      {page}
    </Suspense>
  );
}
