// The builder's dialogs: one frame for a step's panel, confirming a removal and publishing.
// Base UI's Dialog traps focus and closes on Escape; this adds the title, the close button,
// a size that fits a phone without scrolling the page behind it, and the return of focus to
// whatever opened it.
import { useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { X } from 'lucide-react';
import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react';

/** What a dialog's content marks as the place to start: a setting's control, or a button. */
export const INITIAL_FOCUS = '[data-field-control], [data-initial-focus]';

export interface AutomationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  /** Wider, for the before-and-after view. */
  readonly wide?: boolean;
  /**
   * A panel down the right-hand side of the window, as GoHighLevel's step panels are, in
   * place of a box in the middle. It is still a dialog: it keeps the keyboard and closes
   * on Escape.
   */
  readonly side?: boolean;
  /** Where the keyboard goes when it closes, when that isn't where it came from. */
  readonly finalFocus?: () => HTMLElement | null;
}

export function AutomationDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  side = false,
  finalFocus,
}: AutomationDialogProps): ReactElement {
  const { t } = useLingui();
  const popupRef = useRef<HTMLDivElement>(null);
  // These dialogs open from state, with no trigger element for the dialog to return to. So
  // what had the keyboard when it opened is remembered here, before focus moves inside.
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    openerRef.current =
      active instanceof HTMLElement && popupRef.current?.contains(active) !== true ? active : null;
  }, [open]);
  const backToOpener = (): HTMLElement | true => {
    const opener = openerRef.current;
    // The opener may be gone, such as the Edit button of a step just removed.
    return opener?.isConnected === true ? opener : true;
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={`fixed inset-0 z-50 ${side ? 'bg-foreground/20' : 'bg-foreground/40'}`}
        />
        <Dialog.Popup
          ref={popupRef}
          // The keyboard starts on the first thing to fill in or decide, when the content
          // marks one, rather than on the close button.
          initialFocus={() => popupRef.current?.querySelector<HTMLElement>(INITIAL_FOCUS) ?? true}
          finalFocus={() => finalFocus?.() ?? backToOpener()}
          data-side={side ? '' : undefined}
          className={
            side
              ? 'fixed inset-y-0 right-0 z-60 flex h-dvh w-[min(520px,100vw)] flex-col gap-4 overflow-y-auto overscroll-contain border-l border-border bg-card p-5 text-card-foreground shadow-xl outline-none'
              : `fixed top-1/2 left-1/2 z-60 flex max-h-[calc(100dvh-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto overscroll-contain rounded-card bg-card p-5 text-card-foreground shadow-xl outline-none ${
                  wide ? 'w-[min(760px,calc(100vw-32px))]' : 'w-[min(520px,calc(100vw-32px))]'
                }`
          }
        >
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <Dialog.Title className="text-xl font-semibold wrap-break-word">{title}</Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className="text-md text-muted-foreground">
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
