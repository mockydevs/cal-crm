import { createFileRoute } from '@tanstack/react-router';
import { ManualActionsPage } from '../manual-actions';

// The Manual Actions tab of Conversations. `inbox_` keeps it out of the conversations
// page's own route: it is a page beside it, not inside it.
export const Route = createFileRoute('/_app/b/$slug/inbox_/manual-actions')({
  component: ManualActionsPage,
});
