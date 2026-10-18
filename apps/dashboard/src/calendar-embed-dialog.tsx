// Settings → Calendars, a row's "Embed code", as GoHighLevel's: the code that shows the
// calendar's booking page on the business's own website, and a button that copies it.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { X } from 'lucide-react';
import { useId, useState, type ReactElement, type RefObject } from 'react';
import { embedCode } from './calendar-embed';
import { returnTo } from './settings-list';

export default function CalendarEmbedDialog({
  calendar,
  returnFocus,
  onClose,
}: {
  /** The calendar whose code is shown, with its booking page's full address; none: shut. */
  readonly calendar: { readonly name: string; readonly address: string } | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const codeId = useId();
  const [copied, setCopied] = useState<'yes' | 'no'>();
  const origin = window.location.origin;
  const code = calendar === undefined ? '' : embedCode(calendar.address, origin, calendar.name);
  const name = calendar?.name ?? '';
  return (
    <Dialog.Root
      open={calendar !== undefined}
      onOpenChange={(next) => {
        if (!next) {
          setCopied(undefined);
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
        <Dialog.Popup
          className="fixed top-1/2 left-1/2 z-[65] flex max-h-[calc(100dvh-32px)] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-card bg-card p-5 text-card-foreground shadow-xl outline-none"
          finalFocus={returnTo(returnFocus)}
        >
          <div className="flex min-w-0 items-start justify-between gap-3 border-b border-border pb-4">
            <div className="flex min-w-0 flex-col gap-1">
              <Dialog.Title className="text-lg font-medium">
                <Trans>Embed code</Trans>
              </Dialog.Title>
              <Dialog.Description className="text-md text-muted-foreground">
                <Trans>
                  Paste this code into your website where the calendar should appear. Visitors book
                  without leaving your page.
                </Trans>
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
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={codeId} className="text-sm font-medium">
              <Trans>Code for {name}</Trans>
            </label>
            <textarea
              id={codeId}
              readOnly
              rows={5}
              value={code}
              spellCheck={false}
              className="w-full min-w-0 resize-none rounded-control border border-input bg-muted p-3 font-mono text-sm break-all text-foreground"
              onFocus={(event) => {
                event.currentTarget.select();
              }}
            />
          </div>
          <p className="text-sm text-body">
            <Trans>
              If your website sets a Content-Security-Policy, allow {origin} in its frame-src and
              script-src.
            </Trans>
          </p>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <p role="status" className="text-sm text-body">
              {copied === 'yes'
                ? t`Embed code copied.`
                : copied === 'no'
                  ? t`The code couldn't be copied. Select it and copy it yourself.`
                  : ''}
            </p>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(code).then(
                  () => {
                    setCopied('yes');
                  },
                  () => {
                    setCopied('no');
                  },
                );
              }}
            >
              <Trans>Copy code</Trans>
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
