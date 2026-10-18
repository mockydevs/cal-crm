import { createFileRoute } from '@tanstack/react-router';
import { DealBulkActionsPage } from '../deal-bulk-actions';

// The Bulk Actions tab of Opportunities. `deals_` keeps it out of the opportunities page's
// own route: it is a page beside it, not inside it.
export const Route = createFileRoute('/_app/b/$slug/deals_/bulk-actions')({
  component: DealBulkActionsPage,
});
