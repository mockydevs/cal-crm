import { createFileRoute, useParams } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { AssistantPage } from '../assistant/page';

// The assistant, full screen: the conversation the floating panel shows, with the person's
// past conversations beside it. One page for both of its addresses, so opening another
// conversation keeps the page as it is: the conversation's own address
// (assistant.$threadId) only names which one is open.
export const Route = createFileRoute('/_app/b/$slug/assistant')({ component: AssistantRoute });

function AssistantRoute(): ReactElement {
  const threadId = useParams({
    strict: false,
    select: (params): string | undefined => params.threadId,
  });
  return <AssistantPage threadId={threadId ?? null} />;
}
