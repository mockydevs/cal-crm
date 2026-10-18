// The Execution logs tab: every step this workflow's runs have taken, newest first, each
// with the record it ran for and how it went. Read from the API as it is (GET
// /automations/{id}/step-runs); nothing here changes a run. A row leads to its run, where
// every step it took is shown with what it was given.
//
// Its own chunk, loaded when someone opens this tab.
import { Trans, useLingui } from '@lingui/react/macro';
import { listAutomationStepRuns, type AutomationSetup } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Select } from '@repo/ui/components/select';
import { useInfiniteQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { apiIn } from './api';
import { isRecord } from './automation-document';
import {
  anyDay,
  DayRangeFilter,
  RecordFilter,
  type RecordChoice,
} from './automation-history-filters';
import { momentsOf, stepStatuses, type StepStatus } from './automation-history-rules';
import { SearchLink, type AutomationsNavigation } from './automation-navigation';
import { RecordName } from './automation-record-name';
import { failureWords, momentWords, stepStatusWords } from './automation-run-words';
import { stepLabel, stepSummary } from './automation-summary';
import {
  cellClassName,
  headerCellClassName,
  listCardClassName,
  ListProblem,
  tableClassName,
  tableRegionClassName,
} from './list-table';
import { useBusiness } from './workspace';

export interface ExecutionLogsProps {
  readonly automationId: string;
  readonly navigation: AutomationsNavigation;
  readonly setup: AutomationSetup;
  /** The workflow's actions, by their key, to narrow the logs to one. */
  readonly actions: readonly { readonly id: string; readonly name: string }[];
}

const ANY = 'any';

/** Why the engine failed a step, as a sentence of its own; nothing when it gave no code. */
function reasonOf(code: string | undefined): string | undefined {
  const words = failureWords(code);
  return words === undefined ? undefined : `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

/** A step's status as a pill: its word, with the colour only as a second cue. */
export function StepStatusPill({ status }: { readonly status: string }): ReactElement {
  const className =
    status === 'failed'
      ? 'bg-attention text-attention-foreground'
      : status === 'succeeded'
        ? 'border border-success-line bg-success-subtle text-success'
        : 'bg-secondary text-secondary-foreground';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${className}`}
    >
      {stepStatusWords(status)}
    </span>
  );
}

export default function ExecutionLogs({
  automationId,
  navigation,
  setup,
  actions,
}: ExecutionLogsProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [days, setDays] = useState(anyDay);
  const [action, setAction] = useState(ANY);
  const [status, setStatus] = useState<StepStatus>();
  const [record, setRecord] = useState<RecordChoice>();
  const query = {
    ...momentsOf(days.first, days.last),
    ...(action === ANY ? {} : { step: action }),
    ...(status === undefined ? {} : { status }),
    ...(record === undefined ? {} : { record: record.id }),
  };
  const logs = useInfiniteQuery({
    queryKey: ['b', business.id, 'automation-step-runs', automationId, query],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      apiIn(business.id).request(listAutomationStepRuns, {
        params: { id: automationId },
        query: { ...query, ...(pageParam === '' ? {} : { after: pageParam }) },
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = logs.data?.pages.flatMap((page) => page.items) ?? [];
  const narrowed = Object.keys(query).length > 0;

  return (
    <section aria-label={t`Execution logs`} className={listCardClassName}>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <DayRangeFilter value={days} onChange={setDays} />
        <Select
          aria-label={t`Action`}
          className="w-auto max-w-full min-w-44"
          value={action}
          onValueChange={setAction}
        >
          <option value={ANY}>{t`All actions`}</option>
          {actions.map((each) => (
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
            setStatus(stepStatuses.find((each) => each === next));
          }}
        >
          <option value={ANY}>{t`All statuses`}</option>
          {stepStatuses.map((each) => (
            <option key={each} value={each}>
              {stepStatusWords(each)}
            </option>
          ))}
        </Select>
        <RecordFilter value={record} onChange={setRecord} />
        <Button
          variant="secondary"
          className="ml-auto"
          disabled={logs.isFetching}
          onClick={() => {
            void logs.refetch();
          }}
        >
          <RefreshCw aria-hidden className="size-4" strokeWidth={1.8} />
          <Trans>Refresh</Trans>
        </Button>
      </div>
      {logs.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading the logs…</Trans>
        </p>
      ) : null}
      {logs.isError ? (
        <ListProblem
          onRetry={() => {
            void logs.refetch();
          }}
        >
          <Trans>We couldn't load the execution logs.</Trans>
        </ListProblem>
      ) : null}
      {logs.isSuccess && items.length === 0 ? (
        <p className="py-6 text-center text-md text-muted-foreground">
          {narrowed ? (
            <Trans>No action matches that.</Trans>
          ) : (
            <Trans>
              No action has run yet. Once the workflow is published and something starts it, every
              action it takes is listed here.
            </Trans>
          )}
        </p>
      ) : null}
      {items.length === 0 ? null : (
        <div role="region" aria-label={t`Execution logs table`} className={tableRegionClassName}>
          <table className={`${tableClassName} min-w-[820px]`}>
            <caption className="sr-only">
              <Trans>Execution logs</Trans>
            </caption>
            <thead>
              <tr>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Record</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Action</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Status</Trans>
                </th>
                <th scope="col" className={headerCellClassName}>
                  <Trans>Executed on</Trans>
                </th>
                <th scope="col" className={`${headerCellClassName} w-24`}>
                  <Trans>Actions</Trans>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => {
                const type = entry.type ?? '';
                const config = isRecord(entry.input['config']) ? entry.input['config'] : {};
                const kind = stepLabel(type) ?? (type === '' ? entry.step : type);
                const does = entry.label ?? stepSummary({ type, config }, setup) ?? kind;
                const when = momentWords(entry.startedAt) ?? entry.startedAt;
                const code =
                  isRecord(entry.error) && typeof entry.error['code'] === 'string'
                    ? entry.error['code']
                    : undefined;
                const why = entry.status === 'failed' ? (reasonOf(code) ?? entry.explanation) : '';
                const name = entry.record.name === '' ? t`Unnamed` : entry.record.name;
                return (
                  <tr key={entry.id} className="hover:bg-muted">
                    <th scope="row" className={`${cellClassName} h-14 text-left font-normal`}>
                      <RecordName record={entry.record} />
                    </th>
                    <td className={cellClassName}>
                      <span className="flex min-w-0 flex-col">
                        <span className="text-xs text-muted-foreground">{kind}</span>
                        <span className="wrap-anywhere text-foreground">{does}</span>
                      </span>
                    </td>
                    <td className={cellClassName}>
                      <span className="flex min-w-0 flex-col items-start gap-1">
                        <StepStatusPill status={entry.status} />
                        {why === '' ? null : (
                          <span className="text-xs wrap-anywhere text-body">{why}</span>
                        )}
                      </span>
                    </td>
                    <td className={`${cellClassName} whitespace-nowrap`}>
                      <time dateTime={entry.startedAt}>{when}</time>
                    </td>
                    <td className={cellClassName}>
                      <SearchLink
                        to={{ automation: automationId, view: 'runs', run: entry.runId }}
                        navigation={navigation}
                        className="inline-flex min-h-11 items-center whitespace-nowrap text-link underline-offset-2 hover:underline lg:min-h-8"
                        aria-label={t`Open the run of ${name} that took this action at ${when}`}
                      >
                        <Trans>Open run</Trans>
                      </SearchLink>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {logs.hasNextPage ? (
        <Button
          variant="secondary"
          className="self-start"
          disabled={logs.isFetchingNextPage}
          onClick={() => {
            void logs.fetchNextPage();
          }}
        >
          <Trans>Load more</Trans>
        </Button>
      ) : null}
    </section>
  );
}
