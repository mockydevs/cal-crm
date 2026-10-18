import { createFileRoute } from '@tanstack/react-router';
import { apiIn } from '../api';
import { ApiKeysPage } from '../api-keys-page';
import { useBusiness } from '../workspace';

export const Route = createFileRoute('/_app/b/$slug/settings/apps')({ component: BusinessApiKeys });
function BusinessApiKeys() {
  const business = useBusiness();
  return (
    <ApiKeysPage client={apiIn(business.id)} workspace={{ scope: 'business', id: business.id }} />
  );
}
