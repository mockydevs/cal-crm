import { createFileRoute } from '@tanstack/react-router';
import { ReportsListPage } from '../reporting/reports-list';

// Reporting opens on its first tab, Custom reports: the "Reports overview" list. The module
// keeps the address it had, /reports.
export const Route = createFileRoute('/_app/b/$slug/reports/')({
  component: ReportsListPage,
});
