import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { CalendarViewPage } from '../calendar-view';

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/calendar');

// The Calendar view, the first page of the Calendars module. `?appointment=` names the
// appointment whose details show, so a notification can open one.
export const Route = createFileRoute('/_app/b/$slug/calendar')({
  validateSearch: (search: Record<string, unknown>): { appointment?: string } =>
    typeof search['appointment'] === 'string' && search['appointment'].startsWith('appt_')
      ? { appointment: search['appointment'] }
      : {},
  component: CalendarRoute,
});

function CalendarRoute(): ReactElement {
  const { appointment } = route.useSearch();
  const navigate = route.useNavigate();
  return (
    <CalendarViewPage
      appointment={appointment}
      onAppointment={(id) => {
        void navigate({ search: id === undefined ? {} : { appointment: id } });
      }}
    />
  );
}
