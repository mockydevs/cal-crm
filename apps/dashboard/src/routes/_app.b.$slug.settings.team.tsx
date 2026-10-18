import { createFileRoute } from '@tanstack/react-router';
import { apiIn } from '../api';
import { UsersPage } from '../users';
import { useBusiness } from '../workspace';

// Settings → Users. The address keeps the old page's "team".
export const Route = createFileRoute('/_app/b/$slug/settings/team')({ component: BusinessUsers });
function BusinessUsers() {
  const business = useBusiness();
  return (
    <UsersPage
      key={business.id}
      client={apiIn(business.id)}
      workspace={business.id}
      place={{ kind: 'business', slug: business.slug }}
    />
  );
}
