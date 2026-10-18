import { createFileRoute } from '@tanstack/react-router';
import { CustomFieldsPage } from '../custom-fields';

export const Route = createFileRoute('/_app/b/$slug/settings/custom-fields')({
  component: CustomFieldsPage,
});
