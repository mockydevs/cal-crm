import { Trans } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { CatchBoundary } from '@tanstack/react-router';
import { lazy, Suspense, useState, type ComponentProps, type ReactElement } from 'react';
import type DealBoard from './deal-board';

const Board = lazy(() => import('./deal-board'));
function Nothing(): null {
  return null;
}

/** Keep a failed board download local and offer the lighter table view. */
export default function DealBoardLoader({
  onTable,
  ...props
}: ComponentProps<typeof DealBoard> & { readonly onTable: () => void }): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div role="alert" className="rounded-card border bg-card p-5">
        <p>
          <Trans>The board couldn't load. Your opportunities are still here.</Trans>
        </p>
        <Button variant="secondary" onClick={onTable}>
          <Trans>Switch to list</Trans>
        </Button>
      </div>
    );
  return (
    <CatchBoundary
      getResetKey={() => 'deal-board'}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense
        fallback={
          <p role="status">
            <Trans>Loading board…</Trans>
          </p>
        }
      >
        <Board {...props} />
      </Suspense>
    </CatchBoundary>
  );
}
