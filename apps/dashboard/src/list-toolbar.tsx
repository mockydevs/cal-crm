// What the contacts list and the opportunities list share above their rows, in
// GoHighLevel's forms: the count chip, the search box, and the panel that slides in from
// the right for Filters and Manage fields.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Input } from '@repo/ui/components/input';
import { CatchBoundary } from '@tanstack/react-router';
import { Search, X } from 'lucide-react';
import { Suspense, useId, useState, type ReactElement, type ReactNode } from 'react';

/** How many records the list holds, beside its Filters and Sort, said again as it changes. */
export function CountChip({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <span
      role="status"
      className="inline-flex min-h-7 items-center rounded-full bg-accent px-3 text-xs font-medium whitespace-nowrap text-link"
    >
      {children}
    </span>
  );
}

/** The search box at the right of a list's toolbar: its label is its placeholder too. */
export function ListSearch({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const id = useId();
  return (
    <form
      role="search"
      className="relative min-w-0 flex-1 basis-48 sm:max-w-64"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        strokeWidth={1.8}
      />
      <Input
        id={id}
        type="search"
        autoComplete="off"
        maxLength={200}
        placeholder={label}
        value={value}
        className="pl-9"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </form>
  );
}

/**
 * A panel that slides in from the right over the list, as GoHighLevel's Filters and Manage
 * fields do. Base UI's Dialog keeps the keyboard inside it, closes it on Escape and gives
 * the keyboard back to the button that opened it. Its content is drawn only while it is
 * open, so a draft in it starts again from what the list shows each time.
 */
export function SidePanel({
  trigger,
  open,
  onOpenChange,
  title,
  children,
}: {
  /** The button that opens it. */
  readonly trigger: ReactElement;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useLingui();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger render={trigger} />
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup className="fixed inset-y-0 right-0 z-60 flex w-[min(440px,100%)] flex-col bg-card text-card-foreground shadow-xl outline-none">
          <div className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-3">
            <Dialog.Title className="text-base font-medium wrap-break-word">{title}</Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** What the boundary shows itself: nothing, since PanelContent shows the failure. */
function Nothing(): null {
  return null;
}

/**
 * What a panel or a popover holds when that is fetched as it first opens: it says so while
 * it loads, and keeps a failed download to itself, with the way to try again.
 */
export function PanelContent({ children }: { readonly children: ReactNode }): ReactElement {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
        <p>
          <Trans>This couldn't load. Reload the page to try again.</Trans>
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
  return (
    <CatchBoundary
      getResetKey={() => 'panel-content'}
      errorComponent={Nothing}
      onCatch={() => {
        setFailed(true);
      }}
    >
      <Suspense
        fallback={
          <p role="status" className="p-4 text-sm">
            <Trans>Loading…</Trans>
          </p>
        }
      >
        {children}
      </Suspense>
    </CatchBoundary>
  );
}

export { sidePanelBodyClassName, sidePanelFooterClassName } from './side-panel-classes';
