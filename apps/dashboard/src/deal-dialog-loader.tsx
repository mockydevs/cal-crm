// The opportunity dialog, fetched as the Opportunities page first draws rather than with
// it: the page shows the board or the list before anyone opens an opportunity, so the
// dialog (and the dialog parts only it uses) is not part of what the page loads first. It is
// mounted as soon as it arrives and stays mounted, as before, so opening, closing and the
// unsaved-changes guard behave the same. A failed download keeps the page usable.
import { CatchBoundary } from '@tanstack/react-router';
import { lazy, Suspense, type ComponentProps, type ReactElement } from 'react';
import type { DealDialog as Loaded } from './deal-dialog';

const Dialog = lazy(async () => ({ default: (await import('./deal-dialog')).DealDialog }));

function Nothing(): null {
  return null;
}

export function DealDialog(props: ComponentProps<typeof Loaded>): ReactElement {
  return (
    <CatchBoundary getResetKey={() => 'deal-dialog'} errorComponent={Nothing}>
      <Suspense fallback={null}>
        <Dialog {...props} />
      </Suspense>
    </CatchBoundary>
  );
}
