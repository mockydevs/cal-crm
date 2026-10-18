// The panel the Conversations pages add and edit in: it slides in from the right over the
// list, as the custom field panel does. Base UI's Dialog keeps the keyboard inside it,
// closes it on Escape, and gives the keyboard back to what opened it.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Link } from '@tanstack/react-router';
import { X } from 'lucide-react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { returnTo } from './settings-list';
import { useBusiness } from './workspace';

export { sidePanelBodyClassName, sidePanelFooterClassName } from './list-toolbar';

export function RightPanel({
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
  /** The scrolling body and the pinned footer, drawn only while the panel is open. */
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
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup
          finalFocus={returnTo(returnFocus)}
          className="fixed inset-y-0 right-0 z-60 flex w-[min(520px,100%)] flex-col bg-card text-card-foreground shadow-xl outline-none"
        >
          <div className="flex min-w-0 items-start justify-between gap-3 border-b px-4 pt-[max(12px,env(safe-area-inset-top))] pb-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Dialog.Title className="text-lg font-medium wrap-anywhere">{title}</Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className="text-sm text-muted-foreground">
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

export { panelFormClassName } from './side-panel-classes';

export const linkClassName = 'text-link underline-offset-2 hover:underline';

/** A contact's name as a link to their page, or plain when they are in the trash. */
export function ContactName({
  contact,
}: {
  readonly contact: { readonly id: string; readonly name: string; readonly trashed: boolean };
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const name = contact.name === '' ? t`Unnamed` : contact.name;
  if (contact.trashed)
    return (
      <span className="wrap-anywhere">
        {name}{' '}
        <span className="font-normal text-muted-foreground">
          <Trans>(in the trash)</Trans>
        </span>
      </span>
    );
  return (
    <Link
      to="/b/$slug/contacts/$contactId"
      params={{ slug: business.slug, contactId: contact.id }}
      className={`${linkClassName} wrap-anywhere`}
    >
      {name}
    </Link>
  );
}
