import { createFileRoute } from '@tanstack/react-router';
import { AutomationOverview } from '../automation-overview';

// The Overview tab of Automation. `automations_` keeps it out of the workflows page's own
// route: it is a page beside it, not inside it.
export const Route = createFileRoute('/_app/b/$slug/automations_/overview')({
  component: AutomationOverview,
});
