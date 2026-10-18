import { Select } from '@repo/ui/components/select';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createTask,
  updateTask,
  completeTask,
  deleteTask,
  listTasks,
  listTaskAssignees,
  type Task,
  type TaskRecurrenceInput,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ClipboardCheck } from 'lucide-react';
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { apiIn } from './api';
import { ContactPanel, PanelEmpty } from './contact-panels';
import { useBusiness } from './workspace';
import { useActorLabel } from './activity';
import type { RecurrenceProblem } from './task-recurrence-fields';
// The recurrence parts load with their words when first drawn, so the contact page stays light.
import { RecurrenceMark, RecurrenceSection, SeriesDeleteChoice } from './task-recurrence-lazy';
import { draftOf, recurrenceOf, seriesRecurrenceOf } from './task-recurrence-rules';
import { localTime, utcOffset } from './task-rules';

const controlClassName =
  'min-h-11 min-w-0 rounded-control border border-input bg-card px-3 text-md';

function cursorChanged(error: Error | null): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    error.problem.errors?.some((each) => each.path === '/after') === true
  );
}

function retryRead(failures: number, error: Error): boolean {
  return failures < 3 && !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

interface TaskDraft {
  readonly title: string;
  readonly description: string;
  readonly dueAt: string | null;
  readonly assignee: string | null;
  /** A new rule, or null to stop a series; left out, the rule is not touched. */
  readonly recurrence?: TaskRecurrenceInput | null;
  readonly applyTo?: 'series';
}

function TaskForm({
  task,
  pending,
  readOnly,
  onSave,
  onCancel,
  assignToMe = false,
  rejectedAssignee,
}: {
  readonly task: Task | undefined;
  readonly pending: boolean;
  readonly readOnly: boolean;
  readonly onSave: (draft: TaskDraft) => void;
  readonly onCancel: () => void;
  readonly assignToMe?: boolean;
  readonly rejectedAssignee: string | undefined;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [openingDue] = useState(task?.dueAt ?? null);
  const [due, setDue] = useState(() => localTime(openingDue));
  const [dueError, setDueError] = useState('');
  const dueRef = useRef<HTMLInputElement>(null);
  const dueErrorId = useId();
  const [assigned] = useState(task?.assignee ?? null);
  const selectedMembership = assigned?.membershipId ?? null;
  const [assignee, setAssignee] = useState(
    assigned === null
      ? task === undefined && assignToMe
        ? 'me'
        : ''
      : assigned.you
        ? 'me'
        : (assigned.membershipId ?? 'unavailable'),
  );
  const [seenRejection, setSeenRejection] = useState<string>();
  const [rejected, setRejected] = useState<readonly string[]>([]);
  if (rejectedAssignee !== undefined && rejectedAssignee !== seenRejection) {
    setSeenRejection(rejectedAssignee);
    setRejected([...rejected, rejectedAssignee]);
    setAssignee('unavailable');
  }
  const inSeries = task?.recurrence !== undefined;
  const [applyTo, setApplyTo] = useState<'this' | 'series'>('this');
  const [recurrence, setRecurrence] = useState(() => draftOf(task?.recurrence));
  const [recurrenceProblem, setRecurrenceProblem] = useState<RecurrenceProblem>();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const selectedDue = new Date(
    due === localTime(openingDue) && openingDue !== null ? openingDue : due,
  );
  const selectedWall = new Date(`${due}Z`);
  const selectedOffset =
    due !== '' &&
    Number.isFinite(selectedDue.getTime()) &&
    Number.isFinite(selectedWall.getTime()) &&
    localTime(selectedDue.toISOString()) === selectedWall.toISOString().slice(0, -1)
      ? utcOffset(selectedDue, i18n.locale)
      : undefined;
  const people = useInfiniteQuery({
    queryKey: ['b', business.id, 'task-assignees'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(business.id).request(listTaskAssignees, {
        query: pageParam === undefined ? {} : { after: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !readOnly,
    retry: retryRead,
  });
  const titleRef = useRef<HTMLInputElement>(null);
  const assigneeRef = useRef<HTMLButtonElement>(null);
  const peopleTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = peopleTriggerRef.current;
    if (trigger === null || people.isFetching) return;
    peopleTriggerRef.current = null;
    if (
      !people.hasNextPage &&
      !people.isError &&
      (document.activeElement === trigger || document.activeElement === document.body)
    )
      assigneeRef.current?.focus();
  }, [people.data, people.isFetching, people.hasNextPage, people.isError]);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || readOnly || assignee === 'unavailable') return;
        let dueAt = openingDue;
        if (due !== localTime(openingDue)) {
          if (due === '') dueAt = null;
          else {
            const instant = new Date(due);
            const wall = new Date(`${due}Z`);
            if (
              !Number.isFinite(instant.getTime()) ||
              !Number.isFinite(wall.getTime()) ||
              localTime(instant.toISOString()) !== wall.toISOString().slice(0, -1)
            ) {
              setDueError(t`This time doesn't exist in ${timezone}. Choose another time.`);
              dueRef.current?.focus();
              return;
            }
            dueAt = instant.toISOString();
          }
        }
        setDueError('');
        const asked = !inSeries || applyTo === 'series';
        // A series' rule is sent only when the draft changed it, so the schedule stays put.
        const rule =
          task?.recurrence === undefined
            ? recurrenceOf(recurrence)
            : seriesRecurrenceOf(task.recurrence, recurrence);
        if (asked && !rule.ok) {
          setRecurrenceProblem(rule.field);
          return;
        }
        const value = asked && rule.ok ? rule.value : undefined;
        if (value !== null && value !== undefined && dueAt === null) {
          setRecurrenceProblem('due');
          dueRef.current?.focus();
          return;
        }
        setRecurrenceProblem(undefined);
        onSave({
          title,
          description,
          dueAt,
          assignee: assignee || null,
          ...(inSeries && applyTo === 'series'
            ? { applyTo: 'series' as const, ...(value === undefined ? {} : { recurrence: value }) }
            : !inSeries && value !== null && value !== undefined
              ? { recurrence: value }
              : {}),
        });
      }}
    >
      <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
        <Trans>Task title</Trans>
        <input
          ref={titleRef}
          required
          maxLength={300}
          value={title}
          disabled={pending || readOnly}
          className={controlClassName}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
        <Trans>Description</Trans>
        <textarea
          maxLength={10000}
          rows={3}
          value={description}
          disabled={pending || readOnly}
          className={`${controlClassName} py-2`}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
        <Trans>Due date</Trans>
        <input
          ref={dueRef}
          type="datetime-local"
          step="any"
          min="0001-01-01T00:00"
          max="9999-12-31T23:59:59.999"
          aria-invalid={dueError !== '' || recurrenceProblem === 'due'}
          aria-describedby={dueError === '' ? undefined : dueErrorId}
          value={due}
          disabled={pending || readOnly}
          className={controlClassName}
          onChange={(event) => {
            setDue(event.target.value);
            setDueError('');
          }}
        />
      </label>
      {dueError === '' ? null : (
        <p id={dueErrorId} role="alert" className="text-sm text-destructive">
          {dueError}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        <Trans>Times use {timezone}.</Trans>
      </p>
      {selectedOffset === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          <Trans>UTC offset: {selectedOffset}</Trans>
        </p>
      )}
      {readOnly ? null : (
        <Suspense fallback={null}>
          <RecurrenceSection
            inSeries={inSeries}
            applyTo={applyTo}
            onApplyTo={setApplyTo}
            draft={recurrence}
            onChange={(next) => {
              setRecurrence(next);
              setRecurrenceProblem(undefined);
            }}
            problem={recurrenceProblem}
            disabled={pending}
          />
        </Suspense>
      )}
      <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
        <Trans>Assigned to</Trans>
        <Select
          ref={assigneeRef}
          value={assignee}
          disabled={pending || readOnly}
          className={controlClassName}
          onValueChange={(selectedValue) => {
            setAssignee(selectedValue);
          }}
        >
          <option value="">
            <Trans>Unassigned</Trans>
          </option>
          <option value="me" disabled={rejected.includes('me')}>
            <Trans>You</Trans>
          </option>
          {assignee === 'unavailable' ? (
            <option value="unavailable" disabled>
              <Trans>Choose a person</Trans>
            </option>
          ) : null}
          {selectedMembership !== null &&
          !rejected.includes(selectedMembership) &&
          !(assigned?.you === true && rejected.includes('me')) &&
          !people.data?.pages.some((page) =>
            page.items.some((person) => person.id === selectedMembership),
          ) ? (
            <option value={selectedMembership}>{assigned?.name ?? t`Unavailable person`}</option>
          ) : null}
          {people.data?.pages
            .flatMap((page) => page.items)
            .filter((person) => !person.you && !rejected.includes(person.id))
            .map((person) => (
              <option key={person.id} value={person.id}>
                {person.name ?? t`Unavailable person`}
              </option>
            ))}
        </Select>
      </label>
      {assignee === 'unavailable' ? (
        <p role="status" className="text-sm">
          <Trans>The assigned person is unavailable. Choose someone or Unassigned.</Trans>
        </p>
      ) : null}
      {people.isPending && !readOnly ? (
        <p aria-live="polite">
          <Trans>Loading people…</Trans>
        </p>
      ) : null}
      {people.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>
            <Trans>People couldn't be loaded. Your draft is still here.</Trans>
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={people.isFetching}
            onClick={(event) => {
              if (people.isFetchNextPageError) peopleTriggerRef.current = event.currentTarget;
              void (people.isFetchNextPageError && !cursorChanged(people.error)
                ? people.fetchNextPage()
                : people.refetch());
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {people.hasNextPage ? (
        <Button
          type="button"
          variant="quiet"
          disabled={people.isFetching || pending || readOnly}
          onClick={(event) => {
            peopleTriggerRef.current = event.currentTarget;
            void people.fetchNextPage();
          }}
        >
          <Trans>Load more people</Trans>
        </Button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || readOnly || assignee === 'unavailable'}>
          <Trans>Save task</Trans>
        </Button>
        <Button type="button" variant="quiet" disabled={pending} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </form>
  );
}

export function RecordTasks({
  recordId,
  readOnly = false,
}: {
  readonly recordId: string;
  readonly readOnly?: boolean;
}): ReactElement {
  return <TaskPanel recordId={recordId} readOnly={readOnly} />;
}

export function OverdueTasks(): ReactElement {
  return <TaskPanel overdue />;
}

function TaskPanel({
  recordId,
  readOnly = false,
  overdue = false,
}: {
  readonly recordId?: string;
  readonly readOnly?: boolean;
  readonly overdue?: boolean;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const [editor, setEditor] = useState<{ readonly task: Task | undefined }>();
  const [confirming, setConfirming] = useState<Task>();
  // Deleting a task of a series: that task alone, or it and the series' upcoming tasks.
  const [wholeSeries, setWholeSeries] = useState(false);
  const [notice, setNotice] = useState('');
  const [rejectedAssignee, setRejectedAssignee] = useState<string>();
  const addRef = useRef<HTMLButtonElement>(null);
  const editorRegionRef = useRef<HTMLDivElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const refreshTriggerRef = useRef<HTMLButtonElement>(null);
  const keepTaskRef = useRef<HTMLButtonElement>(null);
  const lastTaskRef = useRef<HTMLLIElement>(null);
  const loadTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<string | undefined>(undefined);
  const actionsRef = useRef(new Map<string, HTMLButtonElement>());
  const actorLabel = useActorLabel();
  const focusKeep = useCallback((button: HTMLButtonElement | null) => {
    keepTaskRef.current = button;
    button?.focus();
  }, []);
  const key = [
    'b',
    business.id,
    'tasks',
    recordId ?? 'mine',
    recordId === undefined ? 'open' : 'all',
    overdue,
  ];
  const tasks = useInfiniteQuery({
    retry: retryRead,
    queryKey: key,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      apiIn(business.id).request(listTasks, {
        query: {
          ...(recordId === undefined
            ? {
                scope: 'mine' as const,
                status: 'open' as const,
                ...(overdue ? { due: 'overdue' as const } : {}),
              }
            : { recordId, status: 'all' as const }),
          ...(pageParam === undefined ? {} : { after: pageParam }),
        },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const canManage = tasks.data?.pages[0]?.canManage === true && !readOnly;
  const items: readonly Task[] = tasks.data?.pages.flatMap((page) => page.items) ?? [];
  useEffect(() => {
    const trigger = loadTriggerRef.current;
    if (trigger === null || tasks.isFetching) return;
    loadTriggerRef.current = null;
    if (
      !tasks.hasNextPage &&
      !tasks.isError &&
      (document.activeElement === trigger || document.activeElement === document.body)
    )
      lastTaskRef.current?.focus();
  }, [tasks.data, tasks.isFetching, tasks.hasNextPage, tasks.isError]);
  const latest =
    editor?.task === undefined ? undefined : items.find((task) => task.id === editor.task?.id);
  const canSave =
    canManage &&
    (editor?.task === undefined || (latest !== undefined && latest.record?.trashed !== true));
  const newer =
    latest !== undefined && latest.revision !== editor?.task?.revision ? latest : undefined;
  const latestDeletion =
    confirming === undefined ? undefined : items.find((task) => task.id === confirming.id);
  const canDelete =
    canManage && latestDeletion !== undefined && latestDeletion.record?.trashed !== true;
  const newerDeletion =
    latestDeletion !== undefined && latestDeletion.revision !== confirming?.revision
      ? latestDeletion
      : undefined;
  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['b', business.id, 'tasks'] }),
      cache.invalidateQueries({
        queryKey:
          recordId === undefined
            ? ['b', business.id, 'activity']
            : ['b', business.id, 'activity', recordId],
      }),
    ]);
  };
  const refreshPermission = async (error: Error) => {
    if (error instanceof ApiError && error.status === 403) {
      await cache.invalidateQueries({ queryKey: ['b', business.id, 'tasks'] });
    }
  };
  const save = useMutation({
    mutationFn: ({ draft, task }: { draft: TaskDraft; task: Task | undefined }) =>
      task === undefined
        ? apiIn(business.id).request(createTask, {
            body: {
              title: draft.title,
              description: draft.description,
              dueAt: draft.dueAt,
              assignee: draft.assignee,
              recordId: recordId ?? null,
              ...(draft.recurrence === undefined || draft.recurrence === null
                ? {}
                : { recurrence: draft.recurrence }),
            },
          })
        : apiIn(business.id).request(updateTask, {
            params: { id: task.id },
            body: { ...draft, revision: task.revision },
          }),
    onSuccess: async (_, input) => {
      await refresh();
      restoreFocusRef.current = input.task === undefined ? 'add' : `edit:${input.task.id}`;
      setEditor(undefined);
      setNotice(input.task === undefined ? t`Task added.` : t`Task updated.`);
    },
    onError: async (error, input) => {
      if (
        error instanceof ApiError &&
        error.problem.errors?.some((each) => each.code === 'unavailable_assignee') === true
      ) {
        setRejectedAssignee(input.draft.assignee ?? undefined);
        void cache.invalidateQueries({ queryKey: ['b', business.id, 'task-assignees'] });
      }
      await refreshPermission(error);
      restoreFocusRef.current =
        error instanceof ApiError && error.status === 403 ? 'refresh' : 'editor';
    },
  });
  const complete = useMutation({
    onError: async (error, task) => {
      await refreshPermission(error);
      restoreFocusRef.current =
        error instanceof ApiError && error.status === 403 ? 'refresh' : `complete:${task.id}`;
    },
    mutationFn: (task: Task) =>
      apiIn(business.id).request(completeTask, {
        params: { id: task.id },
        body: { completed: task.completedAt === null, revision: task.revision },
      }),
    onSuccess: async (_, task) => {
      await refresh();
      restoreFocusRef.current = `complete:${task.id}`;
      setNotice(task.completedAt === null ? t`Task completed.` : t`Task reopened.`);
    },
  });
  const remove = useMutation({
    onError: async (error) => {
      await refreshPermission(error);
      restoreFocusRef.current = 'keep';
    },
    mutationFn: (task: Task) =>
      apiIn(business.id).request(deleteTask, {
        params: { id: task.id },
        body: {
          revision: task.revision,
          ...(wholeSeries && task.recurrence !== undefined ? { applyTo: 'series' as const } : {}),
        },
      }),
    onSuccess: async () => {
      await refresh();
      restoreFocusRef.current = 'add';
      setConfirming(undefined);
      setNotice(t`Task deleted.`);
    },
  });
  const busy = save.isPending || complete.isPending || remove.isPending;
  useEffect(() => {
    const trigger = refreshTriggerRef.current;
    if (trigger === null || tasks.isFetching || busy) return;
    refreshTriggerRef.current = null;
    if (document.activeElement === trigger || document.activeElement === document.body)
      trigger.focus();
  }, [tasks.data, tasks.error, tasks.isFetching, busy]);
  useEffect(() => {
    if (!busy && restoreFocusRef.current !== undefined) {
      const target = restoreFocusRef.current;
      restoreFocusRef.current = undefined;
      let element: HTMLElement | null =
        actionsRef.current.get(target) ?? addRef.current ?? refreshRef.current;
      if (target === 'refresh') element = refreshRef.current;
      if (target === 'keep') element = keepTaskRef.current;
      if (target === 'editor')
        element =
          editorRegionRef.current?.querySelector('input:not(:disabled)') ?? refreshRef.current;
      element?.focus();
    }
  }, [editor, confirming, busy]);
  const dates = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  // The one way to add a task: beside the title, or in the empty panel's own words.
  const add =
    canManage && editor === undefined && !overdue ? (
      <Button
        ref={addRef}
        variant="secondary"
        size="small"
        disabled={busy || confirming !== undefined}
        onClick={() => {
          save.reset();
          setNotice('');
          setRejectedAssignee(undefined);
          setEditor({ task: undefined });
        }}
      >
        <Trans>Add task</Trans>
      </Button>
    ) : null;
  const none = tasks.data !== undefined && items.length === 0;
  // A record's own tasks, with none yet: the panel says so and offers the first.
  const noneYet = none && recordId !== undefined;
  return (
    <ContactPanel title={overdue ? t`Overdue tasks` : t`Tasks`} action={noneYet ? null : add}>
      <Button
        ref={refreshRef}
        variant="quiet"
        size="small"
        className="self-start"
        disabled={tasks.isFetching || busy}
        onClick={(event) => {
          refreshTriggerRef.current = event.currentTarget;
          void tasks.refetch();
        }}
      >
        <Trans>Refresh tasks</Trans>
      </Button>
      {tasks.isPending ? (
        <p aria-live="polite">
          <Trans>Loading tasks…</Trans>
        </p>
      ) : null}
      {tasks.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>
            <Trans>Tasks couldn't be loaded.</Trans>
          </p>
          <Button
            variant="secondary"
            size="small"
            onClick={(event) => {
              if (tasks.isFetchNextPageError) loadTriggerRef.current = event.currentTarget;
              void (tasks.isFetchNextPageError && !cursorChanged(tasks.error)
                ? tasks.fetchNextPage()
                : tasks.refetch());
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : null}
      {noneYet ? (
        <PanelEmpty
          icon={<ClipboardCheck />}
          title={t`No tasks yet.`}
          description={t`Stay organized by creating the first task.`}
          action={add}
        />
      ) : none ? (
        <p className="text-sm text-muted-foreground">
          {overdue ? t`No overdue tasks.` : t`No tasks yet.`}
        </p>
      ) : null}
      <ol className="flex min-w-0 flex-col divide-y divide-border">
        {items.map((task) => {
          const person =
            task.assignee?.you === true ? t`You` : (task.assignee?.name ?? t`Unavailable person`);
          const completedBy = task.completedBy === null ? null : actorLabel(task.completedBy);
          return (
            <li
              key={task.id}
              ref={task.id === items.at(-1)?.id ? lastTaskRef : undefined}
              tabIndex={-1}
              className="flex min-w-0 flex-col gap-2 py-4 first:pt-0 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <p className="break-words font-medium">
                {task.title}
                {task.recurrence === undefined ? null : (
                  <Suspense fallback={null}>
                    <RecurrenceMark
                      recurrence={task.recurrence}
                      format={(date) => dates.format(date)}
                    />
                  </Suspense>
                )}
              </p>
              {recordId === undefined && task.record !== null ? (
                <TaskRecordLink record={task.record} />
              ) : null}
              {task.description === '' ? null : (
                <p className="whitespace-pre-wrap break-words text-sm">{task.description}</p>
              )}
              <p className="text-sm text-muted-foreground">
                {task.assignee === null ? t`Unassigned` : t`Assigned to ${person}`}
              </p>
              {task.dueAt === null ? null : (
                <p className="text-sm text-muted-foreground">
                  <Trans>Due</Trans>{' '}
                  <time dateTime={task.dueAt}>
                    {dates.format(new Date(task.dueAt))} (
                    {utcOffset(new Date(task.dueAt), i18n.locale)})
                  </time>
                </p>
              )}
              {completedBy === null ? null : (
                <p className="text-sm text-muted-foreground">{t`Completed by ${completedBy}`}</p>
              )}
              {canManage && task.record?.trashed !== true ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    ref={(button) => {
                      if (button !== null) actionsRef.current.set(`complete:${task.id}`, button);
                      else actionsRef.current.delete(`complete:${task.id}`);
                    }}
                    size="small"
                    variant="secondary"
                    disabled={busy || editor !== undefined || confirming !== undefined}
                    onClick={() => {
                      complete.reset();
                      setNotice('');
                      complete.mutate(task);
                    }}
                  >
                    {task.completedAt === null ? t`Complete task` : t`Reopen task`}
                  </Button>
                  <Button
                    ref={(button) => {
                      if (button !== null) actionsRef.current.set(`edit:${task.id}`, button);
                      else actionsRef.current.delete(`edit:${task.id}`);
                    }}
                    size="small"
                    variant="quiet"
                    disabled={busy || editor !== undefined || confirming !== undefined}
                    onClick={() => {
                      save.reset();
                      complete.reset();
                      remove.reset();
                      setNotice('');
                      setRejectedAssignee(undefined);
                      setEditor({ task });
                    }}
                  >
                    <Trans>Edit task</Trans>
                  </Button>
                  <Button
                    ref={(button) => {
                      if (button !== null) actionsRef.current.set(`delete:${task.id}`, button);
                      else actionsRef.current.delete(`delete:${task.id}`);
                    }}
                    size="small"
                    variant="quiet"
                    disabled={busy || editor !== undefined || confirming !== undefined}
                    onClick={() => {
                      remove.reset();
                      complete.reset();
                      setNotice('');
                      setWholeSeries(false);
                      setConfirming(task);
                    }}
                  >
                    <Trans>Delete task</Trans>
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {tasks.hasNextPage ? (
        <Button
          variant="secondary"
          disabled={tasks.isFetching}
          onClick={(event) => {
            loadTriggerRef.current = event.currentTarget;
            void tasks.fetchNextPage();
          }}
        >
          <Trans>Load older tasks</Trans>
        </Button>
      ) : null}
      {editor !== undefined && newer !== undefined ? (
        <div
          role="group"
          aria-label={t`Review the newer task`}
          className="flex flex-col gap-3 rounded-control border border-border p-4"
        >
          <p className="text-sm">
            <Trans>
              A newer version is saved. Review it above. Keeping your draft will replace its details
              on your next save.
            </Trans>
          </p>
          <Button
            variant="secondary"
            disabled={busy || !canSave}
            onClick={() => {
              setEditor({ task: newer });
              save.reset();
              editorRegionRef.current?.querySelector('input')?.focus();
            }}
          >
            <Trans>Keep my draft</Trans>
          </Button>
        </div>
      ) : null}
      {editor !== undefined ? (
        <div ref={editorRegionRef}>
          <TaskForm
            key={editor.task?.id ?? 'new'}
            task={editor.task}
            pending={save.isPending}
            readOnly={!canSave}
            assignToMe={recordId === undefined}
            rejectedAssignee={rejectedAssignee}
            onSave={(draft) => {
              if (canSave) save.mutate({ draft, task: editor.task });
            }}
            onCancel={() => {
              restoreFocusRef.current =
                editor.task === undefined ? 'add' : `edit:${editor.task.id}`;
              setEditor(undefined);
              save.reset();
            }}
          />
        </div>
      ) : null}
      {confirming === undefined ? null : (
        <div
          key={confirming.revision}
          role="group"
          aria-label={t`Delete this task?`}
          className="flex flex-col gap-3 rounded-control border border-border p-4"
        >
          <p>
            <Trans>Delete this task? This can't be undone.</Trans>
          </p>
          <p className="break-words text-sm text-muted-foreground">{confirming.title}</p>
          {confirming.recurrence === undefined ? null : (
            <Suspense fallback={null}>
              <SeriesDeleteChoice checked={wholeSeries} disabled={busy} onChange={setWholeSeries} />
            </Suspense>
          )}
          {newerDeletion === undefined ? null : (
            <>
              <p>
                <Trans>This task changed. Review the saved task above before deleting it.</Trans>
              </p>
              <Button
                variant="secondary"
                disabled={busy || !canDelete}
                onClick={() => {
                  setConfirming(newerDeletion);
                  remove.reset();
                }}
              >
                <Trans>Review deletion</Trans>
              </Button>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="small"
              disabled={busy || !canDelete || newerDeletion !== undefined}
              onClick={() => {
                if (canDelete && newerDeletion === undefined) remove.mutate(confirming);
              }}
            >
              <Trans>Confirm deletion</Trans>
            </Button>
            <Button
              ref={focusKeep}
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                restoreFocusRef.current = `delete:${confirming.id}`;
                setConfirming(undefined);
                remove.reset();
              }}
            >
              <Trans>Keep task</Trans>
            </Button>
          </div>
        </div>
      )}
      {editor !== undefined && !canSave ? (
        <p role="status">
          <Trans>Tasks are read-only here. Your draft is still here.</Trans>
        </p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {save.error instanceof ApiError
            ? (save.error.problem.errors?.[0]?.message ?? save.error.message)
            : t`The task wasn't saved. Check your connection and try again.`}
        </p>
      ) : null}
      {complete.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {complete.error instanceof ApiError
            ? complete.error.message
            : t`The task wasn't changed. Check your connection and try again.`}
        </p>
      ) : null}
      {remove.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {remove.error instanceof ApiError
            ? remove.error.message
            : t`The task wasn't deleted. Check your connection and try again.`}
        </p>
      ) : null}
      <p role="status" className="text-sm empty:sr-only">
        {notice}
      </p>
    </ContactPanel>
  );
}

function TaskRecordLink({
  record,
}: {
  readonly record: NonNullable<Task['record']>;
}): ReactElement {
  const business = useBusiness();
  const className = 'self-start break-words text-sm text-primary underline underline-offset-4';
  const name = record.name;
  if (record.id.startsWith('con_'))
    return (
      <Link
        to="/b/$slug/contacts/$contactId"
        params={{ slug: business.slug, contactId: record.id }}
        className={className}
      >
        {name}
      </Link>
    );
  if (record.id.startsWith('com_'))
    return (
      <Link
        to="/b/$slug/contacts/companies/$companyId"
        params={{ slug: business.slug, companyId: record.id }}
        className={className}
      >
        {name}
      </Link>
    );
  return (
    <Link
      to="/b/$slug/deals"
      params={{ slug: business.slug }}
      search={{ deal: record.id }}
      className={className}
    >
      {name}
    </Link>
  );
}
