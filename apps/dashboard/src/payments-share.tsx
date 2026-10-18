// Beside an issued quote or invoice: the link its customer opens without signing in, with
// the ways to copy it, open it and replace it; and the team's own note, which is never
// printed. Fetched after the page, so the page's own code stays small.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createSalesDocumentLink,
  setSalesDocumentNote,
  type SalesDocument,
  type SalesDocumentLink,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Textarea } from '@repo/ui/components/textarea';
import { useMutation } from '@tanstack/react-query';
import { Copy, ExternalLink } from 'lucide-react';
import { useId, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { ConfirmDialog, iconButtonClassName, RowMenu, savingProblem } from './settings-list';
import { useBusiness } from './workspace';

const cardClassName = 'flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4';
const cardTitleClassName = 'text-base font-medium text-foreground';

/** The public address of an issued document: shown, copied, opened, made and replaced. */
export function LinkCard({
  document,
  onLink,
  onNotice,
}: {
  readonly document: SalesDocument;
  /** A link was made or replaced: the page shows the document with it. */
  readonly onLink: (link: SalesDocumentLink, message: string) => void;
  readonly onNotice: (message: string) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const link = document.publicLink ?? null;
  const quote = document.kind === 'quote';
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();
  /** Why this install makes no link, in the server's words: shown where the button was. */
  const [unavailable, setUnavailable] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const make = useMutation({
    mutationFn: (regenerate: boolean) =>
      apiIn(business.id).request(createSalesDocumentLink, {
        params: { id: document.id },
        body: { regenerate },
      }),
    onSuccess: (made, regenerate) => {
      setConfirming(false);
      setProblem(undefined);
      onLink(
        made,
        regenerate ? t`A new link was made. The old one no longer works.` : t`Link created.`,
      );
    },
    onError: (error, regenerate) => {
      const fallback = t`The link wasn't made. Check your connection and try again.`;
      const why = savingProblem(error, fallback).form ?? fallback;
      // An install that serves no public pages says so, and will say so again.
      if (!regenerate && error instanceof ApiError && error.status === 409) setUnavailable(why);
      else setProblem(why);
    },
  });
  const copy = (address: string): void => {
    void navigator.clipboard.writeText(address).then(
      () => {
        onNotice(t`Link copied.`);
      },
      () => {
        onNotice(t`The link couldn't be copied. Select it and copy it yourself.`);
      },
    );
  };
  return (
    <section aria-label={t`Link for the customer`} className={cardClassName}>
      <h2 className={cardTitleClassName}>
        <Trans>Link for the customer</Trans>
      </h2>
      {link === null ? (
        unavailable !== undefined ? (
          <p className="text-sm text-body">{unavailable}</p>
        ) : document.canManage ? (
          <>
            <p className="text-sm text-muted-foreground">
              {quote ? (
                <Trans>
                  A page the customer opens without signing in, to read the quote, download its PDF
                  and accept or decline it.
                </Trans>
              ) : (
                <Trans>
                  A page the customer opens without signing in, to read the invoice and download its
                  PDF.
                </Trans>
              )}
            </p>
            <Button
              variant="secondary"
              className="self-start"
              disabled={make.isPending}
              onClick={() => {
                setProblem(undefined);
                make.mutate(false);
              }}
            >
              {make.isPending ? <Trans>Creating…</Trans> : <Trans>Create link</Trans>}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            <Trans>No link has been made for this document yet.</Trans>
          </p>
        )
      ) : (
        <>
          <div className="flex min-w-0 items-center gap-1">
            <span
              className="min-w-0 flex-1 truncate rounded-control bg-muted px-2 py-1.5 font-mono text-xs text-body select-all"
              title={link.url}
            >
              {link.url}
            </span>
            <button
              type="button"
              className={iconButtonClassName}
              aria-label={t`Copy link`}
              title={t`Copy link`}
              onClick={() => {
                copy(link.url);
              }}
            >
              <Copy aria-hidden className="size-4" strokeWidth={1.8} />
            </button>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className={iconButtonClassName}
              aria-label={t`Open link in a new tab`}
              title={t`Open link in a new tab`}
            >
              <ExternalLink aria-hidden className="size-4" strokeWidth={1.8} />
            </a>
            {document.canManage ? (
              <RowMenu
                label={t`Link actions`}
                actions={[
                  {
                    label: t`Make a new link`,
                    onSelect: () => {
                      setProblem(undefined);
                      setConfirming(true);
                    },
                  },
                ]}
                onOpen={(trigger) => {
                  returnFocusRef.current = trigger;
                }}
              />
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {quote ? (
              <Trans>
                Anyone with this link can read the quote and download its PDF without signing in,
                and accept or decline it while it is open.
              </Trans>
            ) : (
              <Trans>
                Anyone with this link can read the invoice and download its PDF without signing in.
              </Trans>
            )}
          </p>
        </>
      )}
      {problem === undefined || confirming ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        title={<Trans>Make a new link?</Trans>}
        description={
          <Trans>
            The link you have now stops working at once, wherever it was sent: in emails, in chats
            and in bookmarks. Send the new one to the customer again.
          </Trans>
        }
        confirmLabel={make.isPending ? t`Making…` : t`Make a new link`}
        destructive
        busy={make.isPending}
        problem={problem}
        returnFocus={returnFocusRef}
        onClose={() => {
          if (!make.isPending) setConfirming(false);
        }}
        onConfirm={() => {
          make.mutate(true);
        }}
      />
    </section>
  );
}

/** The team's own note on a document: written on an issued one too, and never printed. */
export function NoteCard({
  document,
  onSaved,
}: {
  readonly document: SalesDocument;
  readonly onSaved: (latest: SalesDocument, message: string) => void;
}): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const id = useId();
  const [text, setText] = useState(document.internalNote);
  const [problem, setProblem] = useState<string>();
  const save = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(setSalesDocumentNote, {
        params: { id: document.id },
        body: { internalNote: text.trim() },
      }),
    onSuccess: (latest) => {
      setText(latest.internalNote);
      setProblem(undefined);
      onSaved(latest, t`Note saved.`);
    },
    onError: (error) => {
      const fallback = t`The note wasn't saved. Check your connection and try again.`;
      const refused = savingProblem(error, fallback);
      setProblem(refused.fields['internalNote'] ?? refused.form ?? fallback);
    },
  });
  // Someone who may only look sees a note that was written, and no empty box.
  if (!document.canManage && document.internalNote === '') return null;
  const changed = text.trim() !== document.internalNote;
  return (
    <section className={cardClassName}>
      <h2 className={cardTitleClassName}>
        <label htmlFor={id}>
          <Trans>Internal note (never printed)</Trans>
        </label>
      </h2>
      <Textarea
        id={id}
        rows={3}
        maxLength={5000}
        readOnly={!document.canManage}
        aria-invalid={problem !== undefined}
        aria-describedby={`${id}-hint`}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        <Trans>Only your team sees it. It is not on the PDF, the link or the email.</Trans>
      </p>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      {document.canManage ? (
        <Button
          variant="secondary"
          className="self-start"
          disabled={!changed || save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {save.isPending ? <Trans>Saving…</Trans> : <Trans>Save note</Trans>}
        </Button>
      ) : null}
    </section>
  );
}
