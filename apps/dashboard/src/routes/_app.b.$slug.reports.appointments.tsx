import { createFileRoute } from '@tanstack/react-router';
import { AppointmentReportPage } from '../reporting/appointment-report';
import { appointmentSearchOf } from '../reporting-search';

// Reporting → Appointment report. The range, the date it goes by and the calendar are in
// the address, so a reload or a shared link opens the same numbers.
export const Route = createFileRoute('/_app/b/$slug/reports/appointments')({
  validateSearch: appointmentSearchOf,
  component: AppointmentReportPage,
});
