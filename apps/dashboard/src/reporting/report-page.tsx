// A saved report: its pages of widgets on a 12-column grid, a date range and a comparison
// for the whole report, and each widget running its own query. Someone who may manage
// reports can turn on the builder here: add, rename and remove pages; add a widget and set
// what it shows; move, resize, duplicate and delete widgets with buttons or by dragging;
// then save under the revision that was read. A save refused because the report changed
// elsewhere offers the saved version, a copy, or to keep editing. Leaving with unsaved
// changes asks first.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  cloneReport,
  createReport,
  getReport,
  reportCompareModes,
  updateReport,
  type Report,
  type ReportCatalog,
  type ReportCompareMode,
  type ReportResolvedRange,
  type ReportWidget,
  type ReportWidgetKind,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useBlocker, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useId,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { apiIn } from '../api';
import { ListProblem } from '../list-table';
import { Page } from '../shell/page';
import { useBusiness } from '../workspace';
import {
  builderReducer,
  canAddPage,
  canAddWidget,
  freeWidgetId,
  isDirty,
  startOf,
  type BuilderAction,
  type BuilderState,
} from './builder-state';
import { isForbidden, reportingKeys } from './keys';
import { Loading, NoAccess, ResolvedRange, useCatalog } from './parts';
import {
  allowedSources,
  choiceOfRange,
  defaultQuery,
  definitionIssues,
  noIssues,
  placeIssues,
  rangeOfSearch,
  withoutKeys,
  type PlacedIssues,
  type RangeState,
} from './query-rules';
import { RangeControl } from './range-control';
import type { ReportDates } from './widget';
import { LazyWidgetBody } from './widget-lazy';
import { useReportWords } from './words';

const route = getRouteApi('/_app/b/$slug/reports/$reportId');

// The builder's settings panel is fetched when a widget is first opened: a reader of
// reports never downloads it.
const WidgetEditor = lazy(() => import('./widget-editor'));
// The builder's menus and dialogs come with the first press of "Edit report".
const builder = (): Promise<typeof import('./report-builder')> => import('./report-builder');
const WidgetTools = lazy(async () => ({ default: (await builder()).WidgetTools }));
const AddWidget = lazy(async () => ({ default: (await builder()).AddWidget }));
const AskDialog = lazy(async () => ({ default: (await builder()).AskDialog }));

const savedOf = (report: Report): BuilderState['saved'] => ({
  name: report.name,
  definition: report.definition,
  revision: report.revision,
});

export function ReportPage(): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const { reportId } = route.useParams();
  const report = useQuery({
    queryKey: reportingKeys.report(business.id, reportId),
    queryFn: () => apiIn(business.id).request(getReport, { params: { id: reportId } }),
    retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
  });
  const catalog = useCatalog(business.id);
  const back = (
    <Link
      to="/b/$slug/reports"
      params={{ slug: business.slug }}
      className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm text-link hover:underline lg:min-h-8"
    >
      <ArrowLeft aria-hidden className="size-4" strokeWidth={2} />
      <Trans>Custom reports</Trans>
    </Link>
  );
  if (isForbidden(report.error) || isForbidden(catalog.error))
    return (
      <Page title={t`Report`}>
        <NoAccess />
      </Page>
    );
  if (report.error instanceof ApiError && report.error.status < 500)
    return (
      <Page title={t`Report`}>
        {back}
        <p role="alert" className="text-md">
          <Trans>This report isn't here. It may have been deleted.</Trans>
        </p>
      </Page>
    );
  if (report.data === undefined)
    return (
      <Page title={t`Report`}>
        {back}
        {report.isError ? (
          <ListProblem
            onRetry={() => {
              void report.refetch();
            }}
          >
            <Trans>The report couldn't be loaded.</Trans>
          </ListProblem>
        ) : (
          <Loading />
        )}
      </Page>
    );
  return (
    <LoadedReport
      key={`${business.id}:${reportId}`}
      report={report.data}
      catalog={catalog.data}
      reload={async () => (await report.refetch()).data}
    />
  );
}

/** The size a new widget of each kind starts at, in columns and rows of the grid. */
const startSize: Readonly<Record<ReportWidgetKind, { w: number; h: number }>> = {
  stat: { w: 3, h: 2 },
  text: { w: 12, h: 1 },
  line: { w: 6, h: 4 },
  area: { w: 6, h: 4 },
  bar: { w: 6, h: 4 },
  hbar: { w: 6, h: 4 },
  donut: { w: 6, h: 4 },
  funnel: { w: 6, h: 4 },
  table: { w: 12, h: 5 },
};
const NO_COMPARE = 'none';
const isCompare = (value: string): value is ReportCompareMode =>
  (reportCompareModes as readonly string[]).includes(value);

/**
 * A report's dates: the range (a preset, or two days typed here and kept only once they
 * make a range) and what it is compared with.
 */
function DatesControl({
  dates,
  presets,
  resolved,
  onChange,
}: {
  readonly dates: ReportDates;
  readonly presets: readonly string[] | undefined;
  readonly resolved: Pick<ReportResolvedRange, 'from' | 'to'> | undefined;
  readonly onChange: (dates: ReportDates) => void;
}): ReactElement {
  const { t } = useLingui();
  // The two days of a custom range while they are typed: they may not be a range yet.
  const [typed, setTyped] = useState<{ from: string; to: string }>();
  const kept: RangeState = { ok: true, input: dates.range, choice: choiceOfRange(dates.range) };
  const state: RangeState =
    typed === undefined ? kept : rangeOfSearch({ range: 'custom', ...daysOf(typed) });
  const days = typed ?? ('preset' in dates.range ? { from: '', to: '' } : dates.range);
  const type = (from: string, to: string): void => {
    const next = rangeOfSearch({ range: 'custom', ...daysOf({ from, to }) });
    if (next.ok) {
      setTyped(undefined);
      onChange({ ...dates, range: next.input });
    } else setTyped({ from, to });
  };
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <RangeControl
        label={t`Report date range`}
        presets={presets}
        state={state}
        days={days}
        onChoice={(choice) => {
          if (choice === 'custom') type(resolved?.from ?? '', resolved?.to ?? '');
          else {
            setTyped(undefined);
            onChange({ ...dates, range: { preset: choice } });
          }
        }}
        onDays={type}
      />
      <div className="w-full sm:w-52">
        <Select
          aria-label={t`Compare with`}
          value={dates.compare ?? NO_COMPARE}
          onValueChange={(value) => {
            onChange({ ...dates, compare: isCompare(value) ? value : null });
          }}
        >
          <option value={NO_COMPARE}>{t`No comparison`}</option>
          <option value="previous_period">{t`Compare: period before`}</option>
          <option value="previous_year">{t`Compare: year before`}</option>
        </Select>
      </div>
    </div>
  );
}

/** Two typed days as an address holds them: an empty one is left out. */
function daysOf(days: { readonly from: string; readonly to: string }): {
  from?: string;
  to?: string;
} {
  return {
    ...(days.from === '' ? {} : { from: days.from }),
    ...(days.to === '' ? {} : { to: days.to }),
  };
}

function LoadedReport({
  report,
  catalog,
  reload,
}: {
  readonly report: Report;
  readonly catalog: ReportCatalog | undefined;
  readonly reload: () => Promise<Report | undefined>;
}): ReactElement {
  const { t } = useLingui();
  const words = useReportWords();
  const business = useBusiness();
  const api = apiIn(business.id);
  const cache = useQueryClient();
  const search = route.useSearch();
  const navigateHere = route.useNavigate();
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(builderReducer, undefined, () =>
    startOf(savedOf(report), (search.page ?? 1) - 1),
  );
  const editing = search.edit === true && report.canManage;
  const [viewDates, setViewDates] = useState<ReportDates>();
  const [resolved, setResolved] = useState<{
    readonly range: ReportResolvedRange;
    readonly timeZone: string;
  }>();
  const [issues, setIssues] = useState<PlacedIssues>(noIssues);
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState('');
  const [asking, setAsking] = useState<'discard' | 'done' | 'remove-page'>();
  const [dragging, setDragging] = useState<string>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const nameId = useId();
  const pageNameId = useId();
  const dirty = isDirty(state);

  const definition = state.definition;
  const page = definition.pages[state.page];
  const own: ReportDates = { range: definition.range, compare: definition.compare };
  const dates = editing ? own : (viewDates ?? own);

  const act = (action: BuilderAction): void => {
    setIssues(noIssues);
    setNotice('');
    dispatch(action);
  };
  const showPage = (index: number): void => {
    dispatch({ type: 'show-page', page: index });
    void navigateHere({
      search: index === 0 ? withoutKeys(search, 'page') : { ...search, page: index + 1 },
      replace: true,
    });
  };
  const setEditing = (on: boolean): void => {
    setViewDates(undefined);
    void navigateHere({
      search: on ? { ...search, edit: true } : withoutKeys(search, 'edit'),
      replace: true,
    });
  };
  const onResolved = useCallback((range: ReportResolvedRange, timeZone: string) => {
    setResolved((current) =>
      current?.range.from === range.from &&
      current.range.to === range.to &&
      current.timeZone === timeZone
        ? current
        : { range, timeZone },
    );
  }, []);

  // Set as the page leaves for a copy that holds every change: there is nothing to ask about.
  const savedElsewhereRef = useRef(false);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      !savedElsewhereRef.current && editing && dirty && next.pathname !== current.pathname,
    enableBeforeUnload: () => editing && dirty,
    withResolver: true,
  });

  const adopt = (saved: Report): void => {
    cache.setQueryData(reportingKeys.report(business.id, saved.id), saved);
    void cache.invalidateQueries({ queryKey: reportingKeys.reports(business.id) });
  };
  const save = useMutation({
    mutationFn: () =>
      api.request(updateReport, {
        params: { id: report.id },
        body: { name: state.name.trim(), definition, revision: state.saved.revision },
      }),
    onSuccess: (saved) => {
      adopt(saved);
      dispatch({ type: 'saved', saved: savedOf(saved) });
      setStale(false);
      setIssues(noIssues);
      setNotice(t`Report saved.`);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setStale(true);
        return;
      }
      const errors = error instanceof ApiError ? (error.problem.errors ?? []) : [];
      if (errors.length > 0) setIssues(placeIssues(definition, errors));
      else
        setIssues({
          ...noIssues,
          form: [
            error instanceof ApiError && error.status === 403
              ? t`You need permission to manage reports.`
              : error instanceof ApiError && error.problem.detail !== undefined
                ? error.problem.detail
                : t`The report couldn't be saved. Try again.`,
          ],
        });
    },
  });
  const trySave = (): void => {
    const found = definitionIssues(state.name, definition);
    if (found.length > 0) {
      setIssues(placeIssues(definition, found));
      setNotice('');
      return;
    }
    save.mutate();
  };
  const copyName = state.name.trim() === '' ? t`Untitled report` : state.name.trim();
  const saveCopy = useMutation({
    mutationFn: () =>
      api.request(createReport, {
        body: { name: t`Copy of ${copyName}`.slice(0, 120), definition },
      }),
    onSuccess: (copy) => {
      adopt(copy);
      // What was being changed is now the copy's: nothing here is unsaved any more.
      savedElsewhereRef.current = true;
      dispatch({ type: 'discard' });
      setStale(false);
      void navigate({
        to: '/b/$slug/reports/$reportId',
        params: { slug: business.slug, reportId: copy.id },
        search: { edit: true },
      });
    },
  });
  const clone = useMutation({
    mutationFn: () => api.request(cloneReport, { params: { id: report.id }, body: {} }),
    onSuccess: (copy) => {
      adopt(copy);
      void navigate({
        to: '/b/$slug/reports/$reportId',
        params: { slug: business.slug, reportId: copy.id },
      });
    },
    onError: () => {
      setNotice(t`The report couldn't be cloned.`);
    },
  });
  const reloadSaved = useMutation({
    mutationFn: reload,
    onSuccess: (fresh) => {
      if (fresh === undefined) return;
      dispatch({ type: 'loaded', saved: savedOf(fresh) });
      setStale(false);
      setIssues(noIssues);
      setNotice(t`Showing the saved version.`);
    },
  });

  const addWidget = (kind: ReportWidgetKind): void => {
    const size = startSize[kind];
    const id = freeWidgetId(definition, kind);
    if (kind === 'text') {
      act({
        type: 'add-widget',
        widget: { id, kind, title: t`Text`, text: t`Write a note here.`, ...size },
      });
      return;
    }
    const source = catalog === undefined ? undefined : allowedSources(catalog)[0];
    if (catalog === undefined || source === undefined) return;
    act({
      type: 'add-widget',
      widget: {
        id,
        kind,
        title: source.label,
        query: defaultQuery(kind, source, catalog.limits),
        ...size,
      },
    });
  };
  const titleOf = (widget: ReportWidget): string =>
    widget.title === '' ? words.kind(widget.kind) : widget.title;
  const move = (widget: ReportWidget, by: -1 | 1): void => {
    const widgets = page?.widgets ?? [];
    const place = widgets.findIndex((each) => each.id === widget.id) + by + 1;
    if (place < 1 || place > widgets.length) return;
    act({ type: 'move-widget', id: widget.id, by });
    const name = titleOf(widget);
    const count = widgets.length;
    setNotice(t`Moved ${name} to place ${place} of ${count}.`);
  };
  const resize = (widget: ReportWidget, change: { w?: number; h?: number }): void => {
    const w = Math.min(Math.max(widget.w + (change.w ?? 0), 1), 12);
    const h = Math.min(Math.max(widget.h + (change.h ?? 0), 1), 12);
    act({ type: 'resize-widget', id: widget.id, w, h });
    const name = titleOf(widget);
    setNotice(t`${name} is now ${w} columns wide and ${h} rows tall.`);
  };

  const editingWidget =
    editing && state.editing !== null
      ? page?.widgets.find((widget) => widget.id === state.editing)
      : undefined;
  const pageCount = definition.pages.length;
  const widgets = page?.widgets ?? [];
  const pageProblems = issues.pages[state.page] ?? [];
  const canAdd = canAddWidget(definition, state.page);
  const title = state.name.trim() === '' ? t`Untitled report` : state.name;

  return (
    <Page
      title={title}
      actions={
        report.canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                {dirty ? (
                  <Button
                    variant="quiet"
                    onClick={(event) => {
                      returnFocusRef.current = event.currentTarget;
                      setAsking('discard');
                    }}
                  >
                    <Trans>Discard changes</Trans>
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  onClick={(event) => {
                    if (dirty) {
                      returnFocusRef.current = event.currentTarget;
                      setAsking('done');
                    } else setEditing(false);
                  }}
                >
                  <Trans>Done editing</Trans>
                </Button>
                <Button disabled={!dirty || save.isPending} onClick={trySave}>
                  <Trans>Save</Trans>
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  disabled={clone.isPending}
                  onClick={() => {
                    clone.mutate();
                  }}
                >
                  <Trans>Clone</Trans>
                </Button>
                <Button
                  onClick={() => {
                    setEditing(true);
                  }}
                >
                  <Pencil aria-hidden className="size-4" strokeWidth={2} />
                  <Trans>Edit report</Trans>
                </Button>
              </>
            )}
          </div>
        ) : undefined
      }
    >
      <Link
        to="/b/$slug/reports"
        params={{ slug: business.slug }}
        className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm text-link hover:underline lg:min-h-8"
      >
        <ArrowLeft aria-hidden className="size-4" strokeWidth={2} />
        <Trans>Custom reports</Trans>
      </Link>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {stale ? (
        <div
          role="alert"
          className="flex min-w-0 flex-col gap-2 rounded-card border border-attention-foreground bg-attention p-4 text-sm text-attention-foreground"
        >
          <p className="font-medium">
            <Trans>This report was changed somewhere else since you opened it.</Trans>
          </p>
          <p>
            <Trans>
              Your changes were not saved. Take the saved version (yours are dropped), save yours as
              a copy, or keep editing and decide later.
            </Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="small"
              disabled={reloadSaved.isPending}
              onClick={() => {
                reloadSaved.mutate();
              }}
            >
              <Trans>Reload saved version</Trans>
            </Button>
            <Button
              variant="secondary"
              size="small"
              disabled={saveCopy.isPending}
              onClick={() => {
                saveCopy.mutate();
              }}
            >
              <Trans>Save mine as a copy</Trans>
            </Button>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                setStale(false);
              }}
            >
              <Trans>Keep editing</Trans>
            </Button>
          </div>
          {saveCopy.isError ? (
            <p>
              <Trans>The copy couldn't be saved. Try again.</Trans>
            </p>
          ) : null}
        </div>
      ) : null}
      {issues.form.length > 0 ? (
        <ul role="alert" className="list-disc pl-5 text-sm font-medium text-destructive">
          {issues.form.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {editing ? (
        <div className="flex min-w-0 flex-col gap-1 sm:max-w-md">
          <label htmlFor={nameId} className="text-xs text-muted-foreground">
            <Trans>Report name</Trans>
          </label>
          <Input
            id={nameId}
            maxLength={120}
            autoComplete="off"
            value={state.name}
            aria-invalid={issues.name !== undefined}
            onChange={(event) => {
              act({ type: 'rename', name: event.target.value });
            }}
          />
          {issues.name === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {issues.name}
            </p>
          )}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col gap-1.5">
        <DatesControl
          dates={dates}
          presets={catalog?.presets}
          resolved={resolved?.range}
          onChange={(next) => {
            if (!editing) {
              setViewDates(next);
              return;
            }
            if (next.range !== definition.range) act({ type: 'range', range: next.range });
            if (next.compare !== definition.compare)
              act({ type: 'compare', compare: next.compare });
          }}
        />
        {resolved === undefined ? null : (
          <ResolvedRange range={resolved.range} timeZone={resolved.timeZone} />
        )}
        {!editing && viewDates !== undefined ? (
          <p className="text-xs text-muted-foreground">
            <Trans>You are looking at other dates. The report itself keeps its own.</Trans>
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {pageCount > 1 || editing ? (
          <nav aria-label={t`Pages of the report`} className="flex min-w-0 flex-wrap gap-1">
            {definition.pages.map((each, index) => (
              <button
                // A page is known only by its place in the report.
                // eslint-disable-next-line @eslint-react/no-array-index-key
                key={index}
                type="button"
                aria-current={index === state.page ? 'page' : undefined}
                className="inline-flex min-h-11 max-w-60 items-center rounded-control px-3 text-sm font-medium text-body -outline-offset-2 hover:bg-muted aria-[current=page]:bg-accent aria-[current=page]:text-link lg:min-h-8"
                onClick={() => {
                  showPage(index);
                }}
              >
                <span className="truncate">{each.name}</span>
              </button>
            ))}
          </nav>
        ) : null}
        {editing ? (
          <Button
            variant="secondary"
            size="small"
            disabled={!canAddPage(definition)}
            onClick={() => {
              const number = pageCount + 1;
              act({ type: 'add-page', name: t`Page ${number}` });
              void navigateHere({ search: { ...search, page: pageCount + 1 }, replace: true });
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>Add page</Trans>
          </Button>
        ) : null}
      </div>
      {editing && page !== undefined ? (
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
            <label htmlFor={pageNameId} className="text-xs text-muted-foreground">
              <Trans>Page name</Trans>
            </label>
            <Input
              id={pageNameId}
              maxLength={80}
              autoComplete="off"
              value={page.name}
              aria-invalid={pageProblems.length > 0}
              onChange={(event) => {
                act({ type: 'rename-page', page: state.page, name: event.target.value });
              }}
            />
          </div>
          {pageCount > 1 ? (
            <Button
              variant="secondary"
              onClick={(event) => {
                if (widgets.length === 0) {
                  act({ type: 'remove-page', page: state.page });
                  showPage(Math.max(state.page - 1, 0));
                  return;
                }
                returnFocusRef.current = event.currentTarget;
                setAsking('remove-page');
              }}
            >
              <Trash2 aria-hidden className="size-4" strokeWidth={2} />
              <Trans>Delete page</Trans>
            </Button>
          ) : null}
          <Suspense fallback={null}>
            <AddWidget
              disabled={!canAdd || catalog === undefined}
              onAdd={(kind, trigger) => {
                returnFocusRef.current = trigger;
                addWidget(kind);
              }}
            />
          </Suspense>
        </div>
      ) : null}
      {pageProblems.length > 0 ? (
        <ul role="alert" className="list-disc pl-5 text-sm text-destructive">
          {pageProblems.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {widgets.length === 0 ? (
        <p className="rounded-card border border-dashed bg-card px-4 py-10 text-center text-md text-muted-foreground">
          {editing ? (
            <Trans>This page is empty. Add a widget to start it.</Trans>
          ) : (
            <Trans>This page has no widgets yet.</Trans>
          )}
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-12">
          {widgets.map((widget, index) => {
            const name = titleOf(widget);
            const problems = issues.widgets[widget.id] ?? [];
            return (
              // Dropping a dragged widget here puts it before this one. The buttons in each
              // widget's corner do the same from the keyboard.
              // eslint-disable-next-line jsx-a11y-x/no-noninteractive-element-interactions
              <section
                key={widget.id}
                aria-label={name}
                data-testid={`widget-${widget.id}`}
                style={{ '--w': String(widget.w), '--h': String(widget.h) } as CSSProperties}
                className={`flex min-w-0 flex-col gap-3 rounded-card border bg-card p-4 lg:[grid-column:span_var(--w)] lg:min-h-[calc(var(--h)*3.5rem)] ${
                  dragging !== undefined && dragging !== widget.id ? 'border-dashed' : ''
                } ${problems.length > 0 ? 'border-destructive' : ''}`}
                onDragOver={
                  editing && dragging !== undefined
                    ? (event) => {
                        event.preventDefault();
                      }
                    : undefined
                }
                onDrop={
                  editing && dragging !== undefined
                    ? (event) => {
                        event.preventDefault();
                        act({ type: 'place-widget', id: dragging, before: widget.id });
                        setDragging(undefined);
                      }
                    : undefined
                }
              >
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <h2 className="min-w-0 py-1 text-md font-medium break-words text-foreground">
                    {name}
                  </h2>
                  {editing ? (
                    <Suspense fallback={null}>
                      <WidgetTools
                        name={name}
                        first={index === 0}
                        last={index === widgets.length - 1}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move';
                          event.dataTransfer.setData('text/plain', widget.id);
                          setDragging(widget.id);
                        }}
                        onDragEnd={() => {
                          setDragging(undefined);
                        }}
                        onMove={(by) => {
                          move(widget, by);
                        }}
                        onEdit={(trigger) => {
                          returnFocusRef.current = trigger;
                          act({ type: 'edit', id: widget.id });
                        }}
                        onResize={(change) => {
                          resize(widget, change);
                        }}
                        onDuplicate={() => {
                          act({
                            type: 'duplicate-widget',
                            id: widget.id,
                            title: t`${name} (copy)`.slice(0, 120),
                          });
                          setNotice(t`Duplicated ${name}.`);
                        }}
                        onDelete={() => {
                          act({ type: 'remove-widget', id: widget.id });
                          setNotice(t`Deleted ${name}.`);
                        }}
                      />
                    </Suspense>
                  ) : null}
                </div>
                {problems.length > 0 ? (
                  <ul role="alert" className="list-disc pl-5 text-sm text-destructive">
                    {problems.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                ) : null}
                <LazyWidgetBody
                  businessId={business.id}
                  widget={widget}
                  dates={dates}
                  onResolved={onResolved}
                />
              </section>
            );
          })}
        </div>
      )}
      {editingWidget === undefined || catalog === undefined ? null : (
        <Suspense fallback={null}>
          <WidgetEditor
            key={editingWidget.id}
            businessId={business.id}
            catalog={catalog}
            widget={editingWidget}
            dates={own}
            problems={issues.widgets[editingWidget.id] ?? []}
            returnFocus={returnFocusRef}
            onChange={(widget) => {
              act({ type: 'change-widget', id: editingWidget.id, widget });
            }}
            onClose={() => {
              dispatch({ type: 'edit', id: null });
            }}
          />
        </Suspense>
      )}
      {asking !== undefined || blocker.status === 'blocked' ? (
        <Suspense fallback={null}>
          <AskDialog
            about={asking === 'remove-page' ? 'remove-page' : 'leave'}
            returnFocus={returnFocusRef}
            onConfirm={() => {
              if (asking === 'remove-page') {
                act({ type: 'remove-page', page: state.page });
                showPage(Math.max(state.page - 1, 0));
              } else {
                act({ type: 'discard' });
                setStale(false);
                if (asking === 'done') setEditing(false);
                if (blocker.status === 'blocked') blocker.proceed();
              }
              setAsking(undefined);
            }}
            onClose={() => {
              setAsking(undefined);
              if (blocker.status === 'blocked') blocker.reset();
            }}
          />
        </Suspense>
      ) : null}
    </Page>
  );
}
