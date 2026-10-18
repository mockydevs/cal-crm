import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { api } from '../api';
import { ApiKeysPage } from '../api-keys-page';
import { meQuery } from '../workspace';

export const Route = createFileRoute('/_app/agency/settings/apps')({ component: AgencyApiKeys });
function AgencyApiKeys() {
  const { agency } = useSuspenseQuery(meQuery).data;
  return <ApiKeysPage client={api} workspace={{ scope: 'agency', id: agency.slug }} />;
}
