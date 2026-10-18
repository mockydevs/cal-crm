import { createFileRoute } from '@tanstack/react-router';
import { apiIn } from '../api';
import { CalendarConnectionsPage } from '../calendar-connections';
import { outcomeOf } from '../calendar-connections-rules';
import { useBusiness } from '../workspace';

// Settings → Calendars, the Connections tab of the top bar. `calendars_` keeps it beside
// the list's own route, not inside it. Google sends the browser back here with
// ?google=<outcome> after its consent page.
export const Route = createFileRoute('/_app/b/$slug/settings/calendars_/connections')({
  validateSearch: (search: Record<string, unknown>): { google?: string } =>
    typeof search['google'] === 'string' ? { google: search['google'] } : {},
  component: CalendarsConnections,
});
function CalendarsConnections() {
  const business = useBusiness();
  const { google } = Route.useSearch();
  return (
    <CalendarConnectionsPage
      key={business.id}
      client={apiIn(business.id)}
      business={business}
      outcome={outcomeOf(google)}
    />
  );
}
