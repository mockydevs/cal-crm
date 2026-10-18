// What the tasks page's right-hand panel holds, for a new task and for one being edited:
// the fields `createTaskInput` and `updateTaskInput` accept and no others. A task's record
// is chosen when it is made (a contact, found by searching) and never changes afterwards.
// Fetched when the panel first opens, so the list stays light.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  createTask,
  listContacts,
  listTaskAssignees,
  updateTask,
  type Task,
  type TaskRecurrenceInput,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Suspense, useId, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import {
  panelFormClassName,
  sidePanelBodyClassName,
  sidePanelFooterClassName,
} from './conversation-extras-panel';
import { noRejection, type Rejection } from './problems';
import {
  iconButtonClassName,
  isStale,
  ListProblem,
  retryFaults,
  savingProblem,
  useSettled,
} from './settings-list';
import type { RecurrenceProblem } from './task-recurrence-fields';
import { RecurrenceSection } from './task-recurrence-lazy';
import { draftOf, recurrenceOf, seriesRecurrenceOf } from './task-recurrence-rules';
import { dueInstant, localTime, utcOffset } from './task-rules';
import { useBusiness } from './workspace';

const UNASSIGNED = 'none';
const ME = 'me';
/** Someone the task is assigned to who can no longer be chosen: another choice is needed. */
const UNAVAILABLE = 'unavailable';

interface ChosenContact {
  readonly id: string;
  readonly name: string;
}

export function TaskForm({
  task,
  addedBefore,
  onCancel,
  onSaved,
  onLatest,
  onReload,
}: {
  /** The task to edit, or undefined for a new one. */
  readonly task: Task | undefined;
  /** True when this empty form follows a task just added with "Save and add another". */
  readonly addedBefore: boolean;
  readonly onCancel: () => void;
  readonly onSaved: (created: boolean, another: boolean) => Promise<void>;
  /** The task as the server has it now, or nothing when it is no longer in the list. */
  readonly onLatest: (id: string) => Promise<Task | undefined>;
  /** Edit the saved version in place of this draft. */
  readonly onReload: (latest: Task) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  // The version a save replaces: the one opened, or a newer one the draft is kept over.
  const [base, setBase] = useState(task);
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const openingDue = task?.dueAt ?? null;
  const [due, setDue] = useState(() => localTime(openingDue));
  const assigned = task?.assignee ?? null;
  const [assignee, setAssignee] = useState(
    assigned === null ? UNASSIGNED : assigned.you ? ME : (assigned.membershipId ?? UNAVAILABLE),
  );
  const [contact, setContact] = useState<ChosenContact>();
  // A task of a series is edited alone, or with the series' later tasks (GoHighLevel's
  // "single instance" or "all future occurrences").
  const inSeries = task?.recurrence !== undefined;
  const [applyTo, setApplyTo] = useState<'this' | 'series'>('this');
  const [recurrence, setRecurrence] = useState(() => draftOf(task?.recurrence));
  const [recurrenceProblem, setRecurrenceProblem] = useState<RecurrenceProblem>();
  const [contactSearch, setContactSearch] = useState('');
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const contactId = useId();
  const assigneeErrorId = useId();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const people = useInfiniteQuery({
    queryKey: ['b', business.id, 'task-assignees'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      api.request(listTaskAssignees, {
        query: pageParam === undefined ? {} : { after: pageParam },
      }),
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: retryFaults,
  });
  const others = (people.data?.pages.flatMap((page) => page.items) ?? []).filter(
    (person) => !person.you,
  );
  const assignedElsewhere =
    assigned !== null &&
    !assigned.you &&
    assigned.membershipId !== null &&
    !others.some((person) => person.id === assigned.membershipId)
      ? assigned
      : undefined;

  const q = useSettled(contactSearch).trim();
  const found = useQuery({
    queryKey: ['b', business.id, 'task-contact-search', q],
    queryFn: () => api.request(listContacts, { query: { q, limit: 6 } }),
    enabled: task === undefined && contact === undefined && q !== '',
    retry: retryFaults,
  });

  // The due time as an instant: the saved one while its wall time is untouched, so a time
  // that occurs twice when the clocks go back stays the occurrence that was saved.
  const dueAt =
    due === localTime(openingDue) ? openingDue : due === '' ? null : (dueInstant(due) ?? undefined);
  const offset =
    dueAt === null || dueAt === undefined ? undefined : utcOffset(new Date(dueAt), i18n.locale);

  const save = useMutation({
    mutationFn: ({
      at,
      rule,
    }: {
      readonly at: string | null;
      readonly another: boolean;
      /** A new rule; null for none, or to stop a series; left out, the rule is kept. */
      readonly rule: TaskRecurrenceInput | null | undefined;
    }) => {
      const draft = {
        title,
        description,
        dueAt: at,
        assignee: assignee === UNASSIGNED ? null : assignee,
      };
      if (base === undefined)
        return api.request(createTask, {
          body: {
            ...draft,
            recordId: contact?.id ?? null,
            ...(rule === null || rule === undefined ? {} : { recurrence: rule }),
          },
        });
      const repeat =
        inSeries && applyTo === 'series'
          ? { applyTo: 'series' as const, ...(rule === undefined ? {} : { recurrence: rule }) }
          : !inSeries && rule !== null && rule !== undefined
            ? { recurrence: rule }
            : {};
      return api.request(updateTask, {
        params: { id: base.id },
        body: { ...draft, revision: base.revision, ...repeat },
      });
    },
    onSuccess: (_, input) => onSaved(base === undefined, input.another),
    onError: (error) => {
      const refused = savingProblem(
        error,
        t`The task wasn't saved. Check your connection and try again.`,
      );
      setProblem(refused);
      // Whoever was chosen has left the team: read who can be chosen now.
      if (refused.fields['assignee'] !== undefined) void people.refetch();
    },
  });
  // Someone else saved first: the draft can be kept over their version, or given up for it.
  const latest = useMutation({
    mutationFn: async () => {
      if (base === undefined) throw new Error('Nothing saved to read.');
      const saved = await onLatest(base.id);
      if (saved === undefined) throw new Error('The task is no longer in the list.');
      return saved;
    },
    onError: () => {
      setProblem({
        fields: {},
        form: t`The saved version couldn't be loaded. It may have been deleted.`,
      });
    },
  });
  const stale = isStale(save.error) && problem.form !== undefined;
  const pending = save.isPending || latest.isPending;
  const ready = title.trim() !== '' && assignee !== UNAVAILABLE && !pending;

  // What the last Save was refused with shows under its field until that field changes,
  // and every refusal goes when Save is pressed again: a field left as it was is asked
  // about anew, so a refusal never stands between the reader and the next try.
  const forget = (name: string) => {
    setProblem((now) =>
      now.fields[name] === undefined
        ? now
        : {
            form: now.form,
            fields: Object.fromEntries(Object.entries(now.fields).filter(([key]) => key !== name)),
          },
    );
  };
  const refusalOf = (name: string): ReactElement | null =>
    problem.fields[name] === undefined ? null : (
      <FieldError match>{problem.fields[name]}</FieldError>
    );

  const submit = (another: boolean) => {
    if (!ready) return;
    if (dueAt === undefined) {
      setProblem({
        fields: { dueAt: t`This time doesn't exist in ${timeZone}. Choose another time.` },
        form: undefined,
      });
      return;
    }
    // A series' rule is sent only when the draft changed it, so the schedule stays put.
    const rule =
      task?.recurrence === undefined
        ? recurrenceOf(recurrence)
        : seriesRecurrenceOf(task.recurrence, recurrence);
    const asked = !inSeries || applyTo === 'series';
    if (asked && !rule.ok) {
      setRecurrenceProblem(rule.field);
      return;
    }
    const value = asked && rule.ok ? rule.value : undefined;
    if (value !== null && value !== undefined && dueAt === null) {
      setRecurrenceProblem('due');
      return;
    }
    setRecurrenceProblem(undefined);
    setProblem(noRejection);
    save.mutate({ at: dueAt, another, rule: value });
  };

  return (
    <form
      className={`flex flex-col ${panelFormClassName}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
    >
      <div className={sidePanelBodyClassName}>
        {addedBefore ? (
          <p role="status" className="text-sm text-success">
            <Trans>Task added. Add another, or close the panel.</Trans>
          </p>
        ) : null}
        <Field name="title" invalid={problem.fields['title'] !== undefined}>
          <FieldLabel>
            <Trans>Title</Trans>
          </FieldLabel>
          <Input
            required
            maxLength={300}
            autoComplete="off"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              forget('title');
            }}
          />
          {refusalOf('title')}
        </Field>
        <Field name="description" invalid={problem.fields['description'] !== undefined}>
          <FieldLabel>
            <Trans>Description</Trans>
          </FieldLabel>
          <Textarea
            rows={4}
            maxLength={10000}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              forget('description');
            }}
          />
          {refusalOf('description')}
        </Field>
        <Field
          name="dueAt"
          invalid={problem.fields['dueAt'] !== undefined || recurrenceProblem === 'due'}
        >
          <FieldLabel>
            <Trans>Due date and time ({timeZone})</Trans>
          </FieldLabel>
          <Input
            type="datetime-local"
            step="any"
            min="0001-01-01T00:00"
            max="9999-12-31T23:59:59.999"
            value={due}
            onChange={(event) => {
              setDue(event.target.value);
              forget('dueAt');
            }}
          />
          {offset === undefined ? null : (
            <FieldDescription>
              <Trans>UTC offset: {offset}</Trans>
            </FieldDescription>
          )}
          {refusalOf('dueAt')}
        </Field>
        <Suspense fallback={null}>
          <RecurrenceSection
            inSeries={inSeries}
            applyTo={applyTo}
            onApplyTo={setApplyTo}
            draft={recurrence}
            onChange={(next) => {
              setRecurrence(next);
              setRecurrenceProblem(undefined);
              forget('recurrence');
            }}
            problem={recurrenceProblem}
            serverProblems={problem.fields}
          />
        </Suspense>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          <Trans>Assign to</Trans>
          <Select
            aria-label={t`Assign to`}
            {...(problem.fields['assignee'] === undefined
              ? {}
              : { 'aria-describedby': assigneeErrorId })}
            value={assignee}
            onValueChange={(next) => {
              setAssignee(next);
              forget('assignee');
            }}
          >
            <option value={UNASSIGNED}>{t`Unassigned`}</option>
            <option value={ME}>{t`You`}</option>
            {assignee === UNAVAILABLE ? (
              <option value={UNAVAILABLE} disabled>
                {t`Choose a person`}
              </option>
            ) : null}
            {assignedElsewhere === undefined ? null : (
              <option value={assignedElsewhere.membershipId ?? UNAVAILABLE}>
                {assignedElsewhere.name ?? t`Unavailable person`}
              </option>
            )}
            {others.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name ?? t`Unavailable person`}
              </option>
            ))}
          </Select>
        </label>
        {problem.fields['assignee'] === undefined ? null : (
          <p id={assigneeErrorId} role="alert" className="text-sm font-medium text-destructive">
            {problem.fields['assignee']}
          </p>
        )}
        {assignee === UNAVAILABLE ? (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>The assigned person is unavailable. Choose someone or Unassigned.</Trans>
          </p>
        ) : null}
        {people.isError ? (
          <ListProblem
            onRetry={() => {
              void people.refetch();
            }}
          >
            <Trans>People couldn't be loaded. Your draft is still here.</Trans>
          </ListProblem>
        ) : null}
        {people.hasNextPage ? (
          <Button
            variant="quiet"
            size="small"
            className="self-start"
            disabled={people.isFetching}
            onClick={() => {
              void people.fetchNextPage();
            }}
          >
            <Trans>Load more people</Trans>
          </Button>
        ) : null}
        {task === undefined ? (
          <div className="flex flex-col gap-1.5">
            {contact === undefined ? (
              <>
                <label htmlFor={contactId} className="text-sm font-medium">
                  <Trans>Contact</Trans>
                </label>
                <Input
                  id={contactId}
                  type="search"
                  autoComplete="off"
                  maxLength={200}
                  placeholder={t`Search contacts`}
                  value={contactSearch}
                  onChange={(event) => {
                    setContactSearch(event.target.value);
                  }}
                />
                <p className="text-sm leading-normal text-muted-foreground">
                  <Trans>
                    Optional. The task shows on this contact's page, and the contact can't be
                    changed afterwards.
                  </Trans>
                </p>
                {found.isError ? (
                  <ListProblem
                    onRetry={() => {
                      void found.refetch();
                    }}
                  >
                    <Trans>Contacts couldn't be searched.</Trans>
                  </ListProblem>
                ) : null}
                {found.data === undefined || q === '' ? null : found.data.items.length === 0 ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    <Trans>No contacts match.</Trans>
                  </p>
                ) : (
                  <ul
                    aria-label={t`Matching contacts`}
                    className="flex flex-col rounded-lg border border-border"
                  >
                    {found.data.items.map((each) => {
                      const name = each.name ?? each.email ?? t`Unnamed`;
                      return (
                        <li key={each.id} className="border-t border-border first:border-t-0">
                          <button
                            type="button"
                            className="flex min-h-11 w-full flex-col items-start justify-center rounded-control px-3 py-1.5 text-left text-md -outline-offset-2 hover:bg-muted lg:min-h-9"
                            onClick={() => {
                              setContact({ id: each.id, name });
                              setContactSearch('');
                            }}
                          >
                            <span className="wrap-anywhere text-foreground">{name}</span>
                            {each.email === null || each.email === name ? null : (
                              <span className="text-xs wrap-anywhere text-muted-foreground">
                                {each.email}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            ) : (
              <>
                <span className="text-sm font-medium">
                  <Trans>Contact</Trans>
                </span>
                <ChosenRecord
                  name={contact.name}
                  onRemove={() => {
                    setContact(undefined);
                  }}
                />
              </>
            )}
          </div>
        ) : task.record === null ? null : (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">
              <Trans>Associated record</Trans>
            </span>
            <p className="text-md wrap-anywhere text-foreground">{task.record.name}</p>
            <p className="text-sm leading-normal text-muted-foreground">
              <Trans>A task stays with the record it was made for.</Trans>
            </p>
          </div>
        )}
        {problem.form === undefined ? null : (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm font-medium text-destructive">
              {problem.form}
            </p>
            {stale ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  disabled={pending}
                  onClick={() => {
                    latest.mutate(undefined, {
                      onSuccess: (saved) => {
                        setBase(saved);
                        save.reset();
                        setProblem(noRejection);
                      },
                    });
                  }}
                >
                  <Trans>Keep my draft</Trans>
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={pending}
                  onClick={() => {
                    latest.mutate(undefined, { onSuccess: onReload });
                  }}
                >
                  <Trans>Reload saved version</Trans>
                </Button>
              </div>
            ) : null}
            {stale ? (
              <p className="text-sm text-muted-foreground">
                <Trans>
                  Keeping your draft replaces the other person's changes when you save again.
                </Trans>
              </p>
            ) : null}
          </div>
        )}
      </div>
      <div className={sidePanelFooterClassName}>
        <Button
          variant="secondary"
          className="mr-auto"
          disabled={save.isPending}
          onClick={() => {
            onCancel();
          }}
        >
          <Trans>Cancel</Trans>
        </Button>
        {task === undefined ? (
          <Button
            variant="secondary"
            disabled={!ready}
            onClick={(event) => {
              // Not the form's own button, so the browser's checks are asked for here.
              if (event.currentTarget.form?.reportValidity() !== false) submit(true);
            }}
          >
            <Trans>Save and add another</Trans>
          </Button>
        ) : null}
        <Button type="submit" disabled={!ready}>
          <Trans>Save</Trans>
        </Button>
      </div>
    </form>
  );
}

/** The contact a new task is for, with the way to take it off again. */
function ChosenRecord({
  name,
  onRemove,
}: {
  readonly name: string;
  readonly onRemove: () => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <div className="flex min-h-11 items-center justify-between gap-2 rounded-control border border-input bg-card pl-3 lg:min-h-9">
      <span className="min-w-0 text-md wrap-anywhere text-foreground">{name}</span>
      <button
        type="button"
        className={iconButtonClassName}
        aria-label={t`Remove ${name}`}
        onClick={onRemove}
      >
        <X aria-hidden className="size-4" strokeWidth={1.8} />
      </button>
    </div>
  );
}
