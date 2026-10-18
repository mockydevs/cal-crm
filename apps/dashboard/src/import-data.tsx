// Settings → Import Data (laid out as GoHighLevel's): the one way to import there is, a CSV
// file of contacts, and the history of every import with its progress, its counts and the
// file of rows it did not apply. The steps of an import are in import-flow.tsx, fetched
// when an import is started. Everything here needs the permission to import contacts:
// without it the server answers 403, and the page says so in place of its content.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  cancelImport,
  createImportErrorFileLink,
  importStatuses,
  listImports,
  type ImportJob,
  type ImportStatus,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { cn } from '@repo/ui/lib/utils';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet } from 'lucide-react';
import { lazy, Suspense, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { useFieldSourceNames } from './custom-field-words';
import { progressOf } from './import-rules';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  ListFooter,
  ListProblem,
  retryFaults,
  tableClassName,
  tableRegionClassName,
} from './settings-list';
import {
  createdPresets,
  createdSince,
  emptyTrail,
  rangeOf,
  trailBack,
  trailCursor,
  trailForward,
  type CreatedPreset,
  type PageSize,
} from './settings-rules';
import { Page } from './shell/page';
import { useBusiness } from './workspace';

const ImportFlow = lazy(() => import('./import-flow'));

const ALL = 'all';

export const importsKey = (businessId: string) => ['b', businessId, 'imports'] as const;

const isActive = (job: ImportJob): boolean => job.status === 'pending' || job.status === 'running';

const pillClassNames: Readonly<Record<ImportStatus, string>> = {
  pending: cn('border-transparent bg-accent text-link'),
  running: cn('border-transparent bg-accent text-link'),
  completed: cn('border-success-line bg-success-subtle text-success'),
  failed: cn('border-transparent bg-secondary text-destructive'),
  cancelled: cn('border-transparent bg-secondary text-secondary-foreground'),
};

export function ImportDataPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const api = apiIn(business.id);
  const actorNames = useFieldSourceNames();
  const [status, setStatus] = useState<string>(ALL);
  const [started, setStarted] = useState<CreatedPreset>('any');
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [trail, setTrail] = useState(emptyTrail);
  const [importing, setImporting] = useState(false);
  const [stopping, setStopping] = useState<ImportJob>();
  const [notice, setNotice] = useState('');
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [now] = useState(() => new Date());

  const after = trailCursor(trail);
  const chosenStatus = importStatuses.find((each) => each === status);
  const startedFrom = createdSince(started, now);
  const history = useQuery({
    queryKey: [...importsKey(business.id), { chosenStatus, startedFrom, pageSize, after }],
    queryFn: () =>
      api.request(listImports, {
        query: {
          limit: pageSize,
          ...(chosenStatus === undefined ? {} : { status: chosenStatus }),
          ...(startedFrom === undefined ? {} : { startedFrom }),
          ...(after === undefined ? {} : { after }),
        },
      }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
    // An import that waits or runs is read again every few seconds, beside the realtime
    // hint each batch of rows sends, so its progress shows with no reload.
    refetchInterval: (query) => (query.state.data?.items.some(isActive) === true ? 2000 : false),
  });
  const forbidden = history.error instanceof ApiError && history.error.status === 403;

  const stop = useMutation({
    mutationFn: (job: ImportJob) => api.request(cancelImport, { params: { id: job.id } }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: importsKey(business.id) });
      setStopping(undefined);
      setNotice(t`The import is stopping.`);
    },
  });
  const errorFile = useMutation({
    mutationFn: (job: ImportJob) =>
      api.request(createImportErrorFileLink, { params: { id: job.id } }),
    onSuccess: (link) => {
      // The link opens the file itself, with no sign-in, for fifteen minutes.
      const anchor = document.createElement('a');
      anchor.href = link.url;
      anchor.download = '';
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    },
  });

  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const number = new Intl.NumberFormat(i18n.locale);
  const statusNames: Readonly<Record<ImportStatus, string>> = {
    pending: t`Waiting`,
    running: t`Importing`,
    completed: t`Completed`,
    failed: t`Failed`,
    cancelled: t`Cancelled`,
  };
  const startedNames: Readonly<Record<CreatedPreset, string>> = {
    any: t`Started: any time`,
    '7': t`Started: last 7 days`,
    '30': t`Started: last 30 days`,
    '90': t`Started: last 90 days`,
  };
  const objectNames = { contact: t`Contacts`, company: t`Companies`, deal: t`Opportunities` };
  const items = history.data?.items ?? [];
  const range = rangeOf({
    index: trail.index,
    pageSize,
    shown: items.length,
    total: history.data?.total ?? 0,
  });
  const filtered = chosenStatus !== undefined || started !== 'any';

  return (
    <Page title={t`Import Data`}>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {history.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading imports…</Trans>
        </p>
      ) : null}
      {forbidden ? (
        <p role="alert" className="text-md">
          <Trans>You need permission to import contacts.</Trans>
        </p>
      ) : history.isError ? (
        <ListProblem
          onRetry={() => {
            void history.refetch();
          }}
        >
          <Trans>The imports couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {history.data === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-6 rounded-card border border-border bg-card p-5">
          <section aria-labelledby="import-method-heading" className="flex min-w-0 flex-col gap-3">
            <h2 id="import-method-heading" className="text-base font-medium text-foreground">
              <Trans>Choose an import method</Trans>
            </h2>
            <div className="flex max-w-xl min-w-0 flex-col items-start gap-3 rounded-card border border-border p-4">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden
                  className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-link"
                >
                  <FileSpreadsheet className="size-5" strokeWidth={1.8} />
                </span>
                <h3 className="text-md font-medium text-foreground">
                  <Trans>Import contacts from CSV</Trans>
                </h3>
              </div>
              <p className="text-sm text-body">
                <Trans>
                  Upload a CSV file, map its columns, review the first rows, and import contacts.
                </Trans>
              </p>
              <Button
                onClick={(event) => {
                  returnFocusRef.current = event.currentTarget;
                  setNotice('');
                  setImporting(true);
                }}
              >
                <Trans>Start CSV import</Trans>
              </Button>
            </div>
          </section>
          <section aria-labelledby="import-history-heading" className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 id="import-history-heading" className="text-base font-medium text-foreground">
                <Trans>Import history</Trans>
              </h2>
              <p className="text-sm text-muted-foreground">
                <Trans>Track import progress, results, and errors.</Trans>
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Select
                aria-label={t`Started`}
                className="w-auto max-w-full min-w-40"
                value={started}
                onValueChange={(next) => {
                  setStarted(createdPresets.find((each) => each === next) ?? 'any');
                  setTrail(emptyTrail);
                }}
              >
                {createdPresets.map((each) => (
                  <option key={each} value={each}>
                    {startedNames[each]}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={t`Status`}
                className="w-auto max-w-full min-w-40"
                value={status}
                onValueChange={(next) => {
                  setStatus(next);
                  setTrail(emptyTrail);
                }}
              >
                <option value={ALL}>{t`Status: all`}</option>
                {importStatuses.map((each) => (
                  <option key={each} value={each}>
                    {statusNames[each]}
                  </option>
                ))}
              </Select>
            </div>
            {errorFile.isError ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {errorFile.error instanceof ApiError
                  ? (errorFile.error.problem.detail ?? t`The file of errors couldn't be opened.`)
                  : t`The file of errors couldn't be opened. Check your connection and try again.`}
              </p>
            ) : null}
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-8 text-center">
                <p className="text-md font-medium text-foreground">
                  {filtered ? <Trans>No imports match</Trans> : <Trans>No imports yet</Trans>}
                </p>
                <p className="text-sm text-muted-foreground">
                  {filtered ? (
                    <Trans>Change the filters to see other imports.</Trans>
                  ) : (
                    <Trans>Imports you start are listed here, with their results.</Trans>
                  )}
                </p>
              </div>
            ) : (
              <div
                role="region"
                aria-label={t`Import history table`}
                className={tableRegionClassName}
              >
                <table className={tableClassName}>
                  <caption className="sr-only">
                    <Trans>Import history</Trans>
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className={headerCellClassName}>
                        <Trans>Source</Trans>
                      </th>
                      <th scope="col" className={`${headerCellClassName} max-xl:hidden`}>
                        <Trans>Imported by</Trans>
                      </th>
                      <th scope="col" className={headerCellClassName}>
                        <Trans>Status</Trans>
                      </th>
                      <th scope="col" className={`${headerCellClassName} max-xl:hidden`}>
                        <Trans>Objects</Trans>
                      </th>
                      <th scope="col" className={`${headerCellClassName} max-sm:hidden`}>
                        <Trans>Records found</Trans>
                      </th>
                      <th scope="col" className={`${headerCellClassName} max-sm:hidden`}>
                        <Trans>Errors</Trans>
                      </th>
                      <th scope="col" className={`${headerCellClassName} max-xl:hidden`}>
                        <Trans>Started</Trans>
                      </th>
                      <th scope="col" className={`${headerCellClassName} max-xl:hidden`}>
                        <Trans>Completed</Trans>
                      </th>
                      <th scope="col" className={headerCellClassName}>
                        <Trans>Actions</Trans>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((job) => {
                      const { counts } = job;
                      const percent = progressOf(counts);
                      const name = job.fileName ?? '';
                      const found = number.format(counts.found);
                      const processed = number.format(counts.processed);
                      const created = number.format(counts.created);
                      const updated = number.format(counts.updated);
                      const skipped = number.format(counts.skipped);
                      const failed = number.format(counts.failed);
                      const by = job.startedBy.you
                        ? t`You`
                        : (job.startedBy.name ?? actorNames[job.startedBy.kind]);
                      const startedAt = moment.format(new Date(job.createdAt));
                      return (
                        <tr key={job.id} className="hover:bg-muted">
                          <th scope="row" className={`${cellClassName} text-left font-normal`}>
                            <span className="flex max-w-64 min-w-0 flex-col">
                              <span className="font-medium text-foreground">
                                {job.source === 'csv' ? t`CSV file` : t`GoHighLevel`}
                              </span>
                              {job.fileName === null ? null : (
                                <span className="truncate text-xs text-body" title={job.fileName}>
                                  {job.fileName}
                                </span>
                              )}
                              {/* The columns a narrow window folds away, said here instead. */}
                              <span className="text-xs text-body xl:hidden">
                                {by} · {startedAt}
                              </span>
                            </span>
                          </th>
                          <td className={`${cellClassName} max-xl:hidden`}>{by}</td>
                          <td className={cellClassName}>
                            <span className="flex min-w-0 flex-col items-start gap-1">
                              <span
                                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${pillClassNames[job.status]}`}
                              >
                                {job.cancelRequested && isActive(job)
                                  ? t`Stopping`
                                  : statusNames[job.status]}
                              </span>
                              {job.status === 'running' ? (
                                <span className="flex items-center gap-2 text-xs text-body">
                                  <progress
                                    aria-label={t`Progress of ${name}`}
                                    className="h-1.5 w-24 accent-primary"
                                    max={100}
                                    value={percent}
                                  />
                                  <Trans>
                                    {processed} of {found} rows
                                  </Trans>
                                </span>
                              ) : null}
                              {counts.processed > 0 ? (
                                <span className="text-xs text-body">
                                  <Trans>
                                    {created} created · {updated} updated · {skipped} skipped
                                  </Trans>
                                </span>
                              ) : null}
                              <span className="text-xs text-body sm:hidden">
                                <Trans>
                                  {found} found · {failed} with errors
                                </Trans>
                              </span>
                              {job.error === null ? null : (
                                <span className="max-w-64 text-xs wrap-anywhere text-destructive">
                                  {job.error.message}
                                </span>
                              )}
                            </span>
                          </td>
                          <td className={`${cellClassName} max-xl:hidden`}>
                            {job.objects.map((each) => objectNames[each]).join(', ')}
                          </td>
                          <td className={`${cellClassName} max-sm:hidden`}>{found}</td>
                          <td className={`${cellClassName} max-sm:hidden`}>{failed}</td>
                          <td className={`${cellClassName} max-xl:hidden`}>{startedAt}</td>
                          <td className={`${cellClassName} max-xl:hidden`}>
                            {job.finishedAt === null ? (
                              <>
                                <span aria-hidden>—</span>
                                <span className="sr-only">
                                  <Trans>Not finished</Trans>
                                </span>
                              </>
                            ) : (
                              moment.format(new Date(job.finishedAt))
                            )}
                          </td>
                          <td className={cellClassName}>
                            <span className="flex items-center gap-2">
                              {job.canCancel && isActive(job) && !job.cancelRequested ? (
                                <Button
                                  variant="secondary"
                                  size="small"
                                  aria-label={t`Stop the import of ${name}`}
                                  onClick={(event) => {
                                    returnFocusRef.current = event.currentTarget;
                                    stop.reset();
                                    setNotice('');
                                    setStopping(job);
                                  }}
                                >
                                  <Trans>Stop</Trans>
                                </Button>
                              ) : null}
                              {job.hasErrorFile ? (
                                <Button
                                  variant="secondary"
                                  size="small"
                                  aria-label={t`Download the rows of ${name} that were not imported`}
                                  disabled={errorFile.isPending}
                                  onClick={() => {
                                    errorFile.mutate(job);
                                  }}
                                >
                                  <Trans>Download errors</Trans>
                                </Button>
                              ) : null}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <ListFooter
              perPageLabel={t`Rows per page`}
              pageSize={pageSize}
              onPageSize={(size) => {
                setPageSize(size);
                setTrail(emptyTrail);
              }}
              range={range}
              number={trail.index + 1}
              previous={trail.index > 0}
              next={history.data.next !== null}
              busy={history.isFetching && history.isPlaceholderData}
              onPrevious={() => {
                setTrail(trailBack);
              }}
              onNext={() => {
                setTrail(trailForward(trail, history.data.next));
              }}
            />
          </section>
        </div>
      )}

      {importing ? (
        <Suspense fallback={null}>
          <ImportFlow
            returnFocus={returnFocusRef}
            onClose={() => {
              setImporting(false);
            }}
            onStarted={async () => {
              setStatus(ALL);
              setStarted('any');
              setTrail(emptyTrail);
              await cache.invalidateQueries({ queryKey: importsKey(business.id) });
              setImporting(false);
              setNotice(t`Import started.`);
            }}
          />
        </Suspense>
      ) : null}

      <ConfirmDialog
        open={stopping !== undefined}
        returnFocus={returnFocusRef}
        title={<Trans>Stop this import?</Trans>}
        description={
          <Trans>It stops after the batch of rows in hand. The rows already imported stay.</Trans>
        }
        confirmLabel={t`Stop import`}
        destructive
        busy={stop.isPending}
        problem={
          stop.isError
            ? stop.error instanceof ApiError
              ? (stop.error.problem.detail ?? t`The import wasn't stopped. Try again.`)
              : t`The import wasn't stopped. Check your connection and try again.`
            : undefined
        }
        onClose={() => {
          setStopping(undefined);
        }}
        onConfirm={() => {
          if (stopping !== undefined) stop.mutate(stopping);
        }}
      />
    </Page>
  );
}
