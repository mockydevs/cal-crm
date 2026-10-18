// What the three tabs of Settings → Lead Sources share: the page's heading, the looks of a
// card, of a small grey label above a value and of an icon button, and two small helpers
// for reading the API. Kept here, apart from the shared list helpers (settings-list.tsx),
// so a tab that shows no menu and no dialog downloads neither.
import { useLingui } from '@lingui/react/macro';
import { ApiError } from '@repo/sdk';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Page } from '../shell/page';

export const cardClassName =
  'flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4';
export const labelClassName = 'text-sm text-muted-foreground';
export const fieldLabelClassName = 'text-sm font-medium';

/** A square button that holds one icon: 32px beside the page, 44px under a finger. */
export const iconButtonClassName =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-body -outline-offset-2 hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50 lg:size-8';

/**
 * Whether a read is asked for again after it failed: twice for a fault of the server or
 * the connection, never for an answer that would be the same again, such as "you may not".
 */
export const retryFaults = (failures: number, error: unknown): boolean =>
  !(error instanceof ApiError && error.status < 500) && failures < 2;

/** What's typed, once typing pauses, so the API isn't asked for every key. */
export function useSettled(value: string, delay: number): string {
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

export function LeadSourcesFrame({
  actions,
  children,
}: {
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useLingui();
  return (
    <Page title={t`Lead Sources`} actions={actions}>
      {children}
    </Page>
  );
}
