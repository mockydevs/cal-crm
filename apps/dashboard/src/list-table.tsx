// The frame of a list's table and what a failed read says, for every page that lists rows.
// Kept apart from the list's menus and dialogs (settings-list.tsx), so a page that only
// draws a table doesn't bring those with it. With the pause a search box waits for, a
// square icon button's classes, and where the keyboard goes when a dialog closes, which a
// form can take from here without the lists' menus.
import { Trans } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { useEffect, useState, type ReactElement, type ReactNode, type RefObject } from 'react';

/** A square button that holds one icon: 32px beside the page, 44px under a finger. */
export const iconButtonClassName =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-body -outline-offset-2 hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-secondary lg:size-8';

/** Where the keyboard goes when a dialog closes: what opened it, if that is still there. */
export function returnTo(ref: RefObject<HTMLElement | null>): () => HTMLElement | boolean {
  return () => {
    const opener = ref.current;
    return opener?.isConnected === true ? opener : true;
  };
}

/**
 * The frame of a table. It scrolls sideways only when the table is wider than its card, and
 * a table that can be is one with something to press in every row, so the keyboard reaches
 * what scrolls (WCAG 2.1.1). A table with nothing to press folds its columns instead.
 */
export const tableRegionClassName =
  'relative max-w-full overflow-x-auto rounded-lg border border-border';
export const tableClassName = 'w-full border-separate border-spacing-0 text-left text-sm text-body';
export const headerCellClassName =
  'h-10 bg-muted px-3 py-0 text-left align-middle text-xs font-medium whitespace-nowrap text-body';
export const cellClassName = 'h-12 border-t border-border px-3 py-1.5 align-middle';
/** The card that holds a list: its toolbar, its table and its footer. */
export const listCardClassName =
  'flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4';

/** What a request that failed says: the server's own words when it gave any. */
export function ListProblem({
  children,
  onRetry,
}: {
  readonly children: ReactNode;
  readonly onRetry: () => void;
}): ReactElement {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-destructive">{children}</span>
      <Button variant="secondary" size="small" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  );
}

/** What's typed, once typing pauses, so the API isn't asked for every key. */
export function useSettled(value: string, delay = 250): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);
  return settled;
}
