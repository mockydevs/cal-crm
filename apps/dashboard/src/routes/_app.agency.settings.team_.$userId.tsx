import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { api } from '../api';
import { UserFormPage } from '../user-form';

// Edit someone of the agency's own team, by membership id.
export const Route = createFileRoute('/_app/agency/settings/team_/$userId')({
  component: AgencyEditUser,
});

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/agency/settings/team_/$userId');

function AgencyEditUser() {
  const { userId } = route.useParams();
  return (
    <UserFormPage
      key={userId}
      client={api}
      workspace="agency"
      place={{ kind: 'agency' }}
      userId={userId}
    />
  );
}
