// Payments → Receipts: every payment recorded against an invoice, newest first, each with
// the receipt number it was given; and one receipt's own page, laid out as it is printed. A
// payment is recorded and reversed on its invoice's page.
import { Trans, useLingui } from '@lingui/react/macro';
import { getReceipt, listPayments } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { lazy, Suspense, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { SentLine } from './payments-document-sent';
import { DownloadPdf } from './payments-download';
import { PaymentsLink } from './payments-links';
import { ReceiptPaper } from './payments-paper';
import {
  Chip,
  FilterChips,
  PageIntro,
  Pager,
  Refused,
  rowLinkClassName,
  useFormats,
  usePaymentMethodNames,
} from './payments-parts';
import { documentSplat, receiptSplat } from './payments-rules';
import {
  cellClassName,
  headerCellClassName,
  listCardClassName,
  ListProblem,
  retryFaults,
  tableClassName,
  tableRegionClassName,
} from './settings-list';
import { emptyTrail, trailBack, trailCursor, trailForward } from './settings-rules';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

// The dialog that sends a receipt arrives when it is first opened.
const SendDialog = lazy(() => import('./payments-send-dialog'));

const PAGE_SIZE = 50;
type Status = 'all' | 'recorded' | 'reversed';

export default function ReceiptsPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const formats = useFormats();
  const methods = usePaymentMethodNames();
  const [status, setStatus] = useState<Status>('all');
  const [trail, setTrail] = useState(emptyTrail);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const said = {
    onDone: (message: string): void => {
      setProblem(undefined);
      setNotice(message);
    },
    onFailed: (message: string): void => {
      setNotice('');
      setProblem(message);
    },
  };
  const after = trailCursor(trail);
  const query = { status, ...(after === undefined ? {} : { after }), limit: PAGE_SIZE };
  const payments = useQuery({
    queryKey: ['b', business.id, 'payments', 'receipts', query] as const,
    queryFn: () => apiIn(business.id).request(listPayments, { query }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const listed = payments.data;
  const items = listed?.items ?? [];
  const refused = payments.error instanceof ApiError && payments.error.status === 403;
  const turning = payments.isFetching && payments.isPlaceholderData;

  return (
    <Page title={t`Receipts`}>
      <PageIntro>
        <Trans>Every payment recorded against an invoice, each with its receipt.</Trans>
      </PageIntro>
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <section aria-label={t`Receipts`} className={listCardClassName}>
        <div className="flex flex-wrap items-center gap-3">
          <FilterChips
            label={t`Status`}
            value={status}
            onChange={(next) => {
              setStatus(next);
              setTrail(emptyTrail);
            }}
            options={[
              { value: 'all', label: t`All` },
              { value: 'recorded', label: t`Received` },
              { value: 'reversed', label: t`Reversed` },
            ]}
          />
        </div>
        {payments.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {refused ? (
          <Refused />
        ) : payments.isError ? (
          <ListProblem
            onRetry={() => {
              setTrail(emptyTrail);
              void payments.refetch();
            }}
          >
            <Trans>The receipts couldn't be loaded.</Trans>
          </ListProblem>
        ) : null}
        {listed !== undefined && items.length === 0 ? (
          <p className="py-8 text-center text-md text-muted-foreground">
            {status === 'all' ? (
              <Trans>
                No payments yet. Record one on the page of an invoice and its receipt shows here.
              </Trans>
            ) : (
              <Trans>No receipts match.</Trans>
            )}
          </p>
        ) : null}
        {items.length === 0 ? null : (
          <div role="region" aria-label={t`Receipts table`} className={tableRegionClassName}>
            <table className={`${tableClassName} min-w-[860px]`}>
              <caption className="sr-only">
                <Trans>Receipts</Trans>
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={`${headerCellClassName} w-32`}>
                    <Trans>Receipt</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-32`}>
                    <Trans>Invoice</Trans>
                  </th>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Customer</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-36 text-right`}>
                    <Trans>Amount</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-32`}>
                    <Trans>Method</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-32`}>
                    <Trans>Date</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-28`}>
                    <Trans>Status</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-14`}>
                    <span className="sr-only">
                      <Trans>Actions</Trans>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((payment) => {
                  const receiptNumber = payment.number;
                  return (
                    <tr key={payment.id} className="hover:bg-muted">
                      <th scope="row" className={`${cellClassName} text-left`}>
                        <PaymentsLink
                          splat={receiptSplat(payment.id)}
                          className={`inline-flex min-h-11 items-center lg:min-h-0 ${rowLinkClassName}`}
                        >
                          {payment.number}
                        </PaymentsLink>
                      </th>
                      <td className={cellClassName}>
                        <PaymentsLink
                          splat={documentSplat('invoice', payment.invoiceId)}
                          className={`inline-flex min-h-11 items-center lg:min-h-0 ${rowLinkClassName}`}
                        >
                          {payment.invoiceNumber}
                        </PaymentsLink>
                      </td>
                      <td className={`${cellClassName} wrap-anywhere text-foreground`}>
                        {payment.customerName === '' ? (
                          <Trans>Unnamed contact</Trans>
                        ) : (
                          payment.customerName
                        )}
                      </td>
                      <td
                        className={`${cellClassName} text-right font-medium whitespace-nowrap text-foreground`}
                      >
                        {formats.money(payment.amount, payment.currency)}
                      </td>
                      <td className={cellClassName}>{methods[payment.method]}</td>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {formats.day(payment.paidOn)}
                      </td>
                      <td className={cellClassName}>
                        {payment.status === 'reversed' ? (
                          <Chip tone="danger">
                            <Trans>Reversed</Trans>
                          </Chip>
                        ) : (
                          <Chip tone="success">
                            <Trans>Received</Trans>
                          </Chip>
                        )}
                      </td>
                      <td className={`${cellClassName} text-right`}>
                        <DownloadPdf
                          icon
                          source={{ of: 'receipt', id: payment.id, number: payment.number }}
                          label={t`Download ${receiptNumber} as a PDF`}
                          {...said}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {listed === undefined ? null : (
          <Pager
            number={trail.index + 1}
            previous={trail.index > 0}
            next={listed.nextCursor !== null}
            busy={turning}
            onPrevious={() => {
              setTrail(trailBack);
            }}
            onNext={() => {
              setTrail(trailForward(trail, listed.nextCursor));
            }}
          />
        )}
      </section>
    </Page>
  );
}

/** One payment as its receipt. */
export function ReceiptPage({ id }: { readonly id: string }): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const queryKey = ['b', business.id, 'payments', 'receipts', 'one', id] as const;
  const receipt = useQuery({
    queryKey,
    queryFn: () => apiIn(business.id).request(getReceipt, { params: { id } }),
    retry: retryFaults,
  });
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const said = {
    onDone: (message: string): void => {
      setProblem(undefined);
      setNotice(message);
    },
    onFailed: (message: string): void => {
      setNotice('');
      setProblem(message);
    },
  };
  const [sending, setSending] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const shown = receipt.data;
  const actions =
    shown === undefined ? undefined : (
      <div className="flex flex-wrap items-center gap-2">
        <DownloadPdf
          source={{ of: 'receipt', id: shown.id, number: shown.number }}
          label={t`Download PDF`}
          {...said}
        />
        {/* A receipt goes to the contact of its invoice; a reversed payment's is not sent. */}
        {shown.canManage && shown.status === 'recorded' && shown.contactId !== null ? (
          <Button
            variant={(shown.sendCount ?? 0) === 0 ? 'primary' : 'secondary'}
            onClick={(event) => {
              returnFocusRef.current = event.currentTarget;
              setNotice('');
              setProblem(undefined);
              setSending(true);
            }}
          >
            <Trans>Send receipt</Trans>
          </Button>
        ) : null}
      </div>
    );
  const number = receipt.data?.number ?? '';
  const invoiceNumber = receipt.data?.invoiceNumber ?? '';
  const status = receipt.error instanceof ApiError ? receipt.error.status : undefined;
  return (
    <Page title={receipt.data === undefined ? t`Receipt` : t`Receipt ${number}`} actions={actions}>
      <PageIntro>
        <PaymentsLink
          splat="receipts"
          className="inline-flex min-h-11 items-center gap-1 text-link underline-offset-2 hover:underline lg:min-h-0"
        >
          <ArrowLeft aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>All receipts</Trans>
        </PaymentsLink>
      </PageIntro>
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      {receipt.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {status === 403 ? (
        <Refused />
      ) : status === 404 ? (
        <p role="alert" className="text-sm">
          <Trans>This receipt is not here.</Trans>
        </p>
      ) : receipt.isError ? (
        <ListProblem
          onRetry={() => {
            void receipt.refetch();
          }}
        >
          <Trans>The receipt couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {receipt.data === undefined ? null : (
        <div className="flex max-w-3xl min-w-0 flex-col gap-3">
          <ReceiptPaper receipt={receipt.data} />
          <p className="text-sm text-muted-foreground">
            <PaymentsLink
              splat={documentSplat('invoice', receipt.data.invoiceId)}
              className={rowLinkClassName}
            >
              <Trans>Open invoice {invoiceNumber}</Trans>
            </PaymentsLink>
          </p>
          {receipt.data.status === 'recorded' ? (
            <p className="text-sm text-muted-foreground">
              <SentLine
                kind="receipt"
                lastSentAt={receipt.data.lastSentAt}
                sendCount={receipt.data.sendCount}
              />
            </p>
          ) : null}
        </div>
      )}
      {sending && shown !== undefined ? (
        <Suspense fallback={null}>
          <SendDialog
            target={{ kind: 'receipt', receipt: shown }}
            returnFocus={returnFocusRef}
            onClose={() => {
              setSending(false);
            }}
            onConflict={() => {
              void receipt.refetch();
            }}
            onSent={(sent) => {
              const address = sent.to;
              setSending(false);
              if (sent.receipt !== undefined) cache.setQueryData(queryKey, sent.receipt);
              void cache.invalidateQueries({
                queryKey: ['b', business.id, 'payments', 'receipts'],
              });
              setProblem(undefined);
              setNotice(
                sent.deferred
                  ? t`It will be sent to ${address} after quiet hours, or when the mailbox's limit allows.`
                  : t`Sent to ${address}.`,
              );
            }}
          />
        </Suspense>
      ) : null}
    </Page>
  );
}
