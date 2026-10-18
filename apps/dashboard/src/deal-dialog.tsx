// The opportunity dialog: a centred
// dialog over the board or the list, and a full-height sheet on a phone. Which opportunity
// is open is in the address, so the page behind it stays as it was, a reload opens it again
// and Back closes it. Base UI's Dialog keeps the keyboard inside and gives it back on
// closing; leaving with unsaved changes, by any way out, asks first.
import { Trans, useLingui } from '@lingui/react/macro';
import type { Deal, Pipeline } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { useBlocker } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { PickedContact } from './deal-contact-search';
import DealEditor from './deal-editor-loader';
import type { DealSection } from './deal-search';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface OpenDeal {
  /** What the address calls it: the opportunity's id, or "new". */
  readonly key: string;
  /** The opportunity, or undefined for one being added. */
  readonly deal: Deal | undefined;
  /** The pipeline it is in, or the one a new opportunity starts in. */
  readonly pipeline: Pipeline;
  /** Every pipeline, so the form can move it to another. */
  readonly pipelines: readonly Pipeline[];
  /** The primary contact a new opportunity starts with, when it is added from a contact. */
  readonly contact?: PickedContact | undefined;
}

export function DealDialog({
  opened,
  businessId,
  section,
  onSection,
  onClose,
  onSaved,
  onTrashed,
  fallbackFocus,
}: {
  /** What is open; undefined closes the dialog. */
  readonly opened: OpenDeal | undefined;
  readonly businessId: string;
  readonly section: DealSection;
  readonly onSection: (section: DealSection) => void;
  /** Asks to close: the page takes the opportunity out of the address. */
  readonly onClose: () => void;
  readonly onSaved: (deal: Deal) => void;
  readonly onTrashed: (deal: Deal) => void;
  /** Where the keyboard goes on closing when what opened the dialog is gone. */
  readonly fallbackFocus: () => HTMLElement | null;
}): ReactElement {
  const { t } = useLingui();
  const open = opened !== undefined;
  const popupRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // The dialog opens from the address, with no trigger of its own to return to: what had
  // the keyboard when it opened is remembered here, before focus moves inside.
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    openerRef.current =
      active instanceof HTMLElement &&
      active !== document.body &&
      popupRef.current?.contains(active) !== true
        ? active
        : null;
  }, [open]);
  // Which opportunity's details hold unsaved changes: none once another one, or none, is open.
  const [dirtyKey, setDirtyKey] = useState<string>();
  const dirty = open && dirtyKey === opened.key;
  const openKey = opened?.key;
  const blocker = useBlocker({
    // Changing the section stays on this opportunity; anything else would drop the changes.
    shouldBlockFn: ({ current, next }) => {
      const search: unknown = next.search;
      const staying =
        next.pathname === current.pathname && isRecord(search) && search['deal'] === openKey;
      return dirty && !staying;
    },
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });
  const deal = opened?.deal;
  const name = deal?.name ?? '';
  const readOnly = deal !== undefined && (!deal.canManage || deal.trashedAt !== null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup
          ref={popupRef}
          // The keyboard starts in the form once it is there, not on the close button.
          initialFocus={() =>
            popupRef.current?.querySelector<HTMLElement>('[data-initial-focus]') ?? true
          }
          finalFocus={() => {
            const opener = openerRef.current;
            // The opener may be gone, such as the card of an opportunity moved to the trash.
            return opener?.isConnected === true ? opener : (fallbackFocus() ?? true);
          }}
          className="fixed inset-0 z-60 flex flex-col bg-card text-card-foreground outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(720px,calc(100dvh-48px))] sm:w-[min(820px,calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:overflow-hidden sm:rounded-card sm:shadow-xl"
        >
          <div className="flex min-w-0 items-start justify-between gap-3 border-b px-5 pt-[max(16px,env(safe-area-inset-top))] pb-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Dialog.Title className="text-lg font-medium wrap-anywhere">
                {deal === undefined ? (
                  <Trans>Add new opportunity</Trans>
                ) : readOnly ? (
                  name
                ) : (
                  <Trans>Edit {name}</Trans>
                )}
              </Dialog.Title>
              <Dialog.Description className="text-sm text-muted-foreground">
                {deal === undefined ? (
                  <Trans>Create a new opportunity by filling in its details.</Trans>
                ) : readOnly ? (
                  <Trans>See this opportunity's details, tasks, notes and activity.</Trans>
                ) : (
                  <Trans>Add and edit this opportunity's details, tasks and notes.</Trans>
                )}
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          {opened === undefined ? null : (
            <DealEditor
              key={opened.key}
              deal={opened.deal}
              pipeline={opened.pipeline}
              pipelines={opened.pipelines}
              contact={opened.contact}
              businessId={businessId}
              section={section}
              onSection={onSection}
              onClose={onClose}
              onSaved={onSaved}
              onTrashed={onTrashed}
              onDirtyChange={(changed) => {
                setDirtyKey(changed ? opened.key : undefined);
              }}
            />
          )}
          <Dialog.Root
            open={blocker.status === 'blocked'}
            onOpenChange={(next) => {
              if (!next) blocker.reset?.();
            }}
          >
            <Dialog.Portal>
              <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
              <Dialog.Popup
                // On the way that loses nothing.
                initialFocus={keepRef}
                className="fixed top-1/2 left-1/2 z-[65] flex w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-card bg-card p-5 text-card-foreground shadow-xl outline-none"
              >
                <div className="flex flex-col gap-1">
                  <Dialog.Title className="text-lg font-medium">
                    <Trans>You have unsaved changes</Trans>
                  </Dialog.Title>
                  <Dialog.Description className="text-md text-muted-foreground">
                    <Trans>Your changes to this opportunity haven't been saved.</Trans>
                  </Dialog.Description>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="secondary"
                    className="border-destructive text-destructive"
                    onClick={() => {
                      blocker.proceed?.();
                    }}
                  >
                    <Trans>Discard changes</Trans>
                  </Button>
                  <Button
                    ref={keepRef}
                    onClick={() => {
                      blocker.reset?.();
                    }}
                  >
                    <Trans>Keep editing</Trans>
                  </Button>
                </div>
              </Dialog.Popup>
            </Dialog.Portal>
          </Dialog.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
