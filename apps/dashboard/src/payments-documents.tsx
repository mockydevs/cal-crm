// Payments → Invoices and Payments → Quotes: one list for both kinds, newest first, a page
// at a time as the server pages them. A row opens the document's own page, where it is
// written, issued and paid. Reading needs permission to see payments; starting one needs
// the permission the server reports with canManage.
import { Trans, useLingui } from '@lingui/react/macro';
import { listSalesDocuments, type SalesDocumentKind } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { buttonVariants } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { ListSearch } from './list-toolbar';
import { DownloadPdf } from './payments-download';
import { PaymentsLink } from './payments-links';
import {
  DocumentChip,
  FilterChips,
  PageIntro,
  Pager,
  Refused,
  rowLinkClassName,
  useFormats,
  useMarkNames,
} from './payments-parts';
import { documentSplat, statusFilters, type StatusFilter } from './payments-rules';
import {
  cellClassName,
  headerCellClassName,
  listCardClassName,
  ListProblem,
  retryFaults,
  tableClassName,
  tableRegionClassName,
  useSettled,
} from './settings-list';
import { emptyTrail, trailBack, trailCursor, trailForward } from './settings-rules';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const PAGE_SIZE = 50;

export default function DocumentsPage({
  kind,
}: {
  readonly kind: SalesDocumentKind;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const formats = useFormats();
  const names = useMarkNames();
  const invoice = kind === 'invoice';
  const [text, setText] = useState('');
  const settled = useSettled(text);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
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

  // Another list starts at its first page.
  const asked = `${settled.trim()}:${status}:${from}:${to}`;
  const [shown, setShown] = useState(asked);
  if (shown !== asked) {
    setShown(asked);
    setTrail(emptyTrail);
  }

  const q = settled.trim();
  const after = trailCursor(trail);
  const query = {
    kind,
    status,
    ...(q === '' ? {} : { q }),
    ...(from === '' ? {} : { issuedFrom: from }),
    ...(to === '' ? {} : { issuedTo: to }),
    ...(after === undefined ? {} : { after }),
    limit: PAGE_SIZE,
  };
  const documents = useQuery({
    queryKey: ['b', business.id, 'payments', 'documents', query] as const,
    queryFn: () => apiIn(business.id).request(listSalesDocuments, { query }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });

  const listed = documents.data;
  const items = listed?.items ?? [];
  const canManage = listed?.canManage === true;
  const refused = documents.error instanceof ApiError && documents.error.status === 403;
  const turning = documents.isFetching && documents.isPlaceholderData;
  const narrowed = q !== '' || status !== 'all' || from !== '' || to !== '';
  const title = invoice ? t`Invoices` : t`Quotes`;
  const newLink = (
    <PaymentsLink splat={documentSplat(kind)} className={buttonVariants()}>
      <Plus aria-hidden className="size-4" strokeWidth={2} />
      {invoice ? <Trans>New invoice</Trans> : <Trans>New quote</Trans>}
    </PaymentsLink>
  );
  const filters: readonly StatusFilter[] = statusFilters[kind];

  return (
    <Page title={title} actions={canManage ? newLink : undefined}>
      <PageIntro>
        {invoice ? (
          <Trans>Bill your customers, record what they pay and see what is still owed.</Trans>
        ) : (
          <Trans>Price the work for a customer, then turn an accepted quote into an invoice.</Trans>
        )}
      </PageIntro>
      <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
        {notice}
      </p>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <section aria-label={title} className={listCardClassName}>
        <div className="flex flex-wrap items-center gap-3">
          <FilterChips
            label={t`Status`}
            value={status}
            onChange={setStatus}
            options={filters.map((each) => ({ value: each, label: names[each] }))}
          />
          <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
            <Input
              type="date"
              aria-label={t`Issued from`}
              title={t`Issued from`}
              className="w-auto"
              value={from}
              max={to === '' ? undefined : to}
              onChange={(event) => {
                setFrom(event.target.value);
              }}
            />
            <Input
              type="date"
              aria-label={t`Issued to`}
              title={t`Issued to`}
              className="w-auto"
              value={to}
              min={from === '' ? undefined : from}
              onChange={(event) => {
                setTo(event.target.value);
              }}
            />
            <ListSearch
              label={invoice ? t`Search invoices` : t`Search quotes`}
              value={text}
              onChange={setText}
            />
          </div>
        </div>
        {documents.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {refused ? (
          <Refused />
        ) : documents.isError ? (
          <ListProblem
            onRetry={() => {
              setTrail(emptyTrail);
              void documents.refetch();
            }}
          >
            {invoice ? (
              <Trans>The invoices couldn't be loaded.</Trans>
            ) : (
              <Trans>The quotes couldn't be loaded.</Trans>
            )}
          </ListProblem>
        ) : null}
        {listed !== undefined && items.length === 0 ? (
          narrowed ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              {invoice ? <Trans>No invoices match.</Trans> : <Trans>No quotes match.</Trans>}
            </p>
          ) : (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-md text-muted-foreground">
                {invoice ? (
                  <Trans>No invoices yet. Start one for a contact, or make one from a quote.</Trans>
                ) : (
                  <Trans>
                    No quotes yet. Start one for a contact and issue it when it is ready.
                  </Trans>
                )}
              </p>
              {canManage ? newLink : null}
            </div>
          )
        ) : null}
        {items.length === 0 ? null : (
          <div
            role="region"
            aria-label={invoice ? t`Invoices table` : t`Quotes table`}
            className={tableRegionClassName}
          >
            <table className={`${tableClassName} min-w-[860px]`}>
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr>
                  <th scope="col" className={`${headerCellClassName} w-36`}>
                    <Trans>Number</Trans>
                  </th>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Customer</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-32`}>
                    <Trans>Issued</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-32`}>
                    {invoice ? <Trans>Due</Trans> : <Trans>Valid until</Trans>}
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-36 text-right`}>
                    <Trans>Total</Trans>
                  </th>
                  {invoice ? (
                    <th scope="col" className={`${headerCellClassName} w-36 text-right`}>
                      <Trans>Balance</Trans>
                    </th>
                  ) : null}
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
                {items.map((document) => {
                  const customer = document.customerName;
                  const named =
                    document.number ??
                    (customer === '' ? t`this draft` : t`the draft for ${customer}`);
                  return (
                    <tr key={document.id} className="hover:bg-muted">
                      <th scope="row" className={`${cellClassName} text-left`}>
                        <PaymentsLink
                          splat={documentSplat(kind, document.id)}
                          className={`inline-flex min-h-11 items-center lg:min-h-0 ${rowLinkClassName}`}
                          aria-label={
                            document.number ??
                            (customer === '' ? t`Draft` : t`Draft for ${customer}`)
                          }
                        >
                          {document.number ?? <Trans>Draft</Trans>}
                        </PaymentsLink>
                      </th>
                      <td className={`${cellClassName} wrap-anywhere text-foreground`}>
                        {customer === '' ? <Trans>Unnamed contact</Trans> : customer}
                      </td>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {document.issueDate === null ? '—' : formats.day(document.issueDate)}
                      </td>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {document.dueDate === null ? '—' : formats.day(document.dueDate)}
                      </td>
                      <td
                        className={`${cellClassName} text-right font-medium whitespace-nowrap text-foreground`}
                      >
                        {formats.money(document.total, document.currency)}
                      </td>
                      {invoice ? (
                        <td className={`${cellClassName} text-right whitespace-nowrap`}>
                          {formats.money(document.balanceDue, document.currency)}
                        </td>
                      ) : null}
                      <td className={cellClassName}>
                        <DocumentChip document={document} />
                      </td>
                      <td className={`${cellClassName} text-right`}>
                        <DownloadPdf
                          icon
                          source={{ of: kind, id: document.id, number: document.number }}
                          label={t`Download ${named} as a PDF`}
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
