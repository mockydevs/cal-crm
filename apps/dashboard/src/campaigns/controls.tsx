// The small controls the campaign screens are built from, kept light on purpose: a list of
// choices that is the browser's own (the kit's popup list is 9 KB a page would download
// for a handful of options), and the small centred dialogs that ask for a name or a yes.
// The shared list helpers (settings-list.tsx) bring the kit's list and the row menu with
// them, which most of these screens never show; a route's own code has a budget
// (scripts/check-budget.mjs), so these are drawn here on the kit's dialog alone.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { X } from 'lucide-react';
import type { ReactElement, ReactNode, RefObject } from 'react';

/** A square button that holds one icon: 32px beside the page, 44px under a finger. */
export const iconButtonClassName =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-body -outline-offset-2 hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-secondary lg:size-8';

// A list of choices as the browser draws it, shared with the Emails library.
export { Select } from '../email-library/select';

/** Where the keyboard goes when a dialog closes: what opened it, if that is still there. */
function returnTo(ref: RefObject<HTMLElement | null>): () => HTMLElement | boolean {
  return () => {
    const opener = ref.current;
    return opener?.isConnected === true ? opener : true;
  };
}

const smallDialogClassName =
  'fixed top-1/2 left-1/2 z-[65] flex max-h-[calc(100dvh-32px)] w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-card bg-card p-5 text-card-foreground shadow-xl outline-none';

/** A small centred dialog: a title, a form, two buttons. */
export function SmallDialog({
  open,
  onClose,
  title,
  description,
  returnFocus,
  children,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}): ReactElement {
  const { t } = useLingui();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
        <Dialog.Popup className={smallDialogClassName} finalFocus={returnTo(returnFocus)}>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <Dialog.Title className="text-lg font-medium wrap-anywhere">{title}</Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className="text-md text-body wrap-anywhere">
                  {description}
                </Dialog.Description>
              )}
            </div>
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

/** Asks before something that is not undone with one press, and says why it did not happen. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy,
  problem,
  returnFocus,
  onConfirm,
  onClose,
}: {
  readonly open: boolean;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly busy: boolean;
  /** Why the last try failed, in the server's words or the page's. */
  readonly problem: string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <SmallDialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      returnFocus={returnFocus}
    >
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          <Trans>Go back</Trans>
        </Button>
        <Button
          variant={destructive ? 'secondary' : 'primary'}
          className={destructive ? 'border-destructive text-destructive' : undefined}
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </SmallDialog>
  );
}
