import { createFileRoute } from '@tanstack/react-router';
import { AttributionReportPage } from '../reporting/attribution-report';
import { attributionSearchOf } from '../reporting-search';

// Reporting → Attribution report. The range, first or latest touch and the view are in the
// address, so a reload or a shared link opens the same numbers.
export const Route = createFileRoute('/_app/b/$slug/reports/attribution')({
  validateSearch: attributionSearchOf,
  component: AttributionReportPage,
});
