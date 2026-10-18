// Run history (docs/AUTOMATIONS.md section 5): everyone an automation has been run for, and
// for one run, each step it took: what the step was given, the branch it took and why. Read
// from the API as it is; nothing here changes a run. The lists refresh when something
// happens in the business (realtime.ts), and on request.
//
// Its own chunk, loaded when someone opens an automation's runs.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  continueAutomationRun,
  getAutomationRun,
  retryAutomationRun,
  getAutomationVersion,
  listAutomationRuns,
  type AutomationRun,
  type AutomationSetup,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { EmptyState } from '@repo/ui/components/empty-state';
import { Select } from '@repo/ui/components/select';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FastForward, History, RefreshCw, RotateCw, TriangleAlert, UserSearch } from 'lucide-react';
import { lazy, Suspense, useId, useState, type ReactElement } from 'react';
import {
  anyDay,
  DayRangeFilter,
  RecordFilter,
  type RecordChoice,
} from './automation-history-filters';
import { momentsOf } from './automation-history-rules';
import { apiIn } from './api';
import { isRecord, stepOf, type Draft } from './automation-document';
import { SearchLink, type AutomationsNavigation } from './automation-navigation';
import { RecordName } from './automation-record-name';
import { comparedValues } from './automation-run-steps';
import {
  momentWords,
  outputWords,
  runOutcomeWords,
  runStatuses,
  runStatusWords,
  stepStatusWords,
  type RunStatus,
} from './automation-run-words';
import { branchLabel, stepLabel, stepName, stepSummary, triggerLabel } from './automation-summary';
import {
  cellClassName,
  headerCellClassName,
  listCardClassName,
  ListProblem,
  tableClassName,
  tableRegionClassName,
} from './list-table';
import { useBusiness } from './workspace';

export interface RunHistoryProps {
  readonly automationId: string;
  /** The run the address names, when one is open. */
  readonly runId: string | undefined;
  readonly navigation: AutomationsNavigation;
  readonly setup: AutomationSetup;
  /** The workflow's triggers, by their id, to name what enrolled a record and narrow by it. */
  readonly triggers?: readonly { readonly id: string; readonly name: string }[];
}

// The question of which way to go, and the answer about one contact: each fetched when it
// is first asked for.
const ContinueDialog = lazy(() => import('./automation-run-continue'));
const Explanation = lazy(() => import('./automation-explain'));

/** What a run says of itself that "Continue now" needs. */
interface Waiting {
  readonly id: string;
  readonly revision?: string | undefined;
  readonly continuable?: { readonly branches: readonly string[] } | null | undefined;
  readonly currentAction?: { readonly type: string | null } | null | undefined;
}

/**
 * "Continue now": ends a run's wait at once (docs/AUTOMATIONS.md, "Continuing a waiting run
 * now"). A wait that ends down one of several branches asks which; the run's revision goes
 * with it, so a run that moved meanwhile is refused, and what the server says is shown.
 */
function ContinueNow({
  run,
  config = {},
  small = false,
}: {
  readonly run: Waiting;
  /** The settings of the step it waits at, for the words of its branches. */
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  readonly small?: boolean;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [wanted, setWanted] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const [done, setDone] = useState(false);
  const branches = run.continuable?.branches ?? [];
  const refresh = (): void => {
    void cache.invalidateQueries({ queryKey: ['b', business.id, 'automation-runs'] });
  };
  const go = useMutation({
    mutationFn: (branch: string | undefined) =>
      apiIn(business.id).request(continueAutomationRun, {
        params: { runId: run.id },
        body: {
          ...(branch === undefined ? {} : { branch }),
          ...(run.revision === undefined ? {} : { revision: run.revision }),
        },
      }),
    onMutate: () => {
      setRefusal(undefined);
      setDone(false);
    },
    onSuccess: (answer) => {
      cache.setQueryData(['b', business.id, 'automation-run', run.id], answer);
      refresh();
      setAsking(false);
      setDone(true);
    },
    onError: (error) => {
      setRefusal(
        !(error instanceof ApiError)
          ? t`We couldn't continue the run. Check your connection and try again.`
          : error.status === 403
            ? t`You don't have permission to continue runs.`
            : (error.problem.errors?.[0]?.message ??
              error.problem.detail ??
              t`We couldn't continue the run. Try again.`),
      );
      // Refused because it moved, or isn't waiting any more: what is shown is read again.
      void cache.invalidateQueries({ queryKey: ['b', business.id, 'automation-run', run.id] });
      refresh();
    },
  });
  return (
    <>
      {run.continuable === null || run.continuable === undefined ? null : (
        <Button
          variant="secondary"
          size="small"
          className={small ? 'whitespace-nowrap' : undefined}
          disabled={go.isPending}
          onClick={() => {
            if (branches.length === 0) {
              go.mutate(undefined);
              return;
            }
            setRefusal(undefined);
            setWanted(true);
            setAsking(true);
          }}
        >
          <FastForward aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Continue now</Trans>
        </Button>
      )}
      {refusal === undefined || asking ? null : (
        <p role="alert" className="text-sm font-medium text-destructive wrap-anywhere">
          {refusal}
        </p>
      )}
      {done ? (
        <span role="status" className="text-sm font-medium text-body">
          <Trans>Continued: the run went on from its wait.</Trans>
        </span>
      ) : null}
      {wanted ? (
        <Suspense fallback={null}>
          <ContinueDialog
            open={asking}
            onOpenChange={setAsking}
            branches={branches}
            step={{ type: run.currentAction?.type ?? '', config }}
            pending={go.isPending}
            refusal={refusal}
            onContinue={(branch) => {
              go.mutate(branch);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}

const isStatus = (value: string): value is RunStatus =>
  (runStatuses as readonly string[]).includes(value);

/** A status as a label: its word, with the colour only as a second cue. */
export function RunStatusBadge({ status }: { readonly status: string }): ReactElement {
  return (
    <Badge
      variant={status === 'failed' ? 'attention' : status === 'completed' ? 'assistant' : 'neutral'}
    >
      {runStatusWords(status)}
    </Badge>
  );
}

export default function RunHistory({
  automationId,
  runId,
  navigation,
  setup,
  triggers = [],
}: RunHistoryProps): ReactElement {
  return runId === undefined ? (
    <RunList
      automationId={automationId}
      navigation={navigation}
      setup={setup}
      triggers={triggers}
    />
  ) : (
    <RunDetail
      key={runId}
      automationId={automationId}
      runId={runId}
      navigation={navigation}
      setup={setup}
    />
  );
}

const ANY = 'any';

function RunList({
  automationId,
  navigation,
  setup,
  triggers,
}: Pick<RunHistoryProps, 'automationId' | 'navigation' | 'setup'> & {
  readonly triggers: NonNullable<RunHistoryProps['triggers']>;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [days, setDays] = useState(anyDay);
  const [trigger, setTrigger] = useState(ANY);
  const [status, setStatus] = useState<RunStatus>();
  const [record, setRecord] = useState<RecordChoice>();
  // "Check a contact": what the workflow did for one contact, or why it did not start.
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<RecordChoice>();
  const checkId = useId();
  const automationName = (id: string): string | undefined =>
    setup.automations.find((each) => each.id === id)?.name;
  const query = {
    ...momentsOf(days.first, days.last),
    ...(trigger === ANY ? {} : { trigger }),
    ...(status === undefined ? {} : { status }),
    ...(record === undefined ? {} : { record: record.id }),
  };
  const runs = useInfiniteQuery({
    queryKey: ['b', business.id, 'automation-runs', automationId, query],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiIn(business.id).request(listAutomationRuns, {
        params: { id: automationId },
        query: { ...query, ...(pageParam === '' ? {} : { after: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const here = { automation: automationId, view: 'runs' as const };
  const narrowed = Object.keys(query).length > 0;

  return (
    <section aria-label={t`Enrollment history`} className={listCardClassName}>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <DayRangeFilter value={days} onChange={setDays} />
        <Select
          aria-label={t`Enrollment reason`}
          className="w-auto max-w-full min-w-44"
          value={trigger}
          onValueChange={setTrigger}
        >
          <option value={ANY}>{t`All events`}</option>
          {triggers.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t`Status`}
          className="w-auto max-w-full min-w-40"
          value={status ?? ANY}
          onValueChange={(next) => {
            setStatus(isStatus(next) ? next : undefined);
          }}
        >
          <option value={ANY}>{t`All statuses`}</option>
          {runStatuses.map((each) => (
            <option key={each} value={each}>
              {runStatusWords(each)}
            </option>
          ))}
        </Select>
        <RecordFilter value={record} onChange={setRecord} />
        <button
          type="button"
          aria-pressed={status === 'failed'}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-input bg-card px-3 text-sm font-medium text-body hover:bg-muted aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-link lg:min-h-9"
          onClick={() => {
            setStatus(status === 'failed' ? undefined : 'failed');
          }}
        >
          <TriangleAlert aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Needs review</Trans>
        </button>
        <Button
          variant="secondary"
          className="ml-auto"
          aria-expanded={checking}
          aria-controls={checkId}
          onClick={() => {
            setChecking(!checking);
          }}
        >
          <UserSearch aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Check a contact</Trans>
        </Button>
        <Button
          variant="secondary"
          disabled={runs.isFetching}
          onClick={() => {
            void runs.refetch();
          }}
        >
          <RefreshCw aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Refresh</Trans>
        </Button>
      </div>

      {checking ? (
        <section
          id={checkId}
          aria-label={t`Check a contact`}
          className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-background p-3.5"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-0 flex-1 basis-56 text-sm text-body">
              <Trans>
                Why didn't this run? Choose a contact to see what this workflow did for them, or why
                it did not start.
              </Trans>
            </p>
            <RecordFilter
              value={checked}
              label={t`Contact to check`}
              clearLabel={t`Check another contact`}
              onChange={setChecked}
            />
          </div>
          {checked === undefined ? null : (
            <Suspense
              fallback={
                <p role="status" className="text-sm text-muted-foreground">
                  <Trans>Loading…</Trans>
                </p>
              }
            >
              <Explanation
                key={checked.id}
                automationId={automationId}
                contactId={checked.id}
                runLink={(runId, children) => (
                  <SearchLink
                    to={{ ...here, run: runId }}
                    navigation={navigation}
                    className="font-medium text-link underline-offset-2 hover:underline"
                  >
                    {children}
                  </SearchLink>
                )}
              />
            </Suspense>
          )}
        </section>
      ) : null}

      {runs.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading the enrollment history…</Trans>
        </p>
      ) : null}
      {runs.isError ? (
        <ListProblem
          onRetry={() => {
            void runs.refetch();
          }}
        >
          <Trans>We couldn't load the enrollment history.</Trans>
        </ListProblem>
      ) : null}
      {runs.isSuccess && items.length === 0 ? (
        narrowed ? (
          <p className="py-6 text-center text-md text-muted-foreground">
            <Trans>No enrollment matches that.</Trans>
          </p>
        ) : (
          <EmptyState
            className="border-0 p-0"
            icon={<History strokeWidth={1.8} />}
            title={<Trans>Nobody has been enrolled yet</Trans>}
            description={
              <Trans>
                Once the workflow is published and something starts it, each contact it runs for is
                listed here, with every action taken.
              </Trans>
            }
          />
        )
      ) : null}
      {items.length === 0 ? null : (
        <div
          role="region"
          aria-label={t`Enrollment history table`}
          className={tableRegionClassName}
        >
          <table className={`${tableClassName} min-w-[1040px]`}>
            <caption className="sr-only">
              <Trans>Enrollment history</Trans>
            </caption>
            <thead>
              <tr>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Record</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Enrollment reason</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Date enrolled</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Current action</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Current status</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Next execution on</Trans>
                </th>
                <th scope="col" className={`${headerCellClassName} w-44`}>
                  <Trans>Actions</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((run) => {
                const started = momentWords(run.startedAt) ?? run.startedAt;
                const next = run.status === 'waiting' ? momentWords(run.wakeAt) : undefined;
                const name = run.record.name === '' ? t`Unnamed` : run.record.name;
                const by = run.trigger ?? undefined;
                // Another automation's "Start another automation" action, or a trigger.
                const from = run.startedBy ?? undefined;
                const starter = from === undefined ? undefined : automationName(from.automationId);
                const reason =
                  from !== undefined
                    ? starter === undefined
                      ? t`Started by another automation`
                      : t`Started by the automation “${starter}”`
                    : by === undefined
                      ? undefined
                      : (triggers.find((each) => each.id === by.id)?.name ??
                        (by.type === null ? undefined : triggerLabel(by.type)) ??
                        by.id);
                const at = run.currentAction ?? undefined;
                const action =
                  at === undefined
                    ? undefined
                    : (at.label ?? (at.type === null ? undefined : stepLabel(at.type)) ?? at.step);
                const { version } = run;
                // How it ended, when it ended otherwise than by reaching the end.
                const outcome =
                  run.status === 'failed' || run.status === 'exited' || run.status === 'cancelled'
                    ? runOutcomeWords(run, () => undefined, automationName)
                    : undefined;
                return (
                  <tr key={run.id} className="hover:bg-muted">
                    <th scope="row" className={`${cellClassName} h-14 text-left font-normal`}>
                      <RecordName record={run.record} />
                    </th>
                    <td className={`${cellClassName} wrap-anywhere`}>
                      {reason ?? (
                        <span className="text-muted-foreground">
                          <Trans>Not recorded</Trans>
                        </span>
                      )}
                    </td>
                    <td className={cellClassName}>
                      <span className="flex flex-col">
                        <time dateTime={run.startedAt} className="whitespace-nowrap">
                          {started}
                        </time>
                        <span className="text-xs text-muted-foreground">
                          <Trans>Version {version}</Trans>
                        </span>
                      </span>
                    </td>
                    <td className={`${cellClassName} wrap-anywhere`}>{action}</td>
                    <td className={cellClassName}>
                      <span className="flex min-w-0 flex-col items-start gap-1">
                        <RunStatusBadge status={run.status} />
                        {outcome === undefined ? null : (
                          <span className="text-xs wrap-anywhere text-body">{outcome}</span>
                        )}
                      </span>
                    </td>
                    <td className={`${cellClassName} whitespace-nowrap`}>
                      {next === undefined || run.wakeAt === null ? null : (
                        <time dateTime={run.wakeAt}>{next}</time>
                      )}
                    </td>
                    <td className={cellClassName}>
                      <span className="flex min-w-0 flex-col items-start gap-1">
                        <SearchLink
                          to={{ ...here, run: run.id }}
                          navigation={navigation}
                          className="inline-flex min-h-11 items-center whitespace-nowrap text-link underline-offset-2 hover:underline lg:min-h-8"
                          aria-label={t`Open the run for ${name}, started ${started}`}
                        >
                          <Trans>Open run</Trans>
                        </SearchLink>
                        <ContinueNow run={run} small />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {runs.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-start"
          disabled={runs.isFetchingNextPage}
          onClick={() => {
            void runs.fetchNextPage();
          }}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </section>
  );
}

function RunDetail({
  automationId,
  runId,
  navigation,
  setup,
}: Required<Pick<RunHistoryProps, 'automationId' | 'navigation' | 'setup'>> & {
  readonly runId: string;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const headingId = useId();
  const stepsId = useId();
  const client = apiIn(business.id);
  const run = useQuery({
    queryKey: ['b', business.id, 'automation-run', runId],
    queryFn: () => client.request(getAutomationRun, { params: { runId } }),
    retry: (failures, error) =>
      !(error instanceof ApiError && (error.status === 404 || error.status === 400)) &&
      failures < 2,
  });
  const cache = useQueryClient();
  const [refusal, setRefusal] = useState<string>();
  const [again, setAgain] = useState(false);
  // A failed run goes on from the step it failed at, on the version it began on.
  const retry = useMutation({
    mutationFn: () => client.request(retryAutomationRun, { params: { runId } }),
    onMutate: () => {
      setRefusal(undefined);
      setAgain(false);
    },
    onSuccess: (answer) => {
      cache.setQueryData(['b', business.id, 'automation-run', runId], answer);
      void cache.invalidateQueries({ queryKey: ['b', business.id, 'automation-runs'] });
      setAgain(true);
    },
    onError: (error) => {
      setRefusal(
        !(error instanceof ApiError)
          ? t`We couldn't run it again. Check your connection and try again.`
          : error.status === 403
            ? t`You don't have permission to run workflows again.`
            : (error.problem.detail ?? t`We couldn't run it again. Try again.`),
      );
    },
  });
  const version = run.data?.version;
  // The version the run began on, which names its steps: a later draft may have changed them.
  const document = useQuery({
    queryKey: ['b', business.id, 'automation-version', automationId, version],
    queryFn: () =>
      client.request(getAutomationVersion, {
        params: { id: automationId, version: version ?? 1 },
      }),
    enabled: version !== undefined,
    staleTime: Infinity,
  });
  const back = (
    <SearchLink
      to={{ automation: automationId, view: 'runs' }}
      navigation={navigation}
      className="self-start py-2 text-link underline-offset-2 hover:underline"
    >
      <Trans>Back to the enrollment history</Trans>
    </SearchLink>
  );

  if (run.isPending)
    return (
      <section className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-5">
        {back}
        <p role="status">
          <Trans>Loading the run…</Trans>
        </p>
      </section>
    );
  if (run.isError) {
    const missing = run.error instanceof ApiError && [400, 404].includes(run.error.status);
    return (
      <section className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-5">
        {back}
        <div role="alert" className="flex min-w-0 flex-col items-start gap-2 text-md">
          <p>
            {missing ? (
              <Trans>This run doesn't exist, or it belongs to another business.</Trans>
            ) : (
              <Trans>We couldn't load this run.</Trans>
            )}
          </p>
          {missing ? null : (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void run.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          )}
        </div>
      </section>
    );
  }

  const data: AutomationRun = run.data;
  const versionDraft: Draft = isRecord(document.data?.document) ? document.data.document : {};
  const nameOf = (key: string): string => {
    const step = stepOf(versionDraft, key);
    return step === undefined ? key : stepName(step, setup);
  };
  const started = momentWords(data.startedAt) ?? data.startedAt;
  const finished = momentWords(data.finishedAt);
  const versionNumber = data.version;
  const { automationName } = data;

  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-5"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        {back}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ContinueNow run={data} config={stepOf(versionDraft, data.currentStep ?? '')?.config} />
          {data.status === 'failed' ? (
            <Button
              size="small"
              disabled={retry.isPending}
              onClick={() => {
                retry.mutate();
              }}
            >
              <RotateCw aria-hidden className="size-4" strokeWidth={1.8} />
              <Trans>Run again</Trans>
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="small"
            disabled={run.isFetching}
            onClick={() => {
              void run.refetch();
            }}
          >
            <RefreshCw aria-hidden className="size-4" strokeWidth={1.8} />
            <Trans>Refresh</Trans>
          </Button>
        </div>
      </div>
      {data.status === 'failed' ? (
        <p className="text-sm text-muted-foreground">
          <Trans>
            Run again goes on from the action that failed, on the version this run began on. Fix
            what made it fail first, such as a disconnected mailbox.
          </Trans>
        </p>
      ) : null}
      {refusal === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive wrap-anywhere">
          {refusal}
        </p>
      )}
      <p role="status" className={again ? 'text-sm font-medium text-body' : 'sr-only'}>
        {again ? t`Running again from the action that failed.` : ''}
      </p>
      <div className="flex min-w-0 flex-col gap-2">
        <h2
          id={headingId}
          className="flex min-w-0 flex-wrap items-center gap-2 text-lg font-semibold"
        >
          <span className="min-w-0 wrap-anywhere">
            <Trans>
              Run for <RecordName record={data.record} />
            </Trans>
          </span>
          <RunStatusBadge status={data.status} />
        </h2>
        <p className="text-md wrap-anywhere">
          {runOutcomeWords(
            data,
            nameOf,
            (id) => setup.automations.find((each) => each.id === id)?.name,
          )}
        </p>
        <p className="text-sm text-muted-foreground wrap-anywhere">
          <Trans>
            {automationName}, version {versionNumber}. Started{' '}
            <time dateTime={data.startedAt}>{started}</time>.
          </Trans>
          {finished === undefined || data.finishedAt === null ? null : (
            <>
              {' '}
              <Trans>
                Ended <time dateTime={data.finishedAt}>{finished}</time>.
              </Trans>
            </>
          )}
        </p>
      </div>

      <h3 id={stepsId} className="text-md font-semibold">
        <Trans>Steps taken</Trans>
      </h3>
      {data.steps.length === 0 ? (
        <p className="text-md text-muted-foreground">
          <Trans>No step has run yet.</Trans>
        </p>
      ) : (
        <ol aria-labelledby={stepsId} className="flex min-w-0 list-none flex-col gap-3">
          {data.steps.map((step, position) => {
            const type = step.type ?? '';
            const config = isRecord(step.input['config']) ? step.input['config'] : {};
            const summary = stepSummary({ type, config }, setup);
            const label = stepLabel(type) ?? (type === '' ? step.step : type);
            const when = momentWords(step.startedAt) ?? step.startedAt;
            const compared = comparedValues(step.input);
            const produced = outputWords(step.output, step.type);
            const code =
              isRecord(step.error) && typeof step.error['code'] === 'string'
                ? step.error['code']
                : undefined;
            const number = position + 1;
            const said = summary ?? label;
            return (
              <li
                key={`${step.step}:${String(position)}`}
                aria-label={t`Step ${number}: ${said}`}
                className="flex min-w-0 flex-col gap-2 rounded-2xl bg-background px-4 py-3.5"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="flex min-w-0 flex-1 basis-52 flex-col gap-0.5">
                    <span className="text-[13px] text-muted-foreground">{label}</span>
                    <span className="text-base font-medium wrap-anywhere">
                      {summary ?? step.step}
                    </span>
                  </span>
                  <Badge variant={step.status === 'failed' ? 'attention' : 'neutral'}>
                    {stepStatusWords(
                      step.status,
                      data.status !== 'waiting' || position < data.steps.length - 1,
                    )}
                  </Badge>
                  <time dateTime={step.startedAt} className="text-sm text-muted-foreground">
                    {when}
                  </time>
                </div>
                <dl className="grid min-w-0 gap-x-4 gap-y-1.5 text-md sm:grid-cols-[minmax(7rem,auto)_minmax(0,1fr)]">
                  {compared.length === 0 ? null : (
                    <>
                      <dt className="text-sm font-medium text-muted-foreground">
                        <Trans>What it checked</Trans>
                      </dt>
                      <dd className="min-w-0 wrap-anywhere">
                        <ul className="flex min-w-0 flex-col gap-0.5">
                          {compared.map(({ field, value }) => (
                            <li key={field}>
                              <Trans>
                                {field} was: {value}
                              </Trans>
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </>
                  )}
                  {step.branch === null ? null : (
                    <>
                      <dt className="text-sm font-medium text-muted-foreground">
                        <Trans>Branch taken</Trans>
                      </dt>
                      <dd className="min-w-0 wrap-anywhere">
                        {branchLabel({ type, config }, step.branch)}
                      </dd>
                    </>
                  )}
                  <dt className="text-sm font-medium text-muted-foreground">
                    <Trans>Why</Trans>
                  </dt>
                  <dd className="min-w-0 wrap-anywhere">
                    {step.explanation === '' ? t`No reason was recorded.` : step.explanation}
                    {code === undefined ? null : (
                      <>
                        {' '}
                        <code className="rounded-md bg-muted px-1.5 py-0.5 text-xs">{code}</code>
                      </>
                    )}
                  </dd>
                  {produced.length === 0 ? null : (
                    <>
                      <dt className="text-sm font-medium text-muted-foreground">
                        <Trans>Result</Trans>
                      </dt>
                      <dd className="min-w-0 wrap-anywhere">{produced.join(' ')}</dd>
                    </>
                  )}
                </dl>
                <details className="min-w-0 text-sm">
                  <summary className="cursor-pointer py-1 text-link">
                    <Trans>What it was given, as data</Trans>
                  </summary>
                  <pre className="mt-1.5 max-w-full overflow-x-auto rounded-xl bg-muted p-3 text-xs whitespace-pre-wrap wrap-anywhere">
                    {JSON.stringify(
                      { step: step.step, input: step.input, output: step.output },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
