import { createFileRoute } from '@tanstack/react-router';
import { ReportPage } from '../reporting/report-page';
import { reportSearchOf } from '../reporting-search';

// One saved report: its pages of widgets, and for someone who may manage reports the
// builder (?edit). ?page says which of its pages shows.
export const Route = createFileRoute('/_app/b/$slug/reports/$reportId')({
  validateSearch: reportSearchOf,
  component: ReportPage,
});
