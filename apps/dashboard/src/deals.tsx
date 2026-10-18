// Opportunities as GoHighLevel lays them out: the pipeline and how many opportunities it
// shows, the board or the list, the saved views as tabs, then the filters as pills with the
// search at the right. An opportunity opens in a dialog over the page, named in the address
// (deal-dialog.tsx).
//
// A card and a row show the opportunity's primary contact, owner and tags, which the list
// is asked for. In the list, someone who may change opportunities can tick rows and run a
// bulk action on them (deal-bulk.tsx). The server searches and orders the list, and the
// table's columns are chosen under "Manage fields" and kept by a saved view. A stage's name
// is drawn in its colour where its pipeline says so. The menu at the top right opens the
// opportunity settings (deal-settings.tsx).
//
// Only what the server has is here: no smart tags, no import and no forecast yet.
import { plural } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  getPipelines,
  type Deal,
  type DealBulkActionKind,
  type EndpointOutput,
  type getDeals,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Select } from '@repo/ui/components/select';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { getRouteApi, Link, useRouter, useRouterState } from '@tanstack/react-router';
import { EllipsisVertical, GripVertical, Plus, SquareKanban } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { apiIn } from './api';
import DealBoard from './deal-board-loader';
import { selectionAmong, toggled } from './deal-bulk-rules';
import type { OpenDeal } from './deal-dialog';
import { DealDialog } from './deal-dialog-loader';
import { contactNameOf, DealTags, StageName, useOwnerName } from './deal-extras';
import {
  dealColumnsOfView,
  dealOrderOf,
  dealOrderState,
  defaultDealColumns,
  firstDealColumns,
  type DealOrderKey,
} from './deal-list-rules';
import { amountOf, stageMarkOf, type StageMark } from './deal-presentation';
import { NEW_DEAL, type DealSection } from './deal-search';
import { DealStatus } from './deal-status';
import { fieldListSearch, withoutFieldSearch } from './field-list-search';
import { ListFilters, useListFields } from './list-filters';
import { dealColumnKeys, type DealColumnKey } from './list-columns';
import { ListSort, type ListOrder } from './list-sort';
import { CountChip, ListSearch } from './list-toolbar';
import { SavedViews } from './saved-views';
import { usePageTitle } from './shell/page';
import { useBusiness } from './workspace';

type DealPage = EndpointOutput<typeof getDeals>;

const dealsRoute = getRouteApi('/_app/b/$slug/deals');

const BulkDialog = lazy(() => import('./deal-bulk'));
const SettingsPanel = lazy(() => import('./deal-settings'));
// The column chooser, fetched as the table first draws: not part of what the page loads first.
const ManageFields = lazy(async () => ({
  default: (await import('./manage-fields')).ManageFields<DealColumnKey>,
}));

/** What each opportunity of the list is asked for beside itself. */
const LIST_EXTRAS = 'contact,owner,tags';
const cellClassName = 'h-[42px] border-t px-3 py-0';
const checkboxClassName = 'size-4 shrink-0 accent-primary';
/** The columns whose words may break anywhere: the others stay on one line. */
const WRAPPING: readonly DealColumnKey[] = ['contact', 'owner', 'source', 'tags'];

/** How long an opportunity read with the list stands in for reading it by itself. */
const LISTED_FRESH = 60_000;

function editable(deal: Deal) {
  return {
    name: deal.name,
    pipelineId: deal.pipelineId,
    stageId: deal.stageId,
    amount: deal.amount,
    currency: deal.currency,
    expectedCloseDate: deal.expectedCloseDate,
    status: deal.status,
    outcomeReason: deal.outcomeReason,
  };
}
/** The pipeline list's last entry: not a pipeline, but the way to create one. */
const NEW_PIPELINE = 'new';

export function DealsPage(): ReactElement {
  const business = useBusiness();
  return <DealsWorkspace key={business.id} businessId={business.id} />;
}
function DealColumn({
  column,
  deal,
  mark,
  when,
}: {
  readonly column: DealColumnKey;
  readonly deal: Deal;
  /** How the pipeline draws the stage's colour. */
  readonly mark: StageMark;
  /** A moment as the list writes it. */
  readonly when: (moment: string) => string;
}): ReactElement {
  const ownerName = useOwnerName();
  if (column === 'name')
    return (
      <th scope="row" className="h-[42px] border-t px-3 py-0 text-left font-medium">
        <dealsRoute.Link
          search={(previous) => ({ ...previous, deal: deal.id })}
          className="text-foreground underline-offset-2 hover:text-link hover:underline"
        >
          {deal.name}
        </dealsRoute.Link>
      </th>
    );
  const content: Readonly<Record<Exclude<DealColumnKey, 'name'>, ReactNode>> = {
    contact: contactNameOf(deal) ?? '—',
    stage: <StageName mark={mark}>{deal.stageName}</StageName>,
    value: amountOf(deal),
    status: <DealStatus status={deal.status} />,
    owner: deal.owner === undefined || deal.owner === null ? '—' : ownerName(deal.owner),
    tags: <DealTags tags={deal.tags} />,
    created: when(deal.createdAt),
    updated: when(deal.updatedAt),
    source: deal.source ?? '—',
    expectedClose: deal.expectedCloseDate ?? '—',
    pipeline: deal.pipelineName,
  };
  return (
    <td
      className={`${cellClassName} ${
        column === 'tags' ? '' : WRAPPING.includes(column) ? 'wrap-anywhere' : 'whitespace-nowrap'
      }`}
    >
      {content[column]}
    </td>
  );
}
function DealsWorkspace({ businessId }: { readonly businessId: string }): ReactElement {
  const business = useBusiness();
  const { t, i18n } = useLingui();
  const client = apiIn(businessId);
  const cache = useQueryClient();
  const router = useRouter();
  const searchState = dealsRoute.useSearch();
  const navigate = dealsRoute.useNavigate();
  usePageTitle(t`Opportunities`);
  // The menus open inside the page's own landmark, as everything on a page is in one.
  const headerRef = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Set by the menu action that opens the settings, which then have the keyboard.
  const openingSettingsRef = useRef(false);
  const pipelineId = searchState.pipelineId;
  const status = searchState.status ?? 'open';
  const view = searchState.layout ?? 'board';
  const fieldFilters = fieldListSearch(searchState);
  const columns = searchState.columns ?? defaultDealColumns;
  const columnLabels: Readonly<Record<DealColumnKey, string>> = {
    name: t`Opportunity name`,
    contact: t`Contact`,
    stage: t`Stage`,
    value: t`Value`,
    status: t`Status`,
    owner: t`Opportunity owner`,
    tags: t`Tags`,
    created: t`Created on`,
    updated: t`Updated on`,
    source: t`Source`,
    expectedClose: t`Expected close`,
    pipeline: t`Pipeline`,
  };
  const dateFormat = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' });
  const when = (moment: string): string => dateFormat.format(new Date(moment));
  // The order the server is asked for: a built-in one, both ways, or a custom field.
  const builtInOrder = {
    ...(searchState.sort === undefined ? {} : { sort: searchState.sort }),
    ...(searchState.direction === undefined ? {} : { direction: searchState.direction }),
  };
  const [generation, setGeneration] = useState(0);
  const [search, setSearch] = useState(searchState.q ?? '');
  const query = searchState.q ?? '';
  const [previousQuery, setPreviousQuery] = useState(query);
  if (query !== previousQuery) {
    setPreviousQuery(query);
    if (query !== search.trim()) setSearch(query);
  }
  useEffect(() => {
    const q = search.trim();
    if (q === (searchState.q ?? '')) return;
    const timer = setTimeout(() => {
      void navigate({
        search: (previous) => {
          const { q: _q, ...rest } = previous;
          return q === '' ? rest : { ...rest, q };
        },
        replace: true,
      });
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [search, searchState.q, navigate]);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [optimistic, setOptimistic] = useState<{
    id: string;
    stageId: string;
    stageName: string;
  }>();
  const pipelines = useQuery({
    queryKey: ['pipelines', businessId],
    queryFn: () => client.request(getPipelines, {}),
  });
  const pipeline =
    pipelineId === undefined
      ? (pipelines.data?.items.find((item) => !item.archived) ?? pipelines.data?.items[0])
      : pipelines.data?.items.find((item) => item.id === pipelineId);
  const unavailablePipeline =
    pipelines.isSuccess && pipelineId !== undefined && pipeline === undefined;
  // The server searches: by the opportunity's name and by a contact it is with.
  const searched = query === '' ? {} : { q: query };
  const key = [
    'deals',
    businessId,
    pipeline?.id,
    status,
    fieldFilters,
    query,
    builtInOrder,
    generation,
  ];
  const deals = useInfiniteQuery({
    queryKey: key,
    enabled: pipeline !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { getDeals } = await import('./deal-page-api');
      return client.request(getDeals, {
        query: {
          pipelineId: pipeline?.id,
          status,
          limit: 200,
          after: pageParam,
          include: LIST_EXTRAS,
          ...searched,
          ...builtInOrder,
          ...fieldFilters,
        },
      });
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const fields = useListFields('deal').data ?? [];
  const unavailableField =
    deals.error instanceof ApiError &&
    deals.error.status === 422 &&
    deals.error.problem.errors?.some((issue) => issue.code === 'unknown_field') === true;
  const items = (deals.data?.pages.flatMap((page) => page.items) ?? []).map((deal) =>
    optimistic?.id === deal.id
      ? { ...deal, stageId: optimistic.stageId, stageName: optimistic.stageName }
      : deal,
  );
  const visible = items;
  const shownCount = visible.length;
  // A pipeline with more opportunities than have loaded: the server counts and totals each
  // stage, with the same search and filters, since the cards here can't. With everything
  // loaded the numbers are worked out from the cards themselves.
  const summaryFilters = {
    ...searched,
    ...(fieldFilters.fieldId === undefined ? {} : { fieldId: fieldFilters.fieldId }),
    ...(fieldFilters.fieldOperator === undefined
      ? {}
      : { fieldOperator: fieldFilters.fieldOperator }),
    ...(fieldFilters.fieldValue === undefined ? {} : { fieldValue: fieldFilters.fieldValue }),
  };
  const summary = useQuery({
    queryKey: ['deal-stage-summary', businessId, pipeline?.id, status, summaryFilters, generation],
    enabled: pipeline !== undefined && deals.hasNextPage,
    retry: 1,
    queryFn: async () => {
      const { getDealStageSummary } = await import('./deal-page-api');
      return client.request(getDealStageSummary, {
        query: { pipelineId: pipeline?.id ?? '', status, ...summaryFilters },
      });
    },
  });
  const counted = deals.hasNextPage ? summary.data : undefined;
  const refreshNumbers = () => {
    void cache.invalidateQueries({ queryKey: ['deals', businessId] });
    void cache.invalidateQueries({ queryKey: ['deal-stage-summary', businessId] });
  };
  const canManage = deals.data?.pages[0]?.canManage ?? false;
  // The rows ticked for a bulk action: only ones still shown that the reader may change.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulk, setBulk] = useState<DealBulkActionKind>();
  const bulkFocusRef = useRef<HTMLElement | null>(null);
  const selectable = visible.filter((deal) => deal.canManage);
  const chosen = selectionAmong(selected, visible);
  const bulkActions: readonly (readonly [DealBulkActionKind, string])[] = [
    ['assign_owner', t`Change owner`],
    ['move', t`Change pipeline and stage`],
    ['set_status', t`Change status`],
    ['trash', t`Delete`],
  ];
  const canAdd =
    canManage &&
    pipeline !== undefined &&
    !pipeline.archived &&
    pipeline.stages.some((stage) => !stage.archived);

  // The opportunity the address names is open in the dialog: a card or a row that was
  // followed, "new", or one the command bar went to. One just read with the list opens at
  // once; any other is read by itself, and until it has been, nothing opens.
  const dealParam = searchState.deal;
  const linkedId = dealParam === undefined || dealParam === NEW_DEAL ? undefined : dealParam;
  const linked = useQuery({
    queryKey: ['deal', businessId, linkedId],
    enabled: linkedId !== undefined,
    queryFn: async () => {
      const { getDeal } = await import('./deal-page-api');
      return client.request(getDeal, { params: { id: linkedId ?? '' } });
    },
    retry: false,
    staleTime: LISTED_FRESH,
    initialData: () => items.find((deal) => deal.id === linkedId),
    initialDataUpdatedAt: deals.dataUpdatedAt,
  });
  const linkedPipeline = pipelines.data?.items.find((item) => item.id === linked.data?.pipelineId);
  const opened: OpenDeal | undefined =
    dealParam === NEW_DEAL
      ? canAdd
        ? { key: NEW_DEAL, deal: undefined, pipeline, pipelines: pipelines.data?.items ?? [] }
        : undefined
      : linked.data !== undefined && linkedPipeline !== undefined
        ? {
            key: linked.data.id,
            deal: linked.data,
            pipeline: linkedPipeline,
            pipelines: pipelines.data?.items ?? [],
          }
        : undefined;
  const linkLoading = linkedId !== undefined && linked.isPending;
  const shownError =
    error ??
    (linkedId !== undefined && linked.data === undefined && linked.isError
      ? t`That opportunity can't be opened. It may have been deleted.`
      : undefined);
  // Closing goes back to the page as it was before the dialog opened over it, when this
  // opportunity was opened straight from that page and it is the entry before this one. An
  // address opened by itself, or reached from another opportunity, just loses the opportunity.
  const historyIndex = useRouterState({ select: (state) => state.location.state.__TSR_index });
  const listIndexRef = useRef<number>(undefined);
  const openedFromListRef = useRef<string>(undefined);
  const previousDealRef = useRef(dealParam);
  useEffect(() => {
    if (dealParam === undefined) listIndexRef.current = historyIndex;
    if (dealParam !== previousDealRef.current)
      openedFromListRef.current = previousDealRef.current === undefined ? dealParam : undefined;
    previousDealRef.current = dealParam;
  }, [dealParam, historyIndex]);
  const closeDialog = (ignoreBlocker = false) => {
    if (
      dealParam !== undefined &&
      openedFromListRef.current === dealParam &&
      listIndexRef.current === historyIndex - 1
    )
      router.history.back({ ignoreBlocker });
    else
      void navigate({
        search: ({ deal: _deal, section: _section, ...rest }) => rest,
        replace: true,
        ignoreBlocker,
      });
  };
  const move = useMutation({
    mutationFn: async ({ deal, stageId }: { deal: Deal; stageId: string; stageName: string }) => {
      const { updateDeal } = await import('./deal-page-api');
      return client.request(updateDeal, {
        params: { id: deal.id },
        body: { ...editable(deal), stageId, revision: deal.revision },
      });
    },
    onMutate: async ({ deal, stageId, stageName }) => {
      await cache.cancelQueries({ queryKey: key });
      setError(undefined);
      setMessage(undefined);
      setOptimistic({ id: deal.id, stageId, stageName });
    },
    onSuccess: (saved) => {
      cache.setQueryData(['deal', businessId, saved.id], saved);
      cache.setQueriesData<InfiniteData<DealPage>>(
        { queryKey: ['deals', businessId] },
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) => (item.id === saved.id ? saved : item)),
                })),
              },
      );
      const { name, stageName } = saved;
      setMessage(t`${name} moved to ${stageName}.`);
    },
    onError: (failure) => {
      setError(
        failure instanceof ApiError
          ? failure.message
          : t`We couldn't move the opportunity. Try again.`,
      );
    },
    onSettled: () => {
      setOptimistic(undefined);
      refreshNumbers();
    },
  });
  const order: ListOrder<DealOrderKey> =
    fieldFilters.sortField === undefined
      ? { by: dealOrderOf(builtInOrder) }
      : { field: fieldFilters.sortField, direction: fieldFilters.fieldOrder ?? 'asc' };
  return (
    <>
      <header ref={headerRef} className="flex min-w-0 flex-col gap-3">
        <h1 className="sr-only">
          <Trans>Opportunities</Trans>
        </h1>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <Select
              aria-label={t`Pipeline`}
              className="w-auto max-w-full min-w-52 font-medium"
              value={pipelineId ?? pipeline?.id ?? ''}
              disabled={move.isPending}
              onValueChange={(selectedPipeline) => {
                // The last entry is not a pipeline: it opens the dialog that creates one,
                // on the Pipelines tab, as GoHighLevel's list does.
                if (selectedPipeline === NEW_PIPELINE) {
                  void navigate({
                    to: '/b/$slug/deals/pipelines',
                    params: { slug: business.slug },
                    search: { mode: 'create' },
                  });
                  return;
                }
                void navigate({
                  search: (previous) => ({ ...previous, pipelineId: selectedPipeline }),
                  replace: true,
                });
              }}
            >
              {unavailablePipeline ? (
                <option value={pipelineId}>{t`Unavailable pipeline`}</option>
              ) : null}
              {pipelines.data?.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.archived ? t` (archived)` : ''}
                </option>
              ))}
              {pipelines.data?.canManage === true ? (
                <option value={NEW_PIPELINE}>{t`+ New pipeline`}</option>
              ) : null}
            </Select>
            {deals.data === undefined || pipeline === undefined ? null : (
              <CountChip>
                {counted !== undefined ? (
                  <Plural value={counted.count} one="# opportunity" other="# opportunities" />
                ) : deals.hasNextPage ? (
                  <Trans>{shownCount}+ opportunities</Trans>
                ) : (
                  <Plural value={shownCount} one="# opportunity" other="# opportunities" />
                )}
              </CountChip>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label={t`Opportunity view`}
              className="flex overflow-hidden rounded-lg border border-input"
            >
              {(
                [
                  ['board', t`Board`],
                  ['table', t`List`],
                ] as const
              ).map(([layout, label]) => (
                <button
                  key={layout}
                  type="button"
                  aria-pressed={view === layout}
                  className="min-h-11 bg-card px-3 text-sm font-medium text-body -outline-offset-2 hover:bg-muted aria-pressed:bg-accent aria-pressed:text-link lg:min-h-9"
                  onClick={() => {
                    void navigate({
                      search: ({ layout: _layout, ...rest }) =>
                        layout === 'board' ? rest : { ...rest, layout },
                      replace: true,
                    });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {canAdd ? (
              <Button
                ref={addRef}
                disabled={move.isPending || linkLoading}
                onClick={() => {
                  void navigate({
                    search: ({ section: _section, ...rest }) => ({ ...rest, deal: NEW_DEAL }),
                  });
                }}
              >
                <Plus aria-hidden size={18} />
                <Trans>Add opportunity</Trans>
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                ref={menuRef}
                aria-label={t`Opportunity actions`}
                className="flex size-11 shrink-0 items-center justify-center rounded-control text-body -outline-offset-2 hover:bg-muted hover:text-foreground data-popup-open:bg-muted lg:size-9"
              >
                <EllipsisVertical aria-hidden className="size-5" strokeWidth={1.8} />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                // Opening the settings puts the keyboard there.
                finalFocus={() => {
                  const opening = openingSettingsRef.current;
                  openingSettingsRef.current = false;
                  return !opening;
                }}
                container={headerRef}
                className="min-w-56"
              >
                <DropdownMenuItem
                  className="min-h-11 lg:min-h-9"
                  onClick={() => {
                    openingSettingsRef.current = true;
                    setSettingsOpen(true);
                  }}
                >
                  <Trans>Opportunity settings</Trans>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <SavedViews
          current={{
            objectKey: 'deal',
            state: {
              ...fieldFilters,
              ...(pipelineId === undefined ? {} : { pipelineId }),
              ...(searchState.status === undefined ? {} : { status: searchState.status }),
              ...(searchState.layout === undefined ? {} : { layout: searchState.layout }),
              ...(search.trim() === '' ? {} : { q: search.trim() }),
              ...builtInOrder,
            },
            // The five columns the first table had, for anything that still reads only those.
            columns: firstDealColumns(columns),
            tableColumns: [...columns],
          }}
          selectedId={searchState.view}
          container={headerRef}
          onApply={(configuration, selectedView) => {
            if (configuration !== undefined && configuration.objectKey !== 'deal') return;
            setGeneration((previous) => previous + 1);
            const nextQuery = configuration?.state.q ?? '';
            setSearch((previous) => (previous.trim() === nextQuery ? previous : nextQuery));
            void navigate({
              search:
                configuration === undefined
                  ? {}
                  : {
                      ...configuration.state,
                      columns: dealColumnsOfView(configuration),
                      ...(selectedView === undefined ? {} : { view: selectedView }),
                    },
            });
          }}
        />
      </header>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t`Status filter`}
            className="w-auto rounded-full font-medium text-body"
            value={status}
            disabled={move.isPending}
            onValueChange={(nextStatus) => {
              if (
                nextStatus === 'open' ||
                nextStatus === 'won' ||
                nextStatus === 'lost' ||
                nextStatus === 'all'
              )
                void navigate({
                  search: ({ status: _status, ...rest }) =>
                    nextStatus === 'open' ? rest : { ...rest, status: nextStatus },
                  replace: true,
                });
            }}
          >
            <option value="open">{t`Status: Open`}</option>
            <option value="won">{t`Status: Won`}</option>
            <option value="lost">{t`Status: Lost`}</option>
            <option value="all">{t`All statuses`}</option>
          </Select>
          <ListFilters
            fields={fields}
            period={false}
            count={fieldFilters.fieldId === undefined ? 0 : 1}
            value={{
              ...(fieldFilters.fieldId === undefined ? {} : { fieldId: fieldFilters.fieldId }),
              ...(fieldFilters.fieldOperator === undefined
                ? {}
                : { fieldOperator: fieldFilters.fieldOperator }),
              ...(fieldFilters.fieldValue === undefined
                ? {}
                : { fieldValue: fieldFilters.fieldValue }),
            }}
            onApply={({ added: _added, ...value }) => {
              void navigate({
                search: ({
                  fieldId: _id,
                  fieldOperator: _operator,
                  fieldValue: _value,
                  ...rest
                }) => ({ ...rest, ...value }),
                replace: true,
              });
            }}
          />
          <ListSort
            orders={[
              { key: 'created', label: t`Created, newest first` },
              { key: 'created:asc', label: t`Created, oldest first` },
              { key: 'updated', label: t`Updated, newest first` },
              { key: 'updated:asc', label: t`Updated, oldest first` },
              { key: 'name', label: t`Name, A to Z` },
              { key: 'name:desc', label: t`Name, Z to A` },
              { key: 'value', label: t`Value, highest first` },
              { key: 'value:asc', label: t`Value, lowest first` },
            ]}
            fields={fields}
            value={order}
            onChange={(next) => {
              void navigate({
                // One order applies: a built-in one, or a field.
                search: ({
                  sortField: _field,
                  fieldOrder: _order,
                  sort: _sort,
                  direction: _direction,
                  ...rest
                }) =>
                  'field' in next
                    ? { ...rest, sortField: next.field, fieldOrder: next.direction }
                    : { ...rest, ...dealOrderState(next.by) },
                replace: true,
              });
            }}
          />
        </div>
        <div className="flex min-w-0 flex-1 basis-72 flex-wrap items-center justify-end gap-2">
          {view === 'table' ? (
            <Suspense fallback={null}>
              <ManageFields
                choices={dealColumnKeys.map((column) => ({
                  key: column,
                  label: columnLabels[column],
                }))}
                value={columns}
                onApply={(value) => {
                  void navigate({
                    search: (previous) => ({ ...previous, columns: value }),
                    replace: true,
                  });
                }}
              />
            </Suspense>
          ) : null}
          <ListSearch label={t`Search opportunities`} value={search} onChange={setSearch} />
        </div>
      </div>
      {unavailablePipeline ? (
        <p role="alert">
          <Trans>That pipeline is no longer available. Choose another pipeline.</Trans>
        </p>
      ) : null}
      {shownError === undefined ? null : (
        <p role="alert" className="text-destructive">
          {shownError}
        </p>
      )}
      <p role="status" className="text-sm text-body empty:hidden">
        {move.isPending ? t`Saving stage…` : message}
      </p>
      {pipelines.isError || deals.isError ? (
        <p role="alert">
          <Trans>We couldn't load the opportunities.</Trans>{' '}
          <Button
            variant="quiet"
            onClick={() => {
              void pipelines.refetch();
              void deals.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
          {unavailableField ? (
            <Button
              variant="quiet"
              onClick={() => {
                void navigate({
                  search: (previous) => withoutFieldSearch(previous),
                  replace: true,
                });
              }}
            >
              <Trans>Clear field filter and order</Trans>
            </Button>
          ) : null}
        </p>
      ) : null}
      {pipelines.isPending || (pipeline !== undefined && deals.isPending) ? (
        <p role="status">
          <Trans>Loading opportunities…</Trans>
        </p>
      ) : null}
      {pipelines.data?.items.length === 0 ? (
        // GoHighLevel creates pipelines from Opportunities, not from Settings: the way on is
        // the Pipelines tab's own dialog, opened from here.
        <div className="flex flex-col items-center gap-2 rounded-card border bg-card px-6 py-12 text-center">
          <SquareKanban aria-hidden size={32} className="text-muted-foreground" />
          <h2 className="mt-1 text-lg font-medium">
            <Trans>No pipeline yet</Trans>
          </h2>
          {pipelines.data.canManage ? (
            <>
              <p className="max-w-md text-md text-muted-foreground">
                <Trans>
                  A pipeline is the set of stages an opportunity moves through. Create one to start
                  tracking opportunities.
                </Trans>
              </p>
              <Link
                to="/b/$slug/deals/pipelines"
                params={{ slug: business.slug }}
                search={{ mode: 'create' }}
                className="mt-2 inline-flex min-h-11 items-center justify-center rounded-control bg-primary px-3.5 text-md font-medium text-primary-foreground hover:bg-primary-hover lg:min-h-9"
              >
                <Trans>Create pipeline</Trans>
              </Link>
            </>
          ) : (
            <p className="max-w-md text-md text-muted-foreground">
              <Trans>
                Opportunities are tracked in a pipeline, and this business has none yet. Ask someone
                who manages pipelines to create one.
              </Trans>
            </p>
          )}
        </div>
      ) : null}
      {deals.data === undefined || pipeline === undefined ? null : (
        <>
          {deals.hasNextPage ? (
            <p className="text-sm text-body">
              {counted !== undefined ? (
                <Trans>
                  More opportunities are available below. The counts and totals are for all of them.
                </Trans>
              ) : (
                <Trans>
                  More opportunities are available below. The counts and the totals cover the ones
                  loaded so far.
                </Trans>
              )}
            </p>
          ) : null}
          {view === 'board' ? (
            <>
              {canManage ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <GripVertical aria-hidden className="size-3.5 shrink-0" />
                  <Trans>
                    Drag a card by its grip to change stage. By keyboard: focus the grip, press
                    Space, Left or Right, then Space.
                  </Trans>
                </p>
              ) : null}
              <DealBoard
                pipeline={pipeline}
                deals={items}
                visible={visible}
                canManage={canManage}
                pending={move.isPending}
                counted={counted?.stages}
                onMove={(change) => {
                  move.mutate(change);
                }}
                onTable={() => {
                  void navigate({
                    search: (previous) => ({ ...previous, layout: 'table' }),
                    replace: true,
                  });
                }}
              />
            </>
          ) : (
            <>
              {chosen.length === 0 ? null : (
                <div
                  role="group"
                  aria-label={t`Bulk actions`}
                  className="flex flex-wrap items-center gap-2 rounded-card border bg-card px-3 py-2"
                >
                  <span className="text-sm font-medium text-foreground">
                    <Plural value={chosen.length} one="# selected" other="# selected" />
                  </span>
                  {bulkActions.map(([action, label]) => (
                    <Button
                      key={action}
                      variant="secondary"
                      size="small"
                      className={
                        action === 'trash' ? 'border-destructive text-destructive' : undefined
                      }
                      onClick={(event) => {
                        bulkFocusRef.current = event.currentTarget;
                        setError(undefined);
                        setMessage(undefined);
                        setBulk(action);
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                  <Button
                    variant="quiet"
                    size="small"
                    onClick={() => {
                      setSelected(new Set());
                    }}
                  >
                    <Trans>Clear selection</Trans>
                  </Button>
                </div>
              )}
              <div
                className="max-w-full overflow-x-auto rounded-card border bg-card"
                role="region"
                aria-label={t`Opportunities list`}
              >
                <table
                  className="w-full border-separate border-spacing-0 text-left text-sm text-body"
                  // Room for each column chosen, so a narrow window scrolls the table sideways.
                  style={{ minWidth: (canManage ? 40 : 0) + columns.length * 118 }}
                >
                  <caption className="sr-only">
                    <Trans>Loaded opportunities in this pipeline</Trans>
                  </caption>
                  <thead>
                    <tr>
                      {canManage ? (
                        <td className="h-10 w-10 bg-muted px-3 py-0">
                          <input
                            type="checkbox"
                            className={checkboxClassName}
                            aria-label={t`Select all loaded opportunities`}
                            disabled={selectable.length === 0}
                            checked={selectable.length > 0 && chosen.length === selectable.length}
                            onChange={(event) => {
                              setSelected(
                                event.target.checked
                                  ? new Set(selectable.map((deal) => deal.id))
                                  : new Set(),
                              );
                            }}
                          />
                        </td>
                      ) : null}
                      {columns.map((column) => (
                        <th
                          key={column}
                          scope="col"
                          className="h-10 bg-muted px-3 py-0 text-xs font-medium whitespace-nowrap"
                        >
                          {columnLabels[column]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((deal) => {
                      const name = deal.name;
                      return (
                        <tr key={deal.id} className="hover:bg-muted">
                          {canManage ? (
                            <td className="h-[42px] w-10 border-t px-3 py-0">
                              {deal.canManage ? (
                                <input
                                  type="checkbox"
                                  className={checkboxClassName}
                                  aria-label={t`Select ${name}`}
                                  checked={selected.has(deal.id)}
                                  onChange={(event) => {
                                    setSelected(toggled(selected, deal.id, event.target.checked));
                                  }}
                                />
                              ) : null}
                            </td>
                          ) : null}
                          {columns.map((column) => (
                            <DealColumn
                              key={column}
                              column={column}
                              deal={deal}
                              mark={stageMarkOf(pipeline, deal.stageId)}
                              when={when}
                            />
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {visible.length === 0 ? (
            <p className="rounded-card border border-dashed p-6 text-body">
              <Trans>No opportunities match these filters.</Trans>
            </p>
          ) : null}
          {deals.hasNextPage ? (
            <Button
              variant="secondary"
              className="self-start"
              disabled={deals.isFetchingNextPage || move.isPending}
              onClick={() => {
                void deals.fetchNextPage();
              }}
            >
              {deals.isFetchingNextPage ? t`Loading more…` : t`Load more opportunities`}
            </Button>
          ) : null}
        </>
      )}
      {bulk === undefined || chosen.length === 0 ? null : (
        <Suspense fallback={null}>
          <BulkDialog
            businessId={businessId}
            action={bulk}
            ids={chosen}
            pipelines={pipelines.data?.items ?? []}
            pipelineId={pipeline?.id}
            returnFocus={bulkFocusRef}
            onClose={() => {
              setBulk(undefined);
            }}
            onDone={(tally, action, finished) => {
              setBulk(undefined);
              setSelected(new Set());
              const changed =
                action === 'trash'
                  ? plural(tally.done, {
                      one: '# opportunity moved to the trash.',
                      other: '# opportunities moved to the trash.',
                    })
                  : plural(tally.done, {
                      one: '# opportunity changed.',
                      other: '# opportunities changed.',
                    });
              const unchanged =
                tally.unchanged === 0
                  ? ''
                  : plural(tally.unchanged, {
                      one: '# was already as asked.',
                      other: '# were already as asked.',
                    });
              const skipped =
                tally.skipped === 0
                  ? ''
                  : plural(tally.skipped, {
                      one: '# was skipped: not found, or in the trash.',
                      other: '# were skipped: not found, or in the trash.',
                    });
              setMessage([changed, unchanged, skipped].filter((each) => each !== '').join(' '));
              setError(
                finished
                  ? undefined
                  : t`A request failed before every selected opportunity was handled. Select the rest and run the action again.`,
              );
              void cache.invalidateQueries({ queryKey: ['deal', businessId] });
              void cache.invalidateQueries({ queryKey: ['b', businessId, 'deal-details'] });
              refreshNumbers();
            }}
          />
        </Suspense>
      )}
      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsPanel
            businessId={businessId}
            returnFocus={menuRef}
            onClose={() => {
              setSettingsOpen(false);
            }}
            onSaved={() => {
              setSettingsOpen(false);
              setError(undefined);
              setMessage(t`Opportunity settings saved.`);
            }}
          />
        </Suspense>
      ) : null}
      <DealDialog
        opened={opened}
        businessId={businessId}
        section={searchState.section ?? 'details'}
        onSection={(section: DealSection) => {
          void navigate({
            search: ({ section: _section, ...rest }) =>
              section === 'details' ? rest : { ...rest, section },
            replace: true,
          });
        }}
        onClose={() => {
          closeDialog();
        }}
        fallbackFocus={() => addRef.current}
        onSaved={(saved) => {
          // So the address naming it opens what was saved, with its new revision.
          cache.setQueryData(['deal', businessId, saved.id], saved);
          const { name } = saved;
          setError(undefined);
          setMessage(t`${name} saved.`);
          closeDialog(true);
          refreshNumbers();
        }}
        onTrashed={(trashed) => {
          cache.setQueryData(['deal', businessId, trashed.id], trashed);
          // Off the board at once, so the keyboard isn't given back to a card about to go.
          cache.setQueriesData<InfiniteData<DealPage>>(
            { queryKey: ['deals', businessId] },
            (current) =>
              current === undefined
                ? current
                : {
                    ...current,
                    pages: current.pages.map((page) => ({
                      ...page,
                      items: page.items.filter((item) => item.id !== trashed.id),
                    })),
                  },
          );
          const { name } = trashed;
          setError(undefined);
          setMessage(t`${name} moved to the trash.`);
          closeDialog(true);
          refreshNumbers();
        }}
      />
    </>
  );
}
