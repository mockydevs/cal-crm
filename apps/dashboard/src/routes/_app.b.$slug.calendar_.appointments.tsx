import { createFileRoute } from '@tanstack/react-router';
import { AppointmentsPage } from '../appointments';

// The Appointment list view tab of Calendars. `calendar_` keeps it out of the calendar
// view's own route: it is a page beside it, not inside it.
export const Route = createFileRoute('/_app/b/$slug/calendar_/appointments')({
  component: AppointmentsPage,
});
