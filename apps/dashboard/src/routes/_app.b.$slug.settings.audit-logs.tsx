import { createFileRoute } from '@tanstack/react-router';
import { AuditLogsPage } from '../audit-logs';

export const Route = createFileRoute('/_app/b/$slug/settings/audit-logs')({
  component: AuditLogsPage,
});
