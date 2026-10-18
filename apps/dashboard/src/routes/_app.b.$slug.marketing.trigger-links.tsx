import { createFileRoute } from '@tanstack/react-router';
import { TriggerLinksPage } from '../trigger-links';

// The Trigger Links tab of Marketing. Conversations lists the same page among its tabs, as
// GoHighLevel does: one page, two doors.
export const Route = createFileRoute('/_app/b/$slug/marketing/trigger-links')({
  component: TriggerLinksPage,
});
