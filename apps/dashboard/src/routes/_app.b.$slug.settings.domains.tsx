import { createFileRoute } from '@tanstack/react-router';
import { DomainsPage } from '../domains';

export const Route = createFileRoute('/_app/b/$slug/settings/domains')({
  component: DomainsPage,
});
