import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { apiIn } from '../api';
import { CalendarEditorPage } from '../calendar-settings-editor';
import { meQuery, useBusiness } from '../workspace';

// The full editor of one calendar. `calendars_` keeps it out of the list's own route.
export const Route = createFileRoute('/_app/b/$slug/settings/calendars_/$calendarId')({
  component: EditCalendar,
});

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/settings/calendars_/$calendarId');

function EditCalendar() {
  const business = useBusiness();
  const agencySlug = useSuspenseQuery(meQuery).data.agency.slug;
  const { calendarId } = route.useParams();
  return (
    <CalendarEditorPage
      key={`${business.id}:${calendarId}`}
      client={apiIn(business.id)}
      business={business}
      agencySlug={agencySlug}
      calendarId={calendarId}
    />
  );
}
