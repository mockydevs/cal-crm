import { createFileRoute } from '@tanstack/react-router';
import { api } from '../api';
import { UsersPage } from '../users';

// The agency's own team, on the same page as a business's users.
export const Route = createFileRoute('/_app/agency/settings/team')({ component: AgencyUsers });
function AgencyUsers() {
  return <UsersPage client={api} workspace="agency" place={{ kind: 'agency' }} />;
}
