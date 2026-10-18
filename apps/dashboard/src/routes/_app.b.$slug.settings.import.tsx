import { createFileRoute } from '@tanstack/react-router';
import { ImportDataPage } from '../import-data';

export const Route = createFileRoute('/_app/b/$slug/settings/import')({
  component: ImportDataPage,
});
