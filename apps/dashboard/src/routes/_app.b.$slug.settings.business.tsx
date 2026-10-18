import { createFileRoute } from '@tanstack/react-router';
import { BusinessProfilePage } from '../business-profile';

export const Route = createFileRoute('/_app/b/$slug/settings/business')({
  component: BusinessProfilePage,
});
