// The dialogs of an email row's menu: Block, with an optional reason; Unblock of a hard
// bounce, once "unblock" is typed; and why an opt-out is not unblocked here. Fetched when
// one is opened; its words are in the email verification catalog, loaded with the row.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useId, useState, type ReactElement, type RefObject } from 'react';
import { SmallDialog } from '../settings-list';

interface DialogProps {
  readonly shown: string;
  readonly busy: boolean;
  readonly problem: string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}

export default function AddressDialog({
  kind,
  optOut,
  onBlock,
  onUnblock,
  ...props
}: DialogProps & {
  readonly kind: 'block' | 'unblock_bounce' | 'opted_out';
  readonly optOut: 'complaint' | 'unsubscribe';
  readonly onBlock: (reason: string) => void;
  readonly onUnblock: () => void;
}): ReactElement {
  switch (kind) {
    case 'block':
      return <BlockDialog {...props} onBlock={onBlock} />;
    case 'unblock_bounce':
      return <UnblockBounceDialog {...props} onUnblock={onUnblock} />;
    case 'opted_out':
      return <OptedOutDialog {...props} optOut={optOut} />;
  }
}

function OptedOutDialog({
  shown,
  optOut,
  returnFocus,
  onClose,
}: DialogProps & { readonly optOut: 'complaint' | 'unsubscribe' }): ReactElement {
  const { t } = useLingui();
  return (
    <SmallDialog
      open
      title={t`${shown} can't be unblocked here`}
      description={
        optOut === 'complaint'
          ? t`They marked an email from you as spam. Email them again only once they agree to it: record their consent on the contact.`
          : t`They unsubscribed from your email. Email them again only once they agree to it: record their consent on the contact.`
      }
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <div className="flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          <Trans>Close</Trans>
        </Button>
      </div>
    </SmallDialog>
  );
}

function BlockDialog({
  shown,
  busy,
  problem,
  returnFocus,
  onBlock,
  onClose,
}: DialogProps & { readonly onBlock: (reason: string) => void }): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [reason, setReason] = useState('');
  return (
    <SmallDialog
      open
      title={t`Block ${shown}?`}
      description={t`No email is sent to this address until someone unblocks it.`}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onBlock(reason.trim());
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-reason`} className="text-sm font-medium">
            <Trans>Reason (optional)</Trans>
          </label>
          <Input
            id={`${id}-reason`}
            maxLength={200}
            autoComplete="off"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </div>
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={busy}>
            <Trans>Block</Trans>
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

function UnblockBounceDialog({
  shown,
  busy,
  problem,
  returnFocus,
  onUnblock,
  onClose,
}: DialogProps & { readonly onUnblock: () => void }): ReactElement {
  const { t } = useLingui();
  const id = useId();
  const [typed, setTyped] = useState('');
  const confirmed = typed.trim().toLowerCase() === 'unblock';
  return (
    <SmallDialog
      open
      title={t`Unblock ${shown}?`}
      description={t`An email to it bounced, so the mailbox may not exist. Sending to it again can hurt how your other email is delivered.`}
      returnFocus={returnFocus}
      onClose={onClose}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed) onUnblock();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-confirm`} className="text-sm font-medium">
            <Trans>Type unblock to confirm</Trans>
          </label>
          <Input
            id={`${id}-confirm`}
            autoComplete="off"
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        </div>
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={busy || !confirmed}>
            <Trans>Unblock</Trans>
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}
