// The assistant's part of a conversation, as the thread holds it: a place for it, and
// nothing more. Everything it reads, shows and does is in its own chunk
// (inbox-assistant.tsx), fetched once the thread is on the page, so the Inbox opens no
// slower for it.
//
// If its code doesn't arrive, the thread and the composer stay as they are, and this says
// so in its place. React keeps a failed lazy component failed, so only a new page fetches
// it afresh (see note-editor-loader.tsx).
import { Trans } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { CatchBoundary } from '@tanstack/react-router';
import { lazy, Suspense, useState, type ComponentProps, type ReactElement } from 'react';
import type Assistant from './inbox-assistant';

/**
 * Fetches the assistant's code. The one place that does: the thread asks here too when a
 * changed draft is sent, and a test asks before it draws anything, so that it waits on the
 * page and never on the code arriving.
 */
export const loadAssistant = (): Promise<typeof import('./inbox-assistant')> =>
  import('./inbox-assistant');

const Lazy = lazy(loadAssistant);

/** What the boundary shows itself: nothing, since the loader shows the failure. */
function Nothing(): null {
  return null;
}

export function AssistantLoader(props: ComponentProps<typeof Assistant>): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div
        role="alert"
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
      >
        <p>
          <Trans>
            Your assistant’s suggestions couldn’t load. You can still write your own reply. Reload
            the page to try again.
          </Trans>
        </p>
        <Button
          variant="secondary"
          size="small"
          onClick={() => {
            window.location.reload();
          }}
        >
          <Trans>Reload page</Trans>
        </Button>
      </div>
    );
  }
  return (
    <CatchBoundary
      getResetKey={() => 'inbox-assistant'}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense fallback={null}>
        <Lazy {...props} />
      </Suspense>
    </CatchBoundary>
  );
}
