// Conversations → Manual Actions (laid out as GoHighLevel's): the calls to place and texts
// to send by hand that a workflow's manual steps leave for a person. The queue is the
// server's, oldest first, a page at a time, filtered there. Completing or skipping an
// action lets its workflow go on; neither sends or dials anything. The server says who may
// work the queue (canWork) and who may give an action to someone else (canAssign).
import { Trans, useLingui } from '@lingui/react/macro';
import {
  assignManualAction,
  completeManualAction,
  getManualAction,
  listManualActions,
  manualActionStatuses,
  manualActionTypes,
  skipManualAction,
  type ManualAction,
  type ManualActionStatus,
  type ManualActionType,
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
import { CircleCheck, MessageSquare, Phone } from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { apiIn } from './api';
import {
  ContactName,
  linkClassName,
  RightPanel,
  sidePanelBodyClassName,
  sidePanelFooterClassName,
} from './conversation-extras-panel';
import { assigneeChoice, assigneeInput, nextPending } from './conversation-extras-rules';
import { teammatesOf, useAssignees } from './inbox-assignees';
import {
  cellClassName,
  headerCellClassName,
  listCardClassName,
  ListFooter,
  ListProblem,
  retryFaults,
  tableClassName,
  tableRegionClassName,
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
import { useBusiness } from './workspace';

const ANY = 'any';
type StatusFilter = ManualActionStatus | 'all';
const statusFilters: readonly StatusFilter[] = [...manualActionStatuses, 'all'];

const actionsKey = (businessId: string) => ['b', businessId, 'manual-actions'] as const;

interface Person {
  readonly id: string;
  readonly name: string | null;
}

function useWords(): {
  readonly types: Record<ManualActionType, string>;
  readonly statuses: Record<ManualActionStatus, string>;
} {
  const { t } = useLingui();
  return {
    types: { call: t`Call`, sms: t`SMS` },
    statuses: {
      pending: t`Pending`,
      completed: t`Completed`,
      skipped: t`Skipped`,
      cancelled: t`Cancelled`,
    },
  };
}

export function ManualActionsPage(): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const api = apiIn(business.id);
  const words = useWords();
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [type, setType] = useState<ManualActionType | typeof ANY>(ANY);
  const [workflow, setWorkflow] = useState(ANY);
  const [assignee, setAssignee] = useState('anyone');
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [trail, setTrail] = useState(emptyTrail);
  const [opened, setOpened] = useState<ManualAction>();
  // Started with "Let's start": closing one action opens the next.
  const [walking, setWalking] = useState(false);
  const [changed, setChanged] = useState(false);
  const [notice, setNotice] = useState('');
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const after = trailCursor(trail);
  const actions = useQuery({
    queryKey: [
      ...actionsKey(business.id),
      'list',
      { status, type, workflow, assignee, pageSize, after },
    ],
    queryFn: () =>
      api.request(listManualActions, {
        query: {
          status,
          assignee,
          limit: pageSize,
          ...(type === ANY ? {} : { type }),
          ...(workflow === ANY ? {} : { automationId: workflow }),
          ...(after === undefined ? {} : { after }),
        },
      }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const refused = actions.error instanceof ApiError && actions.error.status === 403;

  // The workflows and the people to filter by, every page of each: both lists are short.
  // Asked for once the queue has answered, so someone refused it is asked nothing more.
  const readable = actions.data !== undefined;
  const workflows = useInfiniteQuery({
    queryKey: [...actionsKey(business.id), 'workflows'],
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const { readWorkflows } = await import('./manual-action-workflows');
      return readWorkflows(business.id, pageParam);
    },
    initialPageParam: undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: readable,
    retry: retryFaults,
    staleTime: 60_000,
  });
  const people = useAssignees(business.id, readable);
  const moreWorkflows = workflows.hasNextPage && !workflows.isFetching;
  const fetchWorkflows = workflows.fetchNextPage;
  useEffect(() => {
    if (moreWorkflows) void fetchWorkflows();
  }, [moreWorkflows, fetchWorkflows]);
  const morePeople = people.hasNextPage && !people.isFetching;
  const fetchPeople = people.fetchNextPage;
  useEffect(() => {
    if (morePeople) void fetchPeople();
  }, [morePeople, fetchPeople]);
  const workflowItems = workflows.data?.pages.flatMap((page) => page.items) ?? [];
  const teammates: readonly Person[] = teammatesOf(people.data?.pages);

  const refresh = () => cache.invalidateQueries({ queryKey: [...actionsKey(business.id), 'list'] });
  const close = (message = '') => {
    setOpened(undefined);
    setWalking(false);
    setChanged(false);
    setNotice(message);
  };
  const open = (action: ManualAction, trigger: HTMLElement | null, walk = false) => {
    returnFocusRef.current = trigger;
    setOpened(action);
    setWalking(walk);
    setChanged(false);
    setNotice('');
  };
  const filter = <Value,>(set: (value: Value) => void) => {
    return (value: Value) => {
      set(value);
      setTrail(emptyTrail);
    };
  };

  const canWork = actions.data?.canWork === true;
  const canAssign = actions.data?.canAssign === true;
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });
  const items = actions.data?.items ?? [];
  const total = actions.data?.total ?? 0;
  const range = rangeOf({ index: trail.index, pageSize, shown: items.length, total });
  const firstPending = items.find((each) => each.status === 'pending');
  const unfiltered =
    status === 'pending' && type === ANY && workflow === ANY && assignee === 'anyone';
  const openLabel = (name: string) => t`Open the action for ${name}`;
  const statusFilterNames: Record<StatusFilter, string> = {
    ...words.statuses,
    all: t`All statuses`,
  };

  return (
    <Page
      title={t`Manual Actions`}
      actions={
        canWork ? (
          <Button
            disabled={firstPending === undefined}
            onClick={(event) => {
              if (firstPending !== undefined) open(firstPending, event.currentTarget, true);
            }}
          >
            <Trans>Let's start</Trans>
          </Button>
        ) : undefined
      }
    >
      <p className="text-md text-muted-foreground">
        <Trans>
          Manual actions are the calls to place and the text messages to send by hand that your
          workflows leave for a person. A workflow waits at the step until its action is completed
          or skipped.
        </Trans>
      </p>
      <p role="status" className="sr-only">
        {notice}
      </p>
      {refused ? (
        <p className="text-md text-muted-foreground">
          <Trans>
            Working the manual actions queue needs permission to manage or to reply to
            conversations.
          </Trans>
        </p>
      ) : (
        <section aria-label={t`Queue`} className={listCardClassName}>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={t`Status`}
              className="w-auto max-w-full min-w-36"
              value={status}
              onValueChange={(next) => {
                filter(setStatus)(statusFilters.find((each) => each === next) ?? 'pending');
              }}
            >
              {statusFilters.map((each) => (
                <option key={each} value={each}>
                  {statusFilterNames[each]}
                </option>
              ))}
            </Select>
            <Select
              aria-label={t`Type`}
              className="w-auto max-w-full min-w-32"
              value={type}
              onValueChange={(next) => {
                filter(setType)(manualActionTypes.find((each) => each === next) ?? ANY);
              }}
            >
              <option value={ANY}>{t`All types`}</option>
              {manualActionTypes.map((each) => (
                <option key={each} value={each}>
                  {words.types[each]}
                </option>
              ))}
            </Select>
            {workflows.data === undefined ? null : (
              <Select
                aria-label={t`Workflow`}
                className="w-auto max-w-full min-w-44"
                value={workflow}
                onValueChange={filter(setWorkflow)}
              >
                <option value={ANY}>{t`All workflows`}</option>
                {workflowItems.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}
                  </option>
                ))}
              </Select>
            )}
            <Select
              aria-label={t`Assignee`}
              className="w-auto max-w-full min-w-40"
              value={assignee}
              onValueChange={filter(setAssignee)}
            >
              <option value="anyone">{t`Anyone`}</option>
              <option value="me">{t`Assigned to me`}</option>
              <option value="unassigned">{t`Unassigned`}</option>
              {teammates.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name ?? t`Unnamed`}
                </option>
              ))}
            </Select>
          </div>
          {actions.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              <Trans>Loading manual actions…</Trans>
            </p>
          ) : null}
          {actions.isError ? (
            <ListProblem
              onRetry={() => {
                void actions.refetch();
              }}
            >
              <Trans>The manual actions couldn't be loaded.</Trans>
            </ListProblem>
          ) : null}
          {actions.data !== undefined && items.length === 0 ? (
            unfiltered ? (
              <div className="flex flex-col items-center gap-1 py-8 text-center">
                <CircleCheck aria-hidden className="size-8 text-success" strokeWidth={1.8} />
                <p className="text-base font-medium text-foreground">
                  <Trans>Good work!</Trans>
                </p>
                <p className="text-md text-muted-foreground">
                  <Trans>You have no pending tasks.</Trans>
                </p>
              </div>
            ) : (
              <p className="py-6 text-center text-md text-muted-foreground">
                <Trans>No manual actions match.</Trans>
              </p>
            )
          ) : null}
          {items.length === 0 ? null : (
            <div
              role="region"
              aria-label={t`Manual actions table`}
              className={tableRegionClassName}
            >
              <table className={`${tableClassName} min-w-[960px] table-fixed`}>
                <caption className="sr-only">
                  <Trans>Manual actions</Trans>
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={`${headerCellClassName} w-[22%]`}>
                      <Trans>Contact</Trans>
                    </th>
                    <th scope="col" className={headerCellClassName}>
                      <Trans>Workflow</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-[17%]`}>
                      <Trans>Assigned to</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-20`}>
                      <Trans>Type</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-28`}>
                      <Trans>Status</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-40`}>
                      <Trans>Date added</Trans>
                    </th>
                    <th scope="col" className={`${headerCellClassName} w-24`}>
                      <span className="sr-only">
                        <Trans>Actions</Trans>
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((action) => (
                    <tr key={action.id} className="hover:bg-muted">
                      <th scope="row" className={`${cellClassName} text-left font-medium`}>
                        <ContactName contact={action.contact} />
                      </th>
                      <td className={`${cellClassName} truncate`} title={action.automation.name}>
                        {action.automation.name}
                      </td>
                      <td className={`${cellClassName} truncate`}>
                        <AssigneeName action={action} />
                      </td>
                      <td className={cellClassName}>{words.types[action.type]}</td>
                      <td className={cellClassName}>
                        <StatusPill status={action.status} />
                      </td>
                      <td className={`${cellClassName} whitespace-nowrap`}>
                        {moment.format(new Date(action.createdAt))}
                      </td>
                      <td className={`${cellClassName} text-right`}>
                        <Button
                          variant="secondary"
                          size="small"
                          aria-label={openLabel(
                            action.contact.name === '' ? t`Unnamed` : action.contact.name,
                          )}
                          onClick={(event) => {
                            open(action, event.currentTarget);
                          }}
                        >
                          <Trans>Open</Trans>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {actions.data === undefined ? null : (
            <ListFooter
              perPageLabel={t`Rows per page`}
              pageSize={pageSize}
              onPageSize={filter(setPageSize)}
              range={range}
              number={trail.index + 1}
              previous={trail.index > 0}
              next={actions.data.next !== null}
              busy={actions.isFetching && actions.isPlaceholderData}
              onPrevious={() => {
                setTrail(trailBack);
              }}
              onNext={() => {
                setTrail(trailForward(trail, actions.data.next));
              }}
            />
          )}
        </section>
      )}

      <RightPanel
        open={opened !== undefined}
        onClose={close}
        returnFocus={returnFocusRef}
        title={opened?.type === 'sms' ? <Trans>Text to send</Trans> : <Trans>Call to place</Trans>}
        description={opened?.automation.name}
      >
        {opened === undefined ? null : (
          <ActionCard
            key={`${opened.id}:${opened.revision}`}
            action={opened}
            canWork={canWork}
            canAssign={canAssign}
            teammates={teammates}
            onCancel={close}
            changed={changed}
            onChanged={(latest, stale) => {
              setOpened(latest);
              setChanged(stale);
              void refresh();
            }}
            onClosed={async (closed) => {
              const next = walking ? nextPending(items, closed.id) : undefined;
              // The last row of a page left the list: show the page before it.
              if (status === 'pending' && items.length === 1) setTrail(trailBack);
              await refresh();
              const message =
                closed.status === 'completed' ? t`Action completed.` : t`Action skipped.`;
              if (next === undefined) close(message);
              else {
                setOpened(next);
                setChanged(false);
                setNotice(message);
              }
            }}
          />
        )}
      </RightPanel>
    </Page>
  );
}

function AssigneeName({ action }: { readonly action: ManualAction }): ReactElement {
  const { t } = useLingui();
  if (action.assignee === null)
    return (
      <span className="text-muted-foreground">
        <Trans>Unassigned</Trans>
      </span>
    );
  const name = action.assignee.name ?? t`Unnamed`;
  return <>{action.assignee.you ? t`${name} (you)` : name}</>;
}

function StatusPill({ status }: { readonly status: ManualActionStatus }): ReactElement {
  const words = useWords();
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        status === 'pending' ? 'bg-accent text-link' : 'bg-secondary text-secondary-foreground'
      }`}
    >
      {words.statuses[status]}
    </span>
  );
}

const termClassName = 'text-xs font-medium text-muted-foreground';

/** One action, as the panel shows it: who, what to say, whose it is, and the way to close it. */
function ActionCard({
  action,
  canWork,
  canAssign,
  teammates,
  changed,
  onCancel,
  onChanged,
  onClosed,
}: {
  readonly action: ManualAction;
  readonly canWork: boolean;
  readonly canAssign: boolean;
  readonly teammates: readonly Person[];
  readonly onCancel: () => void;
  /** True when this is the action as someone else has just left it. */
  readonly changed: boolean;
  /**
   * The action as it is now saved: after an assignment, or (stale) read again because
   * someone else changed it first.
   */
  readonly onChanged: (latest: ManualAction, stale: boolean) => void;
  readonly onClosed: (closed: ManualAction) => Promise<void>;
}): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const api = apiIn(business.id);
  const words = useWords();
  const [problem, setProblem] = useState<string>();
  const [copied, setCopied] = useState(false);
  const pending = action.status === 'pending';
  const params = { actionId: action.id };
  const moment = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium', timeStyle: 'short' });

  // Someone else changed the action first: show it as it now is, and say so.
  const failed = async (error: unknown, fallback: string): Promise<void> => {
    if (error instanceof ApiError && error.status === 409) {
      try {
        const latest = await api.request(getManualAction, { params });
        onChanged(latest, true);
      } catch {
        setProblem(t`This action changed, and couldn't be loaded again. Close it and try again.`);
      }
      return;
    }
    setProblem(error instanceof ApiError ? (error.problem.detail ?? fallback) : fallback);
  };
  const assign = useMutation({
    mutationFn: (choice: string) =>
      api.request(assignManualAction, {
        params,
        body: { assignee: assigneeInput(choice), revision: action.revision },
      }),
    onSuccess: (latest) => {
      onChanged(latest, false);
    },
    onError: (error) => failed(error, t`It wasn't assigned. Check your connection and try again.`),
  });
  const finish = useMutation({
    mutationFn: (outcome: 'complete' | 'skip') =>
      outcome === 'complete'
        ? api.request(completeManualAction, { params, body: { revision: action.revision } })
        : api.request(skipManualAction, { params, body: { revision: action.revision } }),
    onSuccess: onClosed,
    onError: (error) => failed(error, t`It wasn't saved. Check your connection and try again.`),
  });
  const busy = assign.isPending || finish.isPending;
  const choice = assigneeChoice(action);
  const yours = action.assignee?.you === true;
  const closedBy = action.closedBy?.name ?? null;
  const Icon = action.type === 'sms' ? MessageSquare : Phone;

  return (
    <>
      <div className={sidePanelBodyClassName}>
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-link">
            <Icon aria-hidden className="size-4" strokeWidth={1.8} />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-base font-medium">
              <ContactName contact={action.contact} />
            </span>
            {action.contact.phone === null ? (
              <span className="text-sm text-muted-foreground">
                <Trans>No phone number</Trans>
              </span>
            ) : (
              <a href={`tel:${action.contact.phone}`} className={`${linkClassName} text-sm`}>
                {action.contact.phone}
              </a>
            )}
          </div>
          <span className="ml-auto">
            <StatusPill status={action.status} />
          </span>
        </div>

        {action.body === '' ? null : (
          <div className="flex flex-col gap-1.5">
            <span className={termClassName}>
              {action.type === 'sms' ? <Trans>Message to send</Trans> : <Trans>Call notes</Trans>}
            </span>
            <p className="rounded-lg border border-border bg-muted px-3 py-2 text-md wrap-anywhere whitespace-pre-wrap text-foreground">
              {action.body}
            </p>
            {action.type === 'sms' ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => {
                    void navigator.clipboard.writeText(action.body).then(
                      () => {
                        setCopied(true);
                      },
                      () => undefined,
                    );
                  }}
                >
                  <Trans>Copy message</Trans>
                </Button>
                <span role="status" className="text-sm text-muted-foreground">
                  {copied ? t`Copied` : ''}
                </span>
              </div>
            ) : null}
          </div>
        )}

        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className={termClassName}>
            <Trans>Type</Trans>
          </dt>
          <dd>{words.types[action.type]}</dd>
          <dt className={termClassName}>
            <Trans>Workflow</Trans>
          </dt>
          <dd className="wrap-anywhere">{action.automation.name}</dd>
          <dt className={termClassName}>
            <Trans>Date added</Trans>
          </dt>
          <dd>{moment.format(new Date(action.createdAt))}</dd>
          {action.closedAt === null ? null : (
            <>
              <dt className={termClassName}>
                <Trans>Closed</Trans>
              </dt>
              <dd>
                {moment.format(new Date(action.closedAt))}
                {closedBy === null ? null : (
                  <>
                    {' '}
                    <Trans>by {closedBy}</Trans>
                  </>
                )}
              </dd>
            </>
          )}
        </dl>

        {pending && canAssign ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            <Trans>Assigned to</Trans>
            <Select
              aria-label={t`Assigned to`}
              disabled={busy}
              value={choice}
              onValueChange={(next) => {
                setProblem(undefined);
                if (next !== choice) assign.mutate(next);
              }}
            >
              <option value="unassigned">{t`Unassigned`}</option>
              <option value="me">{t`Me`}</option>
              {teammates.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name ?? t`Unnamed`}
                </option>
              ))}
              {choice === 'unassigned' ||
              choice === 'me' ||
              teammates.some((each) => each.id === choice) ? null : (
                <option value={choice}>{action.assignee?.name ?? t`Unnamed`}</option>
              )}
            </Select>
          </label>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
            <span className={termClassName}>
              <Trans>Assigned to</Trans>
            </span>
            <span>
              <AssigneeName action={action} />
            </span>
            {pending && canWork && (yours || action.assignee === null) ? (
              <Button
                variant="secondary"
                size="small"
                disabled={busy}
                onClick={() => {
                  setProblem(undefined);
                  assign.mutate(yours ? 'unassigned' : 'me');
                }}
              >
                {yours ? <Trans>Put it back</Trans> : <Trans>Assign to me</Trans>}
              </Button>
            ) : null}
          </div>
        )}

        {pending && canWork ? (
          <p className="text-sm text-muted-foreground">
            {action.type === 'sms' ? (
              <Trans>
                Completing does not send the text. Send it to the contact first, then complete the
                action so the workflow goes on.
              </Trans>
            ) : (
              <Trans>
                Completing does not place the call. Call the contact first, then complete the action
                so the workflow goes on.
              </Trans>
            )}
          </p>
        ) : null}
        {action.status === 'cancelled' ? (
          <p className="text-sm text-muted-foreground">
            <Trans>The workflow run ended before anyone did this action.</Trans>
          </p>
        ) : null}
        {changed && problem === undefined ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            <Trans>Someone else changed this action. This is how it is now.</Trans>
          </p>
        ) : null}
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
      </div>
      {pending && canWork ? (
        <div className={sidePanelFooterClassName}>
          <Button
            variant="secondary"
            disabled={finish.isPending}
            onClick={() => {
              onCancel();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setProblem(undefined);
              finish.mutate('skip');
            }}
          >
            <Trans>Skip</Trans>
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setProblem(undefined);
              finish.mutate('complete');
            }}
          >
            <Trans>Complete</Trans>
          </Button>
        </div>
      ) : null}
    </>
  );
}
