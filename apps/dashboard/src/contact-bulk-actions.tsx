// Contacts → Bulk Actions (laid out as GoHighLevel's): the changes made to many contacts at
// once, newest first, a page at a time, filtered on the server. A row says who started the
// action, how far it has got, when its next batch runs and when it ended; "Show stats" lists
// what became of each contact and why a skipped one was skipped, and an export's file is
// downloaded from its row. An action still going is read again every few seconds, and can
// be stopped while the server says it can (what was already done stays done).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  cancelContactBulkAction,
  createContactExportLink,
  contactBulkActionKinds,
  contactBulkStatuses,
  listContactBulkActionItems,
  listContactBulkActions,
  type ContactBulkAction,
  type ContactBulkActionKind,
  type ContactBulkItem,
  type ContactBulkStatus,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import {
  bulkActionLabel,
  bulkProgress,
  bulkStillGoing,
  itemOutcomeFilters,
  type ItemOutcomeFilter,
} from './contact-bulk-rules';
import {
  linkClassName,
  RightPanel,
  sidePanelBodyClassName,
  sidePanelFooterClassName,
} from './conversation-extras-panel';
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

const ANY = 'any';
/** How often a page holding an action that is still going is read again. */
const POLL_MS = 3000;

const bulkKey = (businessId: string) => ['b', businessId, 'contact-bulk-actions'] as const;

function useWords(): {
  readonly kinds: Record<ContactBulkActionKind, string>;
  readonly statuses: Record<ContactBulkStatus, string>;
  readonly outcomes: Record<ItemOutcomeFilter, string>;
} {
  const { t } = useLingui();
  return {
    kinds: {
      add_tags: t`Add tag`,
      remove_tags: t`Remove tag`,
      trash: t`Move to trash`,
      assign_owner: t`Assign owner`,
      add_to_workflow: t`Add to workflow`,
      export: t`Export`,
      send_email: t`Email`,
      send_sms: t`SMS`,
      set_dnd: t`Do not disturb`,
      add_opportunity: t`Opportunity`,
      verify_emails: t`Email verification`,
    },
    statuses: {
      queued: t`Queued`,
      running: t`Processing`,
      completed: t`Complete`,
      cancelled: t`Cancelled`,
      failed: t`Failed`,
    },
    outcomes: {
      all: t`All`,
      done: t`Changed`,
      unchanged: t`Already as asked`,
      skipped: t`Skipped`,
      pending: t`Waiting`,
    },
  };
}

export function ContactBulkActionsPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const api = apiIn(business.id);
  const words = useWords();
  const [status, setStatus] = useState<ContactBulkStatus | typeof ANY>(ANY);
  const [kind, setKind] = useState<ContactBulkActionKind | typeof ANY>(ANY);
  const [trail, setTrail] = useState(emptyTrail);
  const [openedId, setOpenedId] = useState<string>();
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const after = trailCursor(trail);
  const actions = useQuery({
    queryKey: [...bulkKey(business.id), 'list', { status, kind, after }],
    queryFn: () =>
      api.request(listContactBulkActions, {
        query: {
          ...(status === ANY ? {} : { status }),
          ...(kind === ANY ? {} : { action: kind }),
          ...(after === undefined ? {} : { after }),
        },
      }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
    refetchInterval: (query) =>
      (query.state.data?.items ?? []).some(bulkStillGoing) ? POLL_MS : false,
  });
  const refused = actions.error instanceof ApiError && actions.error.status === 403;
  const items = actions.data?.items ?? [];
  const opened = items.find((each) => each.id === openedId);

  const cancel = useMutation({
    mutationFn: (action: ContactBulkAction) =>
      api.request(cancelContactBulkAction, { params: { id: action.id } }),
    onSuccess: async (stopped) => {
      setProblem(undefined);
      setNotice(
        stopped.status === 'cancelled'
          ? t`Action stopped. What was already done stays done.`
          : t`The action had already ended.`,
      );
      await cache.invalidateQueries({ queryKey: bulkKey(business.id) });
    },
    onError: (error) => {
      setNotice('');
      setProblem(
        error instanceof ApiError && error.status === 403
          ? t`You don't have permission to stop this action.`
          : t`The action wasn't stopped. Check your connection and try again.`,
      );
    },
  });

  // An export's file opens by a fresh link, which lasts a few minutes: the browser saves it.
  const download = useMutation({
    mutationFn: (action: ContactBulkAction) =>
      api.request(createContactExportLink, { params: { id: action.id } }),
    onSuccess: (link) => {
      setProblem(undefined);
      window.location.assign(link.url);
    },
    onError: (error) => {
      setNotice('');
      setProblem(
        error instanceof ApiError && error.status === 403
          ? t`You don't have permission to download exports.`
          : t`The file couldn't be downloaded. Check your connection and try again.`,
      );
    },
  });

  const filter = <Value,>(set: (value: Value) => void) => {
    return (value: Value) => {
      set(value);
      setTrail(emptyTrail);
      setNotice('');
      setProblem(undefined);
    };
  };
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const unfiltered = status === ANY && kind === ANY;
  const pageNumber = trail.index + 1;
  const busy = actions.isFetching && actions.isPlaceholderData;

  return (
    <Page title={t`Bulk actions`}>
      <p className="text-md text-muted-foreground">
        <Trans>Track progress and results for bulk actions.</Trans>
      </p>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {refused ? (
        <p className="text-md text-muted-foreground">
          <Trans>Seeing the bulk actions needs permission to manage contacts.</Trans>
        </p>
      ) : (
        <section aria-label={t`Bulk actions`} className={listCardClassName}>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={t`Status`}
              className="w-auto max-w-full min-w-36"
              value={status}
              onValueChange={(next) => {
                filter(setStatus)(contactBulkStatuses.find((each) => each === next) ?? ANY);
              }}
            >
              <option value={ANY}>{t`All statuses`}</option>
              {contactBulkStatuses.map((each) => (
                <option key={each} value={each}>
                  {words.statuses[each]}
                </option>
              ))}
            </Select>
            <Select
              aria-label={t`Action`}
              className="w-auto max-w-full min-w-36"
              value={kind}
              onValueChange={(next) => {
                filter(setKind)(contactBulkActionKinds.find((each) => each === next) ?? ANY);
              }}
            >
              <option value={ANY}>{t`All actions`}</option>
              {contactBulkActionKinds.map((each) => (
                <option key={each} value={each}>
                  {words.kinds[each]}
                </option>
              ))}
            </Select>
          </div>
          {problem === undefined ? null : (
            <p role="alert" className="text-sm font-medium text-destructive">
              {problem}
            </p>
          )}
          {actions.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading bulk actions…</Trans>
            </p>
          ) : null}
          {actions.isError ? (
            <ListProblem
              onRetry={() => {
                void actions.refetch();
              }}
            >
              <Trans>The bulk actions couldn't be loaded.</Trans>
            </ListProblem>
          ) : null}
          {actions.data !== undefined && items.length === 0 ? (
            <p className="py-6 text-center text-md text-muted-foreground">
              {unfiltered && trail.index === 0 ? (
                <Trans>
                  No bulk actions yet. Select contacts in a smart list to change many at once.
                </Trans>
              ) : (
                <Trans>No bulk actions match.</Trans>
              )}
            </p>
          ) : null}
          {items.length === 0 ? null : (
            <div role="region" aria-label={t`Bulk actions table`} className={tableRegionClassName}>
              <table className={`${tableClassName} min-w-[1040px] table-fixed`}>
                <caption className="sr-only">
                  <Trans>Bulk actions</Trans>
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={`${headerCellClassName} w-[20%]`}>
                      <Trans>Action label</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[11%]`}>
                      <Trans>Operation</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[15%]`}>
                      <Trans>Status</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[14%]`}>
                      <Trans>User</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[13%]`}>
                      <Trans>Created</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[13%]`}>
                      <Trans>Completed</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[14%] text-right`}>
                      <Trans>Actions</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((action) => {
                    const label = bulkActionLabel(action, i18n.locale);
                    const next =
                      action.nextBatchAt === null
                        ? undefined
                        : moment.format(new Date(action.nextBatchAt));
                    const filename = action.file?.filename;
                    const { settled, requested } = bulkProgress(action);
                    return (
                      <tr key={action.id}>
                        <th
                          scope="row"
                          className={`${cellClassName} truncate text-left font-medium text-foreground`}
                          title={label}
                        >
                          {label}
                        </th>
                        <td className={cellClassName}>{words.kinds[action.action]}</td>
                        <td className={cellClassName}>
                          <StatusPill status={action.status} />
                          {bulkStillGoing(action) ? (
                            <span className="ml-2 text-xs whitespace-nowrap text-muted-foreground">
                              <Trans>
                                {settled} of {requested}
                              </Trans>
                            </span>
                          ) : null}
                          {next === undefined ? null : (
                            <span className="block text-xs text-muted-foreground">
                              {action.drip === null ? (
                                <Trans>Starts {next}</Trans>
                              ) : (
                                <Trans>Next batch {next}</Trans>
                              )}
                            </span>
                          )}
                          {action.failure === null ? null : (
                            <span className="block text-xs text-muted-foreground">
                              {action.failure.message}
                            </span>
                          )}
                        </td>
                        <td className={`${cellClassName} truncate`}>
                          <ActorName action={action} />
                        </td>
                        <td className={`${cellClassName} whitespace-nowrap`}>
                          {moment.format(new Date(action.createdAt))}
                        </td>
                        <td className={`${cellClassName} whitespace-nowrap`}>
                          {action.finishedAt === null ? (
                            <span className="text-muted-foreground">
                              <Trans>Not yet</Trans>
                            </span>
                          ) : (
                            moment.format(new Date(action.finishedAt))
                          )}
                        </td>
                        <td className={`${cellClassName} text-right`}>
                          <span className="inline-flex flex-wrap justify-end gap-2">
                            <Button
                              variant="secondary"
                              size="small"
                              aria-label={t`Show stats for ${label}`}
                              onClick={(event) => {
                                returnFocusRef.current = event.currentTarget;
                                setNotice('');
                                setOpenedId(action.id);
                              }}
                            >
                              <Trans>Show stats</Trans>
                            </Button>
                            {filename === undefined ? null : (
                              <Button
                                variant="secondary"
                                size="small"
                                aria-label={t`Download ${filename}`}
                                disabled={download.isPending}
                                onClick={() => {
                                  download.mutate(action);
                                }}
                              >
                                <Trans>Download</Trans>
                              </Button>
                            )}
                            {action.canCancel ? (
                              <Button
                                variant="quiet"
                                size="small"
                                aria-label={t`Stop ${label}`}
                                disabled={cancel.isPending}
                                onClick={() => {
                                  cancel.mutate(action);
                                }}
                              >
                                <Trans>Stop</Trans>
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
          {actions.data === undefined ? null : (
            <nav
              aria-label={t`Pages`}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-body"
            >
              <p role="status" aria-busy={busy}>
                <Trans>Page {pageNumber}</Trans>
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={t`Previous page`}
                  disabled={trail.index === 0 || busy}
                  onClick={() => {
                    setTrail(trailBack);
                  }}
                >
                  <Trans>Previous</Trans>
                </Button>
                <Button
                  variant="quiet"
                  size="small"
                  aria-label={t`Next page`}
                  disabled={actions.data.next === null || busy}
                  onClick={() => {
                    setTrail(trailForward(trail, actions.data.next));
                  }}
                >
                  <Trans>Next</Trans>
                </Button>
              </div>
            </nav>
          )}
        </section>
      )}

      <RightPanel
        open={opened !== undefined}
        onClose={() => {
          setOpenedId(undefined);
        }}
        returnFocus={returnFocusRef}
        title={<Trans>Bulk action stats</Trans>}
        description={opened === undefined ? undefined : bulkActionLabel(opened, i18n.locale)}
      >
        {opened === undefined ? null : (
          <BulkStats
            key={opened.id}
            action={opened}
            onClose={() => {
              setOpenedId(undefined);
            }}
          />
        )}
      </RightPanel>
    </Page>
  );
}

function ActorName({ action }: { readonly action: ContactBulkAction }): ReactElement {
  const { t } = useLingui();
  const name = action.actor.name ?? t`Unnamed`;
  return <>{action.actor.you ? t`${name} (you)` : name}</>;
}

function StatusPill({ status }: { readonly status: ContactBulkStatus }): ReactElement {
  const words = useWords();
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        status === 'completed'
          ? 'bg-success-subtle text-success'
          : status === 'cancelled'
            ? 'bg-secondary text-secondary-foreground'
            : status === 'failed'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-accent text-link'
      }`}
    >
      {words.statuses[status]}
    </span>
  );
}

/** The counts of one action, and what became of each contact it named. */
function BulkStats({
  action,
  onClose,
}: {
  readonly action: ContactBulkAction;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const words = useWords();
  const [outcome, setOutcome] = useState<ItemOutcomeFilter>('all');
  // Read again when the action moves on, so the list keeps up with the counts above it.
  const settled = bulkProgress(action).settled;
  const contacts = useInfiniteQuery({
    queryKey: [...bulkKey(business.id), 'items', action.id, outcome, settled],
    queryFn: ({ pageParam }: { pageParam: number | undefined }) =>
      api.request(listContactBulkActionItems, {
        params: { id: action.id },
        query: {
          ...(outcome === 'all' ? {} : { outcome }),
          ...(pageParam === undefined ? {} : { after: pageParam }),
        },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.next ?? undefined,
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const rows = contacts.data?.pages.flatMap((page) => page.items) ?? [];
  const waiting = action.requested - settled;
  const batch = action.drip?.batchSize;
  const every = action.drip?.intervalMinutes;
  const counts: readonly (readonly [string, number])[] = [
    [t`Contacts`, action.requested],
    [words.outcomes.done, action.done],
    [words.outcomes.unchanged, action.unchanged],
    [words.outcomes.skipped, action.skipped],
    ...(waiting > 0 ? ([[words.outcomes.pending, waiting]] as const) : []),
  ];

  return (
    <>
      <div className={sidePanelBodyClassName}>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {counts.map(([term, count]) => (
            <div key={term} className="flex flex-col gap-0.5 rounded-lg border border-border p-3">
              <dt className="text-xs text-muted-foreground">{term}</dt>
              <dd className="text-lg font-medium text-foreground">{count}</dd>
            </div>
          ))}
        </dl>
        {action.status === 'cancelled' ? (
          <p className="text-sm text-muted-foreground">
            <Trans>
              This action was stopped. Contacts it had not reached were left as they were.
            </Trans>
          </p>
        ) : null}
        {batch === undefined || every === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            <Trans>
              Drip mode: {batch} contacts every {every} minutes.
            </Trans>
          </p>
        )}
        {action.failure === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {action.failure.message}
          </p>
        )}
        <label className="flex flex-col items-start gap-1.5 text-sm font-medium">
          <Trans>Show</Trans>
          <Select
            aria-label={t`Show`}
            className="w-auto max-w-full min-w-44"
            value={outcome}
            onValueChange={(next) => {
              setOutcome(itemOutcomeFilters.find((each) => each === next) ?? 'all');
            }}
          >
            {itemOutcomeFilters.map((each) => (
              <option key={each} value={each}>
                {words.outcomes[each]}
              </option>
            ))}
          </Select>
        </label>
        {contacts.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading contacts…</Trans>
          </p>
        ) : null}
        {contacts.isError ? (
          <ListProblem
            onRetry={() => {
              void contacts.refetch();
            }}
          >
            <Trans>The contacts couldn't be loaded.</Trans>
          </ListProblem>
        ) : null}
        {contacts.data !== undefined && rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No contacts match.</Trans>
          </p>
        ) : null}
        {rows.length === 0 ? null : (
          <div
            role="region"
            aria-label={t`Contacts in this action`}
            className={tableRegionClassName}
          >
            <table className={tableClassName}>
              <caption className="sr-only">
                <Trans>Contacts in this action</Trans>
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Contact</Trans>
                  </th>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Result</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.contactId}>
                    <th scope="row" className={`${cellClassName} text-left font-medium`}>
                      <BulkContact item={row} />
                    </th>
                    <td className={`${cellClassName} wrap-anywhere`}>
                      {words.outcomes[row.outcome ?? 'pending']}
                      {row.reason === null ? null : (
                        <span className="block text-xs text-muted-foreground">
                          {row.reason.message}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {contacts.hasNextPage ? (
          <Button
            variant="secondary"
            size="small"
            className="self-start"
            disabled={contacts.isFetchingNextPage}
            onClick={() => {
              void contacts.fetchNextPage();
            }}
          >
            <Trans>Load more</Trans>
          </Button>
        ) : null}
      </div>
      <div className={sidePanelFooterClassName}>
        <Button variant="secondary" onClick={onClose}>
          <Trans>Close</Trans>
        </Button>
      </div>
    </>
  );
}

/** A contact of an action: a link while it can be opened, plain words when it is gone. */
function BulkContact({ item }: { readonly item: ContactBulkItem }): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const gone = item.reason?.code === 'not_found';
  const name = item.name ?? (gone ? t`Contact not found` : t`Unnamed`);
  if (gone) return <span className="text-muted-foreground">{name}</span>;
  return (
    <Link
      to="/b/$slug/contacts/$contactId"
      params={{ slug: business.slug, contactId: item.contactId }}
      className={`${linkClassName} wrap-anywhere`}
    >
      {name}
    </Link>
  );
}
