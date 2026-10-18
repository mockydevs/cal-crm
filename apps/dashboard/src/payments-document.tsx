// One quote's or one invoice's own page. A draft is written here
// (payments-document-editor.tsx); an issued one shows the paper it stored when it was
// issued, never the business as it is now, with what can be done to it next: the buttons
// are the document's own `actions`, for someone the server says may manage payments.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  acceptQuote,
  convertQuoteToInvoice,
  declineQuote,
  deleteSalesDocument,
  documentSendRefusal,
  duplicateSalesDocument,
  getSalesDocument,
  reversePayment,
  reviseSalesDocument,
  voidInvoice,
  type Payment,
  type SalesDocument,
  type SalesDocumentAction,
  type SalesDocumentKind,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Download, Undo2 } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { apiIn } from './api';
import { SentLine } from './payments-document-sent';
import { useDownloadPdf } from './payments-download';
import { PaymentsLink, usePaymentsNavigate } from './payments-links';
import { DocumentPaper, type PaperLine } from './payments-paper';
import {
  Chip,
  DocumentChip,
  Labelled,
  PageIntro,
  Refused,
  rowLinkClassName,
  useCommerceSettings,
  useFormats,
  usePaymentMethodNames,
  useProfile,
} from './payments-parts';
import {
  documentSplat,
  draftOf,
  kindSplat,
  newDraft,
  receiptSplat,
  sellerOfProfile,
  sellerOfSnapshot,
} from './payments-rules';
import type { PaymentsSearch } from './payments-search';
import {
  ConfirmDialog,
  iconButtonClassName,
  ListProblem,
  retryFaults,
  RowMenu,
  savingProblem,
} from './settings-list';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const DocumentEditor = lazy(() => import('./payments-document-editor'));
// The dialogs arrive when one is first opened.
const PaymentDialog = lazy(async () => ({
  default: (await import('./payments-document-dialogs')).PaymentDialog,
}));
const ReasonDialog = lazy(async () => ({
  default: (await import('./payments-document-dialogs')).ReasonDialog,
}));
const SendDialog = lazy(() => import('./payments-send-dialog'));
// The link for the customer and the team's note come after the paper.
const LinkCard = lazy(async () => ({ default: (await import('./payments-share')).LinkCard }));
const NoteCard = lazy(async () => ({ default: (await import('./payments-share')).NoteCard }));

const cardClassName = 'flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4';
const cardTitleClassName = 'text-base font-medium text-foreground';

export const documentKey = (businessId: string, id: string | undefined): readonly unknown[] => [
  'b',
  businessId,
  'payments',
  'document',
  id,
];
/** What a page that was just left has to say on the page that opens: read once. */
const flashKey = (businessId: string): readonly unknown[] => ['b', businessId, 'payments-flash'];

type Opened = 'void' | 'delete' | 'payment' | 'send' | { readonly reverse: Payment };

export default function DocumentPage({
  kind: asked,
  id,
  search,
}: {
  readonly kind: SalesDocumentKind;
  /** Undefined for a document being started. */
  readonly id: string | undefined;
  readonly search: PaymentsSearch;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const api = apiIn(business.id);
  const go = usePaymentsNavigate();
  const profile = useProfile();
  const read = useQuery({
    queryKey: documentKey(business.id, id),
    queryFn: () => api.request(getSalesDocument, { params: { id: id ?? '' } }),
    enabled: id !== undefined,
    retry: retryFaults,
  });
  const document = read.data;
  const kind = document?.kind ?? asked;
  const invoice = kind === 'invoice';
  // The settings word a new draft and number the next one issued: only who may manage
  // payments writes, and anyone who reads documents may read them.
  const settings = useCommerceSettings(id === undefined || document !== undefined);
  const [notice, setNotice] = useState(
    () => cache.getQueryData<string>(flashKey(business.id)) ?? '',
  );
  useEffect(() => {
    cache.removeQueries({ queryKey: flashKey(business.id) });
  }, [cache, business.id]);
  const [problem, setProblem] = useState<string>();
  const [opened, setOpened] = useState<Opened>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Sending a draft issues it, and saving one draws its form again: the button that opened
  // the dialog may be gone when it closes, and the page's Send button takes the keyboard.
  const sendFocusRef = useMemo(
    () => ({
      get current(): HTMLElement | null {
        const opener = returnFocusRef.current;
        return opener?.isConnected === true
          ? opener
          : window.document.querySelector<HTMLElement>('[data-send-button]');
      },
    }),
    [],
  );
  // A dialog that leaves with its opener has nowhere to hand the keyboard back to: once the
  // page has drawn the document as it now is, its Send button takes it.
  const sendOpen = opened === 'send';
  const wasSendOpenRef = useRef(false);
  useEffect(() => {
    const closed = wasSendOpenRef.current && !sendOpen;
    wasSendOpenRef.current = sendOpen;
    if (!closed) return;
    const frame = requestAnimationFrame(() => {
      const active = window.document.activeElement;
      if (active === null || active === window.document.body) sendFocusRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [sendOpen, sendFocusRef]);
  const pdf = useDownloadPdf({
    onDone: (message) => {
      setProblem(undefined);
      setNotice(message);
    },
    onFailed: (message) => {
      setNotice('');
      setProblem(message);
    },
  });

  const refreshLists = (): void => {
    for (const part of ['documents', 'receipts', 'settings'])
      void cache.invalidateQueries({ queryKey: ['b', business.id, 'payments', part] });
    void cache.invalidateQueries({ queryKey: ['b', business.id, 'contact-documents'] });
  };
  /** The document as the server now has it: shown here, or on its own page when it is another. */
  const settle = (latest: SalesDocument, message: string): void => {
    cache.setQueryData(documentKey(business.id, latest.id), latest);
    refreshLists();
    setOpened(undefined);
    setProblem(undefined);
    if (latest.id === id) {
      setNotice(message);
      return;
    }
    cache.setQueryData(flashKey(business.id), message);
    go(documentSplat(latest.kind, latest.id), id === undefined);
  };
  const act = useMutation({
    mutationFn: async (action: 'revise' | 'accept' | 'decline' | 'convert' | 'duplicate') => {
      const endpoint = {
        revise: reviseSalesDocument,
        accept: acceptQuote,
        decline: declineQuote,
        convert: convertQuoteToInvoice,
        duplicate: duplicateSalesDocument,
      }[action];
      return api.request(endpoint, { params: { id: id ?? '' } });
    },
    onSuccess: (latest, action) => {
      const number = document?.number ?? '';
      settle(
        latest,
        {
          revise: t`It is a draft again, with the same number. Issue it when it is right.`,
          accept: t`Marked as accepted.`,
          decline: t`Marked as declined.`,
          convert: t`This draft invoice was made from quote ${number}.`,
          duplicate: t`This draft is a copy. Nothing was changed on the original.`,
        }[action],
      );
    },
    onError: (error) => {
      const fallback = t`It wasn't done. Check your connection and try again.`;
      setProblem(savingProblem(error, fallback).form ?? fallback);
      void read.refetch();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.request(deleteSalesDocument, { params: { id: id ?? '' } }),
    onSuccess: () => {
      refreshLists();
      cache.removeQueries({ queryKey: documentKey(business.id, id) });
      go(kindSplat[kind], true);
    },
    onError: (error) => {
      const fallback = t`It wasn't deleted. Check your connection and try again.`;
      setProblem(savingProblem(error, fallback).form ?? fallback);
    },
  });

  const open = (next: Opened, trigger: HTMLElement | null): void => {
    returnFocusRef.current = trigger;
    setOpened(next);
    setNotice('');
    setProblem(undefined);
  };
  const close = (): void => {
    setOpened(undefined);
    setProblem(undefined);
  };
  const run = (action: Parameters<typeof act.mutate>[0]): void => {
    setNotice('');
    setProblem(undefined);
    act.mutate(action);
  };

  const download = (saved: SalesDocument): void => {
    setNotice('');
    setProblem(undefined);
    pdf.run({ of: saved.kind, id: saved.id, number: saved.number });
  };
  // Who may manage payments sends a document that is for a contact still here, unless it is void.
  const sendable =
    document?.canManage === true &&
    document.contactId !== null &&
    documentSendRefusal(document, true) === undefined;
  const number = document?.number ?? '';
  const title =
    document === undefined
      ? invoice
        ? t`New invoice`
        : t`New quote`
      : document.number === null
        ? invoice
          ? t`Draft invoice`
          : t`Draft quote`
        : invoice
          ? t`Invoice ${number}`
          : t`Quote ${number}`;
  const back = (
    <PaymentsLink
      splat={kindSplat[kind]}
      className="inline-flex min-h-11 items-center gap-1 text-link underline-offset-2 hover:underline lg:min-h-0"
    >
      <ArrowLeft aria-hidden className="size-4" strokeWidth={1.8} />
      {invoice ? <Trans>All invoices</Trans> : <Trans>All quotes</Trans>}
    </PaymentsLink>
  );
  const frame = (actions: ReactNode, body: ReactNode): ReactElement => (
    <Page title={title} actions={actions}>
      <PageIntro>{back}</PageIntro>
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {problem === undefined || opened !== undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      {body}
      {opened === 'send' && document !== undefined && settings.data !== undefined ? (
        <Suspense fallback={null}>
          <SendDialog
            target={{
              kind: 'document',
              document,
              nextNumber: document.number ?? settings.data.numbering[document.kind].example,
            }}
            returnFocus={sendFocusRef}
            onClose={close}
            onConflict={() => {
              void read.refetch();
            }}
            onSent={(sent) => {
              const address = sent.to;
              if (sent.document !== undefined)
                settle(
                  sent.document,
                  sent.deferred
                    ? t`It will be sent to ${address} after quiet hours, or when the mailbox's limit allows.`
                    : t`Sent to ${address}.`,
                );
            }}
          />
        </Suspense>
      ) : null}
      <ConfirmDialog
        open={opened === 'delete'}
        title={<Trans>Delete this draft?</Trans>}
        description={
          <Trans>It was never issued, so it has no number. It will be deleted for good.</Trans>
        }
        confirmLabel={t`Delete for good`}
        destructive
        busy={remove.isPending}
        problem={problem}
        returnFocus={returnFocusRef}
        onClose={close}
        onConfirm={() => {
          remove.mutate();
        }}
      />
    </Page>
  );
  const loading = (
    <p role="status" className="text-sm text-muted-foreground">
      <Trans>Loading…</Trans>
    </p>
  );

  const failure = [read.error, settings.error, profile.error].find((error) => error !== null);
  if (failure !== undefined) {
    const status = failure instanceof ApiError ? failure.status : undefined;
    return frame(
      undefined,
      status === 403 ? (
        <Refused />
      ) : status === 404 ? (
        <p role="alert" className="text-sm">
          {invoice ? (
            <Trans>This invoice is no longer here. It may have been deleted.</Trans>
          ) : (
            <Trans>This quote is no longer here. It may have been deleted.</Trans>
          )}
        </p>
      ) : (
        <ListProblem
          onRetry={() => {
            for (const query of [read, settings, profile]) if (query.isError) void query.refetch();
          }}
        >
          <Trans>This page couldn't be loaded.</Trans>
        </ListProblem>
      ),
    );
  }
  if (
    profile.data === undefined ||
    settings.data === undefined ||
    (id !== undefined && document === undefined)
  )
    return frame(undefined, loading);

  const can = (action: SalesDocumentAction): boolean =>
    document?.canManage === true && document.actions.includes(action);

  if (document === undefined || (document.status === 'draft' && can('update'))) {
    if (document === undefined && !settings.data.canManage)
      return frame(
        undefined,
        <p className="text-md text-muted-foreground">
          <Trans>Starting a quote or an invoice needs permission to manage payments.</Trans>
        </p>,
      );
    return (
      <Suspense fallback={frame(undefined, loading)}>
        <DocumentEditor
          key={document === undefined ? 'new' : `${document.id}:${String(document.revision)}`}
          kind={kind}
          document={document}
          initial={
            document === undefined
              ? newDraft({
                  currency: profile.data.currency,
                  settings: settings.data,
                  contact: null,
                  dealId: search.deal ?? null,
                  lineKey: 'new-0',
                })
              : draftOf(document)
          }
          prefillContactId={document === undefined ? search.contact : undefined}
          profile={profile.data}
          settings={settings.data}
          frame={frame}
          busy={act.isPending || remove.isPending}
          onSettled={settle}
          onReload={() => {
            setNotice('');
            void read.refetch();
          }}
          onDuplicate={
            can('duplicate')
              ? () => {
                  run('duplicate');
                }
              : undefined
          }
          onDelete={
            can('delete')
              ? (trigger) => {
                  open('delete', trigger);
                }
              : undefined
          }
          onDownload={document === undefined ? undefined : download}
          onSend={
            sendable
              ? (_saved, trigger) => {
                  open('send', trigger);
                }
              : undefined
          }
        />
      </Suspense>
    );
  }

  const busy = act.isPending;
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {can('decline') ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            run('decline');
          }}
        >
          <Trans>Mark declined</Trans>
        </Button>
      ) : null}
      {can('accept') ? (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            run('accept');
          }}
        >
          <Trans>Mark accepted</Trans>
        </Button>
      ) : null}
      {can('convert') ? (
        <Button
          disabled={busy}
          onClick={() => {
            run('convert');
          }}
        >
          <Trans>Convert to invoice</Trans>
        </Button>
      ) : null}
      {can('record_payment') ? (
        <Button
          disabled={busy}
          onClick={(event) => {
            open('payment', event.currentTarget);
          }}
        >
          <Trans>Record payment</Trans>
        </Button>
      ) : null}
      <Button
        variant="secondary"
        disabled={pdf.pending}
        onClick={() => {
          download(document);
        }}
      >
        <Download aria-hidden className="size-4" strokeWidth={1.8} />
        {document.status === 'draft' ? (
          <Trans>Download draft PDF</Trans>
        ) : (
          <Trans>Download PDF</Trans>
        )}
      </Button>
      {sendable ? (
        <Button
          // The first send is what the page is for next; after it, sending again is one way on.
          variant={(document.sendCount ?? 0) === 0 ? 'primary' : 'secondary'}
          data-send-button
          disabled={busy}
          onClick={(event) => {
            open('send', event.currentTarget);
          }}
        >
          <Trans>Send</Trans>
        </Button>
      ) : null}
      {!can('revise') && !can('duplicate') && !can('void') ? null : (
        <RowMenu
          label={t`More actions`}
          actions={[
            ...(can('revise')
              ? [
                  {
                    label: t`Revise`,
                    immediate: true,
                    onSelect: () => {
                      run('revise');
                    },
                  },
                ]
              : []),
            ...(can('duplicate')
              ? [
                  {
                    label: t`Duplicate`,
                    immediate: true,
                    onSelect: () => {
                      run('duplicate');
                    },
                  },
                ]
              : []),
            ...(can('void')
              ? [
                  {
                    label: t`Void invoice`,
                    destructive: true,
                    onSelect: () => {
                      open('void', returnFocusRef.current);
                    },
                  },
                ]
              : []),
          ]}
          onOpen={(trigger) => {
            returnFocusRef.current = trigger;
          }}
        />
      )}
    </div>
  );
  const reversing = typeof opened === 'object' ? opened.reverse : undefined;
  const reversingNumber = reversing?.number ?? '';

  return frame(
    actions,
    <>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <IssuedPaper document={document} profile={profile.data} settings={settings.data} />
        <div className="flex min-w-0 flex-col gap-4">
          <Summary document={document} />
          {document.kind === 'invoice' ? (
            <Payments
              invoice={document}
              canReverse={document.canManage}
              onReverse={(payment, trigger) => {
                open({ reverse: payment }, trigger);
              }}
            />
          ) : null}
          <Suspense fallback={null}>
            {document.status === 'draft' || document.status === 'void' ? null : (
              <LinkCard
                document={document}
                onNotice={(message) => {
                  setProblem(undefined);
                  setNotice(message);
                }}
                onLink={(publicLink, message) => {
                  cache.setQueryData(documentKey(business.id, document.id), {
                    ...document,
                    publicLink,
                  });
                  setProblem(undefined);
                  setNotice(message);
                  void read.refetch();
                }}
              />
            )}
            <NoteCard key={document.revision} document={document} onSaved={settle} />
          </Suspense>
        </div>
      </div>
      <Suspense fallback={null}>
        {opened === 'payment' ? (
          <PaymentDialog
            invoice={document}
            timeZone={profile.data.timezone}
            returnFocus={returnFocusRef}
            onClose={close}
            onRecorded={(receipt) => {
              const receiptNumber = receipt.number;
              close();
              refreshLists();
              setNotice(t`Payment recorded. Its receipt is ${receiptNumber}.`);
              void read.refetch();
            }}
          />
        ) : null}
        {opened === 'void' ? (
          <ReasonDialog
            title={<Trans>Void this invoice?</Trans>}
            description={
              <Trans>
                {number} is kept, marked void with your reason, and nothing more can be paid on it.
                This can't be undone; duplicate it to bill again.
              </Trans>
            }
            confirmLabel={<Trans>Void invoice</Trans>}
            fallback={t`It wasn't voided. Check your connection and try again.`}
            returnFocus={returnFocusRef}
            onClose={close}
            run={async (reason) => {
              const latest = await api.request(voidInvoice, {
                params: { id: document.id },
                body: { reason },
              });
              settle(latest, t`The invoice is void.`);
            }}
          />
        ) : null}
        {reversing === undefined ? null : (
          <ReasonDialog
            title={<Trans>Reverse this payment?</Trans>}
            description={
              <Trans>
                {reversingNumber} is kept, marked reversed with your reason, and the invoice owes
                that amount again.
              </Trans>
            }
            confirmLabel={<Trans>Reverse payment</Trans>}
            fallback={t`It wasn't reversed. Check your connection and try again.`}
            returnFocus={returnFocusRef}
            onClose={close}
            run={async (reason) => {
              await api.request(reversePayment, { params: { id: reversing.id }, body: { reason } });
              close();
              refreshLists();
              setNotice(t`Payment ${reversingNumber} was reversed.`);
              void read.refetch();
            }}
          />
        )}
      </Suspense>
    </>,
  );
}

/** The paper of a saved document: from its own snapshots once issued. */
function IssuedPaper({
  document,
  profile,
  settings,
}: {
  readonly document: SalesDocument;
  readonly profile: Parameters<typeof sellerOfProfile>[0];
  readonly settings: Parameters<typeof sellerOfProfile>[1];
}): ReactElement {
  const lines: PaperLine[] = document.lines.map((line) => ({
    key: line.id,
    name: line.name,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unitPrice: line.unitPrice,
    taxRate: /^0(\.0+)?$/.test(line.taxRate) ? null : line.taxRate,
    amount: line.amount,
    discount: line.discountAmount,
  }));
  const issued = document.kind === 'invoice' && document.status !== 'draft';
  return (
    <DocumentPaper
      kind={document.kind}
      number={document.number}
      chip={<DocumentChip document={document} />}
      // A draft someone may only look at has no snapshot yet: the business as it is now.
      seller={
        document.seller === null
          ? sellerOfProfile(profile, settings)
          : sellerOfSnapshot(document.seller)
      }
      customer={document.customer}
      issueDate={document.issueDate}
      dueDate={document.dueDate}
      currency={document.currency}
      lines={lines}
      totals={{
        subtotal: document.totals.subtotal,
        discountTotal: document.totals.discountTotal,
        taxes: document.totals.taxes,
        total: document.totals.total,
        ...(issued
          ? { amountPaid: document.totals.amountPaid, balanceDue: document.totals.balanceDue }
          : {}),
      }}
      notes={document.notes}
      terms={document.terms}
    />
  );
}

/** Where the document stands, beside its paper: small grey labels above bold values. */
function Summary({ document }: { readonly document: SalesDocument }): ReactElement {
  const business = useBusiness();
  const formats = useFormats();
  const money = (amount: string): string => formats.money(amount, document.currency);
  const invoice = document.kind === 'invoice';
  const customer = document.customer.name;
  return (
    <section className={cardClassName}>
      <h2 className={cardTitleClassName}>
        <Trans>Summary</Trans>
      </h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Labelled label={<Trans>Status</Trans>}>
          <DocumentChip document={document} />
        </Labelled>
        <Labelled label={<Trans>Total</Trans>}>{money(document.totals.total)}</Labelled>
        {invoice ? (
          <>
            <Labelled label={<Trans>Paid</Trans>}>{money(document.totals.amountPaid)}</Labelled>
            <Labelled label={<Trans>Balance due</Trans>}>
              {money(document.totals.balanceDue)}
            </Labelled>
          </>
        ) : null}
        <Labelled label={<Trans>Customer</Trans>} className="col-span-2">
          {document.contactId === null ? (
            customer
          ) : (
            <Link
              to="/b/$slug/contacts/$contactId"
              params={{ slug: business.slug, contactId: document.contactId }}
              className={rowLinkClassName}
            >
              {customer === '' ? <Trans>Unnamed contact</Trans> : customer}
            </Link>
          )}
        </Labelled>
        {document.quoteId === null ? null : (
          <Labelled label={<Trans>Made from</Trans>} className="col-span-2">
            <PaymentsLink
              splat={documentSplat('quote', document.quoteId)}
              className={rowLinkClassName}
            >
              <Trans>The quote it was made from</Trans>
            </PaymentsLink>
          </Labelled>
        )}
        {document.invoiceId === null ? null : (
          <Labelled label={<Trans>Invoiced as</Trans>} className="col-span-2">
            <PaymentsLink
              splat={documentSplat('invoice', document.invoiceId)}
              className={rowLinkClassName}
            >
              <Trans>The invoice made from it</Trans>
            </PaymentsLink>
          </Labelled>
        )}
        {document.voidReason === null ? null : (
          <Labelled label={<Trans>Why it is void</Trans>} className="col-span-2">
            {document.voidReason}
          </Labelled>
        )}
        {document.status === 'draft' ? null : (
          <Labelled label={<Trans>Emailed to the customer</Trans>} className="col-span-2">
            <SentLine
              kind="document"
              lastSentAt={document.lastSentAt}
              sendCount={document.sendCount}
            />
          </Labelled>
        )}
      </dl>
    </section>
  );
}

/** An invoice's payments, oldest first, each a receipt; one recorded by mistake is reversed. */
function Payments({
  invoice,
  canReverse,
  onReverse,
}: {
  readonly invoice: SalesDocument;
  readonly canReverse: boolean;
  readonly onReverse: (payment: Payment, trigger: HTMLElement) => void;
}): ReactElement {
  const { t } = useLingui();
  const formats = useFormats();
  const methods = usePaymentMethodNames();
  return (
    <section aria-label={t`Payments`} className={cardClassName}>
      <h2 className={cardTitleClassName}>
        <Trans>Payments</Trans>
      </h2>
      {invoice.payments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Nothing has been paid on this invoice yet.</Trans>
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col">
          {invoice.payments.map((payment) => {
            const paymentNumber = payment.number;
            const reversed = payment.status === 'reversed';
            return (
              <li
                key={payment.id}
                className="flex min-w-0 items-center gap-2 border-t border-border py-2 first:border-t-0 first:pt-0"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <PaymentsLink splat={receiptSplat(payment.id)} className={rowLinkClassName}>
                      {payment.number}
                    </PaymentsLink>
                    {reversed ? (
                      <Chip tone="danger">
                        <Trans>Reversed</Trans>
                      </Chip>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formats.day(payment.paidOn)} · {methods[payment.method]}
                  </span>
                </span>
                <span
                  className={`text-sm font-semibold whitespace-nowrap ${reversed ? 'text-muted-foreground line-through' : 'text-foreground'}`}
                >
                  {formats.money(payment.amount, payment.currency)}
                </span>
                {canReverse && !reversed ? (
                  <button
                    type="button"
                    className={iconButtonClassName}
                    aria-label={t`Reverse payment ${paymentNumber}`}
                    onClick={(event) => {
                      onReverse(payment, event.currentTarget);
                    }}
                  >
                    <Undo2 aria-hidden className="size-4" strokeWidth={1.8} />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
