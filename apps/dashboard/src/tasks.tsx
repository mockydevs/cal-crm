// Contacts → Tasks (laid out as GoHighLevel's): every task of the business in one table, a
// page at a time as the server pages it. The tabs, the chips, the title search and the two
// sortable headings are the filters and orders `listTasks` applies, and all of them are
// kept in the address. Reading is open to the business; changing a task needs the
// permission the server reports with canManage.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  bulkUpdateTasks,
  completeTask,
  deleteTask,
  listTaskAssignees,
  listTasks,
  type Task,
  type TaskAssigneeList,
  type TaskList,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { linkClassName, RightPanel } from './conversation-extras-panel';
import { CountChip, ListSearch, PanelContent } from './list-toolbar';
import {
  cellClassName,
  ConfirmDialog,
  headerCellClassName,
  iconButtonClassName,
  isStale,
  listCardClassName,
  ListFooter,
  ListProblem,
  retryFaults,
  sortButtonClassName,
  tableClassName,
  tableRegionClassName,
  ViewSwitch,
} from './settings-list';
import {
  emptyTrail,
  rangeOf,
  trailBack,
  trailCursor,
  trailForward,
  type PageSize,
} from './settings-rules';
import { Page } from './shell/page';
import { RecurrenceMark, SeriesDeleteChoice } from './task-recurrence-lazy';
import {
  bulkBodyOf,
  outcomeOf,
  selectable,
  selectionAmong,
  toggled,
  type BulkOutcome,
  type TaskBulkChoice,
} from './task-bulk-rules';
import {
  listQueryOf,
  rangeBackwards,
  sortOf,
  withAssignee,
  withList,
  withRange,
  withSort,
  withStatus,
  withTitle,
  type TaskListTab,
  type TaskSortColumn,
  type TasksSearch,
} from './task-rules';
import { useBusiness } from './workspace';

const TaskForm = lazy(async () => ({ default: (await import('./task-panel')).TaskForm }));
const TaskBulkDialog = lazy(() => import('./task-bulk'));

const checkboxClassName = 'size-4 shrink-0 accent-primary';
/** Room round a checkbox, so a finger finds it: 44px below the desktop width. */
const tickAreaClassName = 'inline-flex size-11 items-center justify-center lg:size-8';

type Opened =
  | { readonly kind: 'task'; readonly task: Task | undefined; readonly round: number }
  | { readonly kind: 'delete'; readonly task: Task; readonly changed: boolean };

const tasksKey = (businessId: string) => ['b', businessId, 'tasks'] as const;

/** Whether the page asked for was anchored on a task that is no longer there. */
function cursorGone(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    error.problem.errors?.some((each) => each.path === '/after') === true
  );
}

type Person = TaskAssigneeList['items'][number];

/** Everyone a task can be assigned to, read to the end of the team a page at a time. */
const MOST_TEAM_PAGES = 20;

export function TasksPage({
  search,
  onSearch,
}: {
  readonly search: TasksSearch;
  /** Changes the address: handed what it holds now, so two quick changes both land. */
  readonly onSearch: (change: (now: TasksSearch) => TasksSearch) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const api = apiIn(business.id);
  const [trail, setTrail] = useState(emptyTrail);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [opened, setOpened] = useState<Opened>();
  // Deleting a task of a series: that task alone, or it and the series' upcoming tasks.
  const [wholeSeries, setWholeSeries] = useState(false);
  // The rows ticked for a bulk action, on the page showing; what the last one came to.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulk, setBulk] = useState<'assign' | 'set_due' | 'delete'>();
  const [outcome, setOutcome] = useState<BulkOutcome>();
  const bulkFocusRef = useRef<HTMLElement | null>(null);
  const bulkRegionRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState('');
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Another list starts at its first page.
  const asked = JSON.stringify(search);
  const [shown, setShown] = useState(asked);
  if (shown !== asked) {
    setShown(asked);
    setTrail(emptyTrail);
  }

  // The title being typed, and the one last sent to the address once typing paused. A
  // title in the address that is neither came from outside (back, a link): show it.
  const [title, setTitle] = useState(search.q ?? '');
  const [sentTitle, setSentTitle] = useState(search.q ?? '');
  const [seenTitle, setSeenTitle] = useState(search.q ?? '');
  const typingRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  if ((search.q ?? '') !== seenTitle) {
    setSeenTitle(search.q ?? '');
    if ((search.q ?? '') !== sentTitle) {
      setTitle(search.q ?? '');
      setSentTitle(search.q ?? '');
    }
  }
  useEffect(
    () => () => {
      clearTimeout(typingRef.current);
    },
    [],
  );

  const backwards = rangeBackwards(search);
  const query = listQueryOf(search, { limit: pageSize, after: trailCursor(trail) });
  const listKey = [...tasksKey(business.id), 'page', query] as const;
  // Ticks are for the page showing: another page, or another list, starts with none.
  const pageAsked = JSON.stringify(query);
  const [pageShown, setPageShown] = useState(pageAsked);
  if (pageShown !== pageAsked) {
    setPageShown(pageAsked);
    setSelected(new Set());
  }
  const tasks = useQuery({
    queryKey: listKey,
    queryFn: () => api.request(listTasks, { query }),
    enabled: !backwards,
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const people = useQuery({
    queryKey: ['b', business.id, 'task-assignees', 'all'],
    queryFn: async () => {
      const everyone: Person[] = [];
      let after: string | undefined;
      for (let page = 0; page < MOST_TEAM_PAGES; page += 1) {
        const answer = await api.request(listTaskAssignees, {
          query: after === undefined ? {} : { after },
        });
        everyone.push(...answer.items);
        if (answer.nextCursor === null) break;
        after = answer.nextCursor;
      }
      return everyone;
    },
    retry: retryFaults,
  });
  const refresh = async (): Promise<void> => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: tasksKey(business.id) }),
      cache.invalidateQueries({ queryKey: ['b', business.id, 'activity'] }),
    ]);
  };
  /** The task as the list has it now, once the list has been read again. */
  const latestOf = async (id: string): Promise<Task | undefined> => {
    await refresh();
    return cache.getQueryData<TaskList>(listKey)?.items.find((each) => each.id === id);
  };
  const close = (message = '') => {
    setOpened(undefined);
    setNotice(message);
  };

  const complete = useMutation({
    mutationFn: (task: Task) =>
      api.request(completeTask, {
        params: { id: task.id },
        body: { completed: task.completedAt === null, revision: task.revision },
      }),
    onSuccess: async (_, task) => {
      await refresh();
      setNotice(task.completedAt === null ? t`Task completed.` : t`Task reopened.`);
    },
    // Someone else changed it, or the permission went: show the list as it is now.
    onError: () => refresh(),
  });
  const remove = useMutation({
    mutationFn: async (task: Task) => {
      await api.request(deleteTask, {
        params: { id: task.id },
        body: {
          revision: task.revision,
          ...(wholeSeries && task.recurrence !== undefined ? { applyTo: 'series' as const } : {}),
        },
      });
      return task;
    },
    onSuccess: async () => {
      // The last row of a page is gone: show the page before it.
      if (tasks.data?.items.length === 1) setTrail(trailBack);
      await refresh();
      close(t`Task deleted.`);
    },
    onError: async (error, task) => {
      if (!isStale(error)) return;
      const latest = await latestOf(task.id);
      if (latest === undefined) close(t`That task changed and is no longer in this list.`);
      else setOpened({ kind: 'delete', task: latest, changed: true });
    },
  });

  const bulkRun = useMutation({
    mutationFn: async ({
      choice,
      chosen,
    }: {
      readonly choice: TaskBulkChoice;
      readonly chosen: readonly Task[];
    }) =>
      outcomeOf(await api.request(bulkUpdateTasks, { body: bulkBodyOf(choice, chosen) }), chosen),
    onSuccess: async (result) => {
      await refresh();
      // The keyboard goes to what the action came to; the skipped rows stay ticked.
      bulkFocusRef.current = bulkRegionRef.current;
      setBulk(undefined);
      setSelected(new Set(result.skipped.map((each) => each.id)));
      setOutcome(result);
      // Tasks of a later page are gone, and with them the task the page was asked after.
      if (result.action === 'delete' && result.done > 0 && trail.index > 0) setTrail(emptyTrail);
      bulkRegionRef.current?.focus();
    },
  });

  const open = (next: Opened, trigger: HTMLElement | null) => {
    returnFocusRef.current = trigger;
    complete.reset();
    remove.reset();
    bulkRun.reset();
    setWholeSeries(false);
    setOpened(next);
    setNotice('');
  };

  const canManage = tasks.data?.canManage === true;
  const listed = backwards ? undefined : tasks.data;
  const items = listed?.items ?? [];
  const total = listed?.total;
  const others = (people.data ?? []).filter((person) => !person.you);
  // Someone named in the address who is not on the team any more still has to show as chosen.
  const named =
    search.assignee !== undefined &&
    search.assignee !== 'mine' &&
    search.assignee !== 'unassigned' &&
    !others.some((person) => person.id === search.assignee)
      ? search.assignee
      : undefined;
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tab: TaskListTab = search.list ?? 'all';
  // A dated list opens on open tasks by itself, so there the status is not a narrowing.
  const narrowed =
    search.assignee !== undefined ||
    search.q !== undefined ||
    search.from !== undefined ||
    search.to !== undefined ||
    (tab === 'all' && search.status !== undefined);
  const sortHeading = (column: TaskSortColumn, label: ReactNode): ReactElement => {
    const sorted = sortOf(search, column);
    return (
      <button
        type="button"
        className={sortButtonClassName}
        onClick={() => {
          onSearch((now) => withSort(now, column));
        }}
      >
        {label}
        {sorted === 'ascending' ? (
          <ArrowUp aria-hidden className="size-3.5" strokeWidth={2} />
        ) : sorted === 'descending' ? (
          <ArrowDown aria-hidden className="size-3.5" strokeWidth={2} />
        ) : (
          <ArrowUpDown aria-hidden className="size-3.5 text-muted-foreground" strokeWidth={2} />
        )}
      </button>
    );
  };
  const editing = opened?.kind === 'task' ? opened.task : undefined;
  const removing = opened?.kind === 'delete' ? opened.task.title : '';
  const pageNumber = trail.index + 1;
  const turning = tasks.isFetching && tasks.isPlaceholderData;
  const busy = complete.isPending || remove.isPending || bulkRun.isPending;
  const selectableItems = items.filter((task) => selectable(task, canManage));
  const chosen = selectionAmong(selected, items, canManage);
  const chosenCount = chosen.length;
  const runBulk = (choice: TaskBulkChoice, trigger: HTMLElement | null) => {
    if (trigger !== null) bulkFocusRef.current = trigger;
    complete.reset();
    setNotice('');
    setOutcome(undefined);
    bulkRun.mutate({ choice, chosen });
  };
  const askBulk = (kind: 'assign' | 'set_due' | 'delete', trigger: HTMLElement) => {
    bulkFocusRef.current = trigger;
    bulkRun.reset();
    complete.reset();
    setNotice('');
    setBulk(kind);
  };
  const bulkProblem = !bulkRun.isError
    ? undefined
    : bulkRun.error instanceof ApiError
      ? (bulkRun.error.problem.errors?.find((issue) => issue.message.trim() !== '')?.message ??
        bulkRun.error.problem.detail ??
        t`The bulk action wasn't run. Try again.`)
      : t`The bulk action wasn't run. Check your connection and try again.`;
  const skippedCount = outcome?.skipped.length ?? 0;

  return (
    <Page
      title={t`Tasks`}
      actions={
        canManage ? (
          <Button
            onClick={(event) => {
              open({ kind: 'task', task: undefined, round: 0 }, event.currentTarget);
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>Add Task</Trans>
          </Button>
        ) : undefined
      }
    >
      <p role="status" className="sr-only">
        {notice}
      </p>
      {tasks.data !== undefined && !canManage ? (
        <p className="text-md text-muted-foreground">
          <Trans>You can read tasks. Changing them needs permission to manage tasks.</Trans>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <ViewSwitch
          label={t`Task lists`}
          value={tab}
          onChange={(next) => {
            onSearch((now) => withList(now, next));
          }}
          views={[
            { value: 'all', label: t`All` },
            { value: 'today', label: t`Due today` },
            { value: 'overdue', label: t`Overdue` },
            { value: 'upcoming', label: t`Upcoming` },
          ]}
        />
        {total === undefined ? null : (
          <CountChip>
            <Plural value={total} one="# Task" other="# Tasks" />
          </CountChip>
        )}
      </div>
      <section aria-label={t`Tasks`} className={listCardClassName}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 items-center gap-2 text-sm font-medium text-body">
            <Trans>Assignee</Trans>
            <Select
              aria-label={t`Assignee`}
              className="w-auto min-w-40 rounded-full"
              value={search.assignee ?? 'all'}
              onValueChange={(value) => {
                onSearch((now) => withAssignee(now, value));
              }}
            >
              <option value="all">{t`Anyone`}</option>
              <option value="mine">{t`Assigned to me`}</option>
              <option value="unassigned">{t`Unassigned`}</option>
              {named === undefined ? null : <option value={named}>{t`Unavailable person`}</option>}
              {others.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name ?? t`Unavailable person`}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex min-w-0 items-center gap-2 text-sm font-medium text-body">
            <Trans>Status</Trans>
            <Select
              aria-label={t`Status`}
              className="w-auto min-w-32 rounded-full"
              value={search.status ?? 'all'}
              onValueChange={(value) => {
                onSearch((now) => withStatus(now, value));
              }}
            >
              <option value="all">{t`All`}</option>
              <option value="open">{t`Open`}</option>
              <option value="completed">{t`Completed`}</option>
            </Select>
          </label>
          <div
            role="group"
            aria-label={t`Due date`}
            className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-body"
          >
            <span aria-hidden>
              <Trans>Due date</Trans>
            </span>
            <Input
              type="date"
              aria-label={t`Due from`}
              className="w-auto rounded-full"
              value={search.from ?? ''}
              max={search.to}
              onChange={(event) => {
                const from = event.target.value;
                onSearch((now) => withRange(now, { from }));
              }}
            />
            <span aria-hidden className="font-normal text-muted-foreground">
              <Trans>to</Trans>
            </span>
            <Input
              type="date"
              aria-label={t`Due to`}
              className="w-auto rounded-full"
              value={search.to ?? ''}
              min={search.from}
              onChange={(event) => {
                const to = event.target.value;
                onSearch((now) => withRange(now, { to }));
              }}
            />
          </div>
          <div className="ml-auto flex min-w-0 flex-1 basis-48 justify-end">
            <ListSearch
              label={t`Search for task title`}
              value={title}
              onChange={(next) => {
                setTitle(next);
                clearTimeout(typingRef.current);
                typingRef.current = setTimeout(() => {
                  setSentTitle(next.trim().slice(0, 200));
                  onSearch((now) => withTitle(now, next));
                }, 250);
              }}
            />
          </div>
        </div>
        {backwards ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            <Trans>The range ends before it starts.</Trans>
          </p>
        ) : null}
        {tasks.isPending && !backwards ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading tasks…</Trans>
          </p>
        ) : null}
        {tasks.isError ? (
          <ListProblem
            onRetry={() => {
              if (cursorGone(tasks.error)) setTrail(emptyTrail);
              else void tasks.refetch();
            }}
          >
            <Trans>Tasks couldn't be loaded.</Trans>
          </ListProblem>
        ) : null}
        {complete.isError ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {complete.error instanceof ApiError
              ? (complete.error.problem.detail ?? t`The task wasn't changed. Try again.`)
              : t`The task wasn't changed. Check your connection and try again.`}
          </p>
        ) : null}
        {listed !== undefined && items.length === 0 ? (
          <p className="py-6 text-center text-md text-muted-foreground">
            {narrowed ? (
              <Trans>No tasks match.</Trans>
            ) : tab === 'today' ? (
              <Trans>No tasks due today.</Trans>
            ) : tab === 'overdue' ? (
              <Trans>No overdue tasks.</Trans>
            ) : tab === 'upcoming' ? (
              <Trans>No upcoming tasks.</Trans>
            ) : (
              <Trans>No tasks yet.</Trans>
            )}
          </p>
        ) : null}
        <div
          ref={bulkRegionRef}
          tabIndex={-1}
          className="flex flex-col gap-2 -outline-offset-2 empty:hidden"
        >
          {chosenCount === 0 ? null : (
            <div
              role="group"
              aria-label={t`Bulk actions`}
              className="flex flex-wrap items-center gap-2 rounded-card border bg-card px-3 py-2"
            >
              <span className="text-sm font-medium text-foreground">
                <Plural value={chosenCount} one="# selected" other="# selected" />
              </span>
              <Button
                variant="secondary"
                size="small"
                disabled={busy}
                onClick={(event) => {
                  runBulk({ action: 'complete' }, event.currentTarget);
                }}
              >
                <Trans>Mark complete</Trans>
              </Button>
              <Button
                variant="secondary"
                size="small"
                disabled={busy}
                onClick={(event) => {
                  runBulk({ action: 'reopen' }, event.currentTarget);
                }}
              >
                <Trans>Reopen</Trans>
              </Button>
              <Button
                variant="secondary"
                size="small"
                disabled={busy}
                onClick={(event) => {
                  askBulk('assign', event.currentTarget);
                }}
              >
                <Trans>Assign</Trans>
              </Button>
              <Button
                variant="secondary"
                size="small"
                disabled={busy}
                onClick={(event) => {
                  askBulk('set_due', event.currentTarget);
                }}
              >
                <Trans>Change due date</Trans>
              </Button>
              <Button
                variant="secondary"
                size="small"
                className="border-destructive text-destructive"
                disabled={busy}
                onClick={(event) => {
                  askBulk('delete', event.currentTarget);
                }}
              >
                <Trans>Delete</Trans>
              </Button>
              <Button
                variant="quiet"
                size="small"
                disabled={busy}
                onClick={() => {
                  setSelected(new Set());
                }}
              >
                <Trans>Clear selection</Trans>
              </Button>
            </div>
          )}
          {bulkProblem !== undefined && bulk === undefined ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {bulkProblem}
            </p>
          ) : null}
          {outcome === undefined ? null : (
            <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-body">
              <div role="status" className="flex min-w-0 flex-col gap-1">
                <p className="font-medium text-foreground">
                  {outcome.action === 'delete' ? (
                    <Plural value={outcome.done} one="# task deleted." other="# tasks deleted." />
                  ) : (
                    <Plural value={outcome.done} one="# task changed." other="# tasks changed." />
                  )}
                  {outcome.unchanged === 0 ? null : (
                    <>
                      {' '}
                      <Plural
                        value={outcome.unchanged}
                        one="# was already as asked."
                        other="# were already as asked."
                      />
                    </>
                  )}
                  {skippedCount === 0 ? null : (
                    <>
                      {' '}
                      <Plural
                        value={skippedCount}
                        one="# was skipped and is still ticked:"
                        other="# were skipped and are still ticked:"
                      />
                    </>
                  )}
                </p>
                {skippedCount === 0 ? null : (
                  <ul aria-label={t`Skipped tasks`} className="flex flex-col gap-0.5">
                    {outcome.skipped.map((each) => (
                      <li key={each.id} className="wrap-anywhere">
                        <span className="font-medium text-foreground">{each.title}</span>
                        {each.message === '' ? null : <>: {each.message}</>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Button
                variant="quiet"
                size="small"
                onClick={() => {
                  setOutcome(undefined);
                }}
              >
                <Trans>Dismiss</Trans>
              </Button>
            </div>
          )}
        </div>
        {items.length === 0 ? null : (
          <div role="region" aria-label={t`Tasks table`} className={tableRegionClassName}>
            <table className={`${tableClassName} min-w-[1100px] table-fixed`}>
              <caption className="sr-only">
                <Trans>Tasks</Trans>
              </caption>
              <thead>
                <tr>
                  {canManage ? (
                    <td className="h-10 w-14 bg-muted px-1 py-0 text-center">
                      <label className={tickAreaClassName}>
                        <input
                          type="checkbox"
                          className={checkboxClassName}
                          aria-label={t`Select every task on this page`}
                          disabled={selectableItems.length === 0 || busy}
                          checked={
                            selectableItems.length > 0 && chosenCount === selectableItems.length
                          }
                          onChange={(event) => {
                            setSelected(
                              new Set(
                                event.target.checked ? selectableItems.map((task) => task.id) : [],
                              ),
                            );
                          }}
                        />
                      </label>
                    </td>
                  ) : null}
                  <th scope="col" className={`${headerCellClassName} w-16`}>
                    <Trans>Status</Trans>
                  </th>
                  <th
                    scope="col"
                    aria-sort={sortOf(search, 'title')}
                    className={`${headerCellClassName} w-[22%]`}
                  >
                    {sortHeading('title', <Trans>Title</Trans>)}
                  </th>
                  <th scope="col" className={headerCellClassName}>
                    <Trans>Description</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-[16%]`}>
                    <Trans>Associated record</Trans>
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-[13%]`}>
                    <Trans>Assignee</Trans>
                  </th>
                  <th
                    scope="col"
                    aria-sort={sortOf(search, 'due')}
                    className={`${headerCellClassName} w-56`}
                  >
                    {sortHeading('due', <Trans>Due date ({timeZone})</Trans>)}
                  </th>
                  <th scope="col" className={`${headerCellClassName} w-28`}>
                    <span className="sr-only">
                      <Trans>Actions</Trans>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((task) => {
                  const done = task.completedAt !== null;
                  const changeable = canManage && task.record?.trashed !== true;
                  const title = task.title;
                  return (
                    <tr key={task.id} className="hover:bg-muted">
                      {canManage ? (
                        <td className={`${cellClassName} px-1 text-center`}>
                          {changeable ? (
                            <label className={tickAreaClassName}>
                              <input
                                type="checkbox"
                                className={checkboxClassName}
                                aria-label={t`Select ${title}`}
                                disabled={busy}
                                checked={selected.has(task.id)}
                                onChange={(event) => {
                                  setSelected(toggled(selected, task.id, event.target.checked));
                                }}
                              />
                            </label>
                          ) : null}
                        </td>
                      ) : null}
                      <td className={cellClassName}>
                        {changeable ? (
                          <button
                            type="button"
                            aria-pressed={done}
                            aria-label={done ? t`Reopen ${title}` : t`Complete ${title}`}
                            disabled={busy}
                            className="group inline-flex size-11 items-center justify-center rounded-full -outline-offset-2 disabled:opacity-50 lg:size-8"
                            onClick={() => {
                              complete.reset();
                              setNotice('');
                              complete.mutate(task);
                            }}
                          >
                            <StatusMark done={done} />
                          </button>
                        ) : (
                          <span className="inline-flex size-11 items-center justify-center lg:size-8">
                            <StatusMark done={done} />
                            <span className="sr-only">{done ? t`Completed` : t`Open`}</span>
                          </span>
                        )}
                      </td>
                      <th
                        scope="row"
                        className={`${cellClassName} text-left font-medium wrap-anywhere text-foreground`}
                      >
                        {title}
                      </th>
                      <td className={`${cellClassName} truncate`} title={task.description}>
                        {task.description}
                      </td>
                      <td className={`${cellClassName} wrap-anywhere`}>
                        {task.record === null ? null : <TaskRecord record={task.record} />}
                      </td>
                      <td className={`${cellClassName} wrap-anywhere`}>
                        {task.assignee === null ? (
                          <span className="text-muted-foreground">
                            <Trans>Unassigned</Trans>
                          </span>
                        ) : task.assignee.you ? (
                          <Trans>You</Trans>
                        ) : (
                          (task.assignee.name ?? <Trans>Unavailable person</Trans>)
                        )}
                      </td>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {task.dueAt === null ? null : (
                          <time dateTime={task.dueAt}>{moment.format(new Date(task.dueAt))}</time>
                        )}
                        {/* Beside the due date, not in the row's heading, which every cell is read with. */}
                        {task.recurrence === undefined ? null : (
                          <Suspense fallback={null}>
                            <RecurrenceMark
                              recurrence={task.recurrence}
                              format={(date) => moment.format(date)}
                            />
                          </Suspense>
                        )}
                      </td>
                      <td className={`${cellClassName} text-right whitespace-nowrap`}>
                        {changeable ? (
                          <>
                            <button
                              type="button"
                              className={iconButtonClassName}
                              aria-label={t`Edit ${title}`}
                              disabled={busy}
                              onClick={(event) => {
                                open({ kind: 'task', task, round: 0 }, event.currentTarget);
                              }}
                            >
                              <Pencil aria-hidden className="size-4" strokeWidth={1.8} />
                            </button>
                            <button
                              type="button"
                              className={iconButtonClassName}
                              aria-label={t`Delete ${title}`}
                              disabled={busy}
                              onClick={(event) => {
                                open({ kind: 'delete', task, changed: false }, event.currentTarget);
                              }}
                            >
                              <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                            </button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {listed === undefined ? null : total !== undefined ? (
          <ListFooter
            perPageLabel={t`Rows per page`}
            pageSize={pageSize}
            onPageSize={(size) => {
              setPageSize(size);
              setTrail(emptyTrail);
            }}
            range={rangeOf({ index: trail.index, pageSize, shown: items.length, total })}
            number={pageNumber}
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
        ) : (
          <nav
            aria-label={t`Pages`}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm text-body"
          >
            <p role="status" aria-busy={turning}>
              <Trans>Page {pageNumber}</Trans>
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="quiet"
                size="small"
                aria-label={t`Previous page`}
                disabled={trail.index === 0 || turning}
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
                disabled={listed.nextCursor === null || turning}
                onClick={() => {
                  setTrail(trailForward(trail, listed.nextCursor));
                }}
              >
                <Trans>Next</Trans>
              </Button>
            </div>
          </nav>
        )}
      </section>

      <RightPanel
        open={opened?.kind === 'task'}
        onClose={close}
        returnFocus={returnFocusRef}
        title={editing === undefined ? <Trans>New task</Trans> : <Trans>Edit task</Trans>}
      >
        {opened?.kind === 'task' ? (
          <PanelContent>
            <TaskForm
              key={
                opened.task === undefined
                  ? `new:${String(opened.round)}`
                  : `${opened.task.id}:${opened.task.revision}`
              }
              task={opened.task}
              addedBefore={opened.round > 0}
              onCancel={close}
              onSaved={async (created, another) => {
                await refresh();
                if (another) setOpened({ kind: 'task', task: undefined, round: opened.round + 1 });
                else close(created ? t`Task added.` : t`Task saved.`);
              }}
              onLatest={latestOf}
              onReload={(latest) => {
                setOpened({ kind: 'task', task: latest, round: 0 });
              }}
            />
          </PanelContent>
        ) : null}
      </RightPanel>

      {(bulk === 'assign' || bulk === 'set_due') && chosenCount > 0 ? (
        <Suspense fallback={null}>
          <TaskBulkDialog
            action={bulk}
            count={chosenCount}
            people={others}
            pending={bulkRun.isPending}
            problem={bulkProblem}
            returnFocus={bulkFocusRef}
            onClose={() => {
              setBulk(undefined);
              bulkRun.reset();
            }}
            onRun={(choice) => {
              runBulk(choice, null);
            }}
          />
        </Suspense>
      ) : null}

      <ConfirmDialog
        open={bulk === 'delete' && chosenCount > 0}
        returnFocus={bulkFocusRef}
        title={<Plural value={chosenCount} one="Delete # task?" other="Delete # tasks?" />}
        description={
          <Trans>
            They are deleted for everyone, for good. This can't be undone: a deleted task is not
            kept in the trash.
          </Trans>
        }
        confirmLabel={t`Delete`}
        destructive
        busy={bulkRun.isPending}
        problem={bulkProblem}
        onClose={() => {
          setBulk(undefined);
          bulkRun.reset();
        }}
        onConfirm={() => {
          runBulk({ action: 'delete' }, null);
        }}
      />

      <ConfirmDialog
        open={opened?.kind === 'delete'}
        returnFocus={returnFocusRef}
        title={opened?.kind === 'delete' ? <Trans>Delete {removing}?</Trans> : null}
        description={
          opened?.kind === 'delete' ? (
            <>
              <Trans>The task is deleted for everyone.</Trans>
              {opened.task.recurrence === undefined ? null : (
                <Suspense fallback={null}>
                  <SeriesDeleteChoice checked={wholeSeries} onChange={setWholeSeries} />
                </Suspense>
              )}
            </>
          ) : null
        }
        confirmLabel={t`Delete`}
        destructive
        busy={remove.isPending}
        problem={
          remove.isError && !isStale(remove.error)
            ? remove.error instanceof ApiError
              ? (remove.error.problem.detail ?? t`It wasn't deleted. Try again.`)
              : t`It wasn't deleted. Check your connection and try again.`
            : opened?.kind === 'delete' && opened.changed
              ? t`Someone changed this task. Check its name above, then delete it again.`
              : undefined
        }
        onClose={close}
        onConfirm={() => {
          if (opened?.kind === 'delete') remove.mutate(opened.task);
        }}
      />
    </Page>
  );
}

/** The round mark of a task's status: filled green with a check when it is done. */
function StatusMark({ done }: { readonly done: boolean }): ReactElement {
  return (
    <span
      aria-hidden
      className={`flex size-5 items-center justify-center rounded-full border ${
        done
          ? 'border-success bg-success text-card'
          : 'border-input bg-card text-transparent group-hover:border-success group-hover:text-success'
      }`}
    >
      <Check className="size-3.5" strokeWidth={2.5} />
    </span>
  );
}

/** The record a task is about, as a link to it: a contact, a company or an opportunity. */
function TaskRecord({ record }: { readonly record: NonNullable<Task['record']> }): ReactElement {
  const business = useBusiness();
  if (record.trashed)
    return (
      <span>
        {record.name}{' '}
        <span className="text-muted-foreground">
          <Trans>(in the trash)</Trans>
        </span>
      </span>
    );
  if (record.id.startsWith('con_'))
    return (
      <Link
        to="/b/$slug/contacts/$contactId"
        params={{ slug: business.slug, contactId: record.id }}
        className={linkClassName}
      >
        {record.name}
      </Link>
    );
  if (record.id.startsWith('com_'))
    return (
      <Link
        to="/b/$slug/contacts/companies/$companyId"
        params={{ slug: business.slug, companyId: record.id }}
        className={linkClassName}
      >
        {record.name}
      </Link>
    );
  return (
    <Link
      to="/b/$slug/deals"
      params={{ slug: business.slug }}
      search={{ deal: record.id }}
      className={linkClassName}
    >
      {record.name}
    </Link>
  );
}
