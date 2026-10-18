// Brings the Dashboard's widgets after the page itself (their code is a chunk of its own),
// and keeps a failed download to its own corner: the tasks under it stay usable.
import { Trans } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { CatchBoundary } from '@tanstack/react-router';
import { lazy, Suspense, useState, type ReactElement } from 'react';
import type { DashboardWidgetsProps } from './dashboard-widgets';

const Widgets = lazy(() => import('./dashboard-widgets'));
function Nothing(): null {
  return null;
}

export function DashboardWidgetsLoader(props: DashboardWidgetsProps): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div role="alert" className="flex flex-col items-start gap-2 rounded-card border bg-card p-5">
        <p>
          <Trans>The dashboard's numbers couldn't load. Reload the page to try again.</Trans>
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            window.location.reload();
          }}
        >
          <Trans>Reload page</Trans>
        </Button>
      </div>
    );
  return (
    <CatchBoundary
      getResetKey={() => 'dashboard-widgets'}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense
        fallback={
          <p role="status">
            <Trans>Loading dashboard…</Trans>
          </p>
        }
      >
        <Widgets {...props} />
      </Suspense>
    </CatchBoundary>
  );
}
