import { createFileRoute } from '@tanstack/react-router';
import { apiIn } from '../api';
import { UserFormPage } from '../user-form';
import { useBusiness } from '../workspace';

// Add user. `team_` keeps it out of the list's own route: it is a page beside it, not
// inside it.
export const Route = createFileRoute('/_app/b/$slug/settings/team_/new')({
  component: BusinessAddUser,
});
function BusinessAddUser() {
  const business = useBusiness();
  return (
    <UserFormPage
      key={business.id}
      client={apiIn(business.id)}
      workspace={business.id}
      place={{ kind: 'business', slug: business.slug }}
    />
  );
}
