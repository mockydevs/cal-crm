import { createFileRoute } from '@tanstack/react-router';
import { SnippetsPage } from '../snippets';

// The Snippets tab of Marketing. Conversations lists the same page among its tabs, as
// GoHighLevel does: one page, two doors.
export const Route = createFileRoute('/_app/b/$slug/marketing/snippets')({
  component: SnippetsPage,
});
