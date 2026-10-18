import { BOOKABLE_CALENDAR_KINDS, type CalendarKind } from '@repo/contracts';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { apiIn } from '../api';
import { CalendarEditorPage } from '../calendar-settings-editor';
import { meQuery, useBusiness } from '../workspace';

// Only a type that takes bookings starts a new calendar, as in "Choose calendar type".
const isKind = (value: unknown): value is CalendarKind =>
  BOOKABLE_CALENDAR_KINDS.some((kind) => kind === value);

// The full editor for a new calendar of the type chosen. `calendars_` keeps it out of the
// list's own route: it is a page beside it, not inside it.
export const Route = createFileRoute('/_app/b/$slug/settings/calendars_/new')({
  validateSearch: (search: Record<string, unknown>): { type: CalendarKind } => ({
    type: isKind(search['type']) ? search['type'] : 'personal',
  }),
  component: NewCalendar,
});

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/settings/calendars_/new');

function NewCalendar() {
  const business = useBusiness();
  const agencySlug = useSuspenseQuery(meQuery).data.agency.slug;
  const { type } = route.useSearch();
  return (
    <CalendarEditorPage
      key={`${business.id}:new:${type}`}
      client={apiIn(business.id)}
      business={business}
      agencySlug={agencySlug}
      kind={type}
    />
  );
}
