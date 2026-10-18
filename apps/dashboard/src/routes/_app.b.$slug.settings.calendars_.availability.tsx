import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { apiIn } from '../api';
import { CalendarsPage } from '../calendars';
import { meQuery, useBusiness } from '../workspace';

// Settings → Calendars, the Availability tab of the top bar. `calendars_` keeps it beside the
// list's own route, not inside it.
export const Route = createFileRoute('/_app/b/$slug/settings/calendars_/availability')({
  component: CalendarsAvailability,
});
function CalendarsAvailability() {
  const business = useBusiness();
  const agencySlug = useSuspenseQuery(meQuery).data.agency.slug;
  return (
    <CalendarsPage
      key={business.id}
      tab="availability"
      client={apiIn(business.id)}
      business={business}
      agencySlug={agencySlug}
    />
  );
}
