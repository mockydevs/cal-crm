import { createFileRoute } from '@tanstack/react-router';
import { CustomValuesPage } from '../custom-values';

export const Route = createFileRoute('/_app/b/$slug/settings/custom-values')({
  component: CustomValuesPage,
});
