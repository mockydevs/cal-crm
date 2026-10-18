import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { apiIn } from '../api';
import { UserFormPage } from '../user-form';
import { useBusiness } from '../workspace';

// Edit user, by membership id. `team_` keeps it out of the list's own route.
export const Route = createFileRoute('/_app/b/$slug/settings/team_/$userId')({
  component: BusinessEditUser,
});

// The page reads its address through the route's API, not through `Route` itself: a page
// that names `Route` makes this file a chunk of its own in what everyone downloads first.
const route = getRouteApi('/_app/b/$slug/settings/team_/$userId');

function BusinessEditUser() {
  const business = useBusiness();
  const { userId } = route.useParams();
  return (
    <UserFormPage
      key={`${business.id}:${userId}`}
      client={apiIn(business.id)}
      workspace={business.id}
      place={{ kind: 'business', slug: business.slug }}
      userId={userId}
    />
  );
}
