import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { apiIn } from '../api';
import { CalendarsPage } from '../calendars';
import { meQuery, useBusiness } from '../workspace';

// Settings → Calendars: the one place calendars are set up.
export const Route = createFileRoute('/_app/b/$slug/settings/calendars')({
  component: BusinessCalendars,
});
function BusinessCalendars() {
  const business = useBusiness();
  const agencySlug = useSuspenseQuery(meQuery).data.agency.slug;
  return (
    <CalendarsPage
      key={business.id}
      client={apiIn(business.id)}
      business={business}
      agencySlug={agencySlug}
    />
  );
}
