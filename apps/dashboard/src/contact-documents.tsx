// A contact's quotes and invoices on the contact page, under Actions, and an opportunity's
// in its dialog: the newest twenty, each opening on its own page in Payments, and for
// someone who may manage payments the way to start a quote or an invoice for the contact or
// the opportunity. Someone who may not see payments is told so in a line.
import { Trans, useLingui } from '@lingui/react/macro';
import { listSalesDocuments } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button, buttonVariants } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { ReactElement } from 'react';
import { apiIn } from './api';
import { PaymentsLink } from './payments-links';
import { DocumentChip, rowLinkClassName, useFormats } from './payments-parts';
import { documentSplat } from './payments-rules';
import type { PaymentsSearch } from './payments-search';
import { useBusiness } from './workspace';

const LISTED = 20;

/** Whose documents are listed: a contact's, or an opportunity's. */
type Owner =
  | { readonly contactId: string }
  | {
      readonly dealId: string;
      /** The opportunity's primary contact, who a new document is for; null when it has none. */
      readonly primaryContactId: string | null;
    };

function DocumentsOf({
  owner,
  readOnly,
}: {
  readonly owner: Owner;
  readonly readOnly: boolean;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const formats = useFormats();
  const ofDeal = 'dealId' in owner;
  const documents = useQuery({
    // Under one key with the contact's, so a change made in Payments refreshes both.
    queryKey: ofDeal
      ? ['b', business.id, 'contact-documents', 'deal', owner.dealId]
      : ['b', business.id, 'contact-documents', owner.contactId],
    queryFn: () =>
      apiIn(business.id).request(listSalesDocuments, {
        query: ofDeal
          ? { dealId: owner.dealId, limit: LISTED }
          : { contactId: owner.contactId, limit: LISTED },
      }),
    retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
  });
  if (documents.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        <Trans>Loading quotes and invoices…</Trans>
      </p>
    );
  if (documents.isError) {
    if (documents.error instanceof ApiError && documents.error.status === 403)
      return (
        <p className="text-sm text-muted-foreground">
          <Trans>Seeing quotes and invoices needs permission to see payments.</Trans>
        </p>
      );
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>
          <Trans>The quotes and invoices couldn't be loaded.</Trans>
        </p>
        <Button
          variant="secondary"
          size="small"
          onClick={() => {
            void documents.refetch();
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      </div>
    );
  }
  const { items, nextCursor, canManage } = documents.data;
  const startClassName = buttonVariants({ variant: 'secondary', size: 'small' });
  // A new document is for a contact: an opportunity's primary one, with the opportunity named.
  const start: PaymentsSearch | undefined = ofDeal
    ? owner.primaryContactId === null
      ? undefined
      : { contact: owner.primaryContactId, deal: owner.dealId }
    : { contact: owner.contactId };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {ofDeal ? (
            <Trans>No quote or invoice for this opportunity yet.</Trans>
          ) : (
            <Trans>No quote or invoice for this contact yet.</Trans>
          )}
        </p>
      ) : null}
      <ul
        aria-label={
          ofDeal
            ? t`Quotes and invoices of this opportunity`
            : t`Quotes and invoices of this contact`
        }
        className="flex min-w-0 flex-col gap-2"
        hidden={items.length === 0}
      >
        {items.map((document) => {
          const invoice = document.kind === 'invoice';
          return (
            <li
              key={document.id}
              className="flex min-w-0 flex-col gap-1 rounded-control border border-border p-2.5 text-sm"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <PaymentsLink
                  splat={documentSplat(document.kind, document.id)}
                  className={`min-w-0 ${rowLinkClassName}`}
                >
                  {document.number ??
                    (invoice ? <Trans>Draft invoice</Trans> : <Trans>Draft quote</Trans>)}
                </PaymentsLink>
                <DocumentChip document={document} />
              </span>
              <span className="text-xs text-muted-foreground">
                {invoice ? <Trans>Invoice</Trans> : <Trans>Quote</Trans>}
                {document.issueDate === null ? null : ` · ${formats.day(document.issueDate)}`}
              </span>
              <span className="font-medium text-foreground">
                {formats.money(document.total, document.currency)}
              </span>
            </li>
          );
        })}
      </ul>
      {nextCursor === null ? null : (
        <p className="text-sm text-muted-foreground">
          {ofDeal ? (
            <Trans>This opportunity has more quotes and invoices than are listed here.</Trans>
          ) : (
            <Trans>This contact has more quotes and invoices than are listed here.</Trans>
          )}
        </p>
      )}
      {!canManage || readOnly ? null : start === undefined ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            Give this opportunity a primary contact to start a quote or an invoice for it.
          </Trans>
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <PaymentsLink splat={documentSplat('quote')} search={start} className={startClassName}>
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>New quote</Trans>
          </PaymentsLink>
          <PaymentsLink splat={documentSplat('invoice')} search={start} className={startClassName}>
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>New invoice</Trans>
          </PaymentsLink>
        </div>
      )}
    </div>
  );
}

export function ContactDocuments({
  contactId,
  readOnly,
}: {
  readonly contactId: string;
  /** True for a contact in the trash: its documents are listed and none is started. */
  readonly readOnly: boolean;
}): ReactElement {
  return <DocumentsOf owner={{ contactId }} readOnly={readOnly} />;
}

/** An opportunity's quotes and invoices, in its dialog. */
export function DealDocuments({
  dealId,
  primaryContactId,
  readOnly,
}: {
  readonly dealId: string;
  readonly primaryContactId: string | null;
  /** True for an opportunity in the trash, or one the reader may not change. */
  readonly readOnly: boolean;
}): ReactElement {
  return <DocumentsOf owner={{ dealId, primaryContactId }} readOnly={readOnly} />;
}
