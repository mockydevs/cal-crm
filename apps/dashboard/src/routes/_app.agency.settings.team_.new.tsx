import { createFileRoute } from '@tanstack/react-router';
import { api } from '../api';
import { UserFormPage } from '../user-form';

// Add user to the agency's own team.
export const Route = createFileRoute('/_app/agency/settings/team_/new')({
  component: AgencyAddUser,
});
function AgencyAddUser() {
  return <UserFormPage client={api} workspace="agency" place={{ kind: 'agency' }} />;
}
