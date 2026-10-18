// The Statistics tab of a Send email action: what the action has sent over a range of
// dates, across every version of the workflow. Opens and clicks are not measured yet, and
// delivery to the inbox never is: each says so in words, never as a zero.
//
// Its words are in the email catalog (lingui.config.ts, email-words.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import { getWorkflowEmailStepStatistics } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { useId, useMemo, useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import { useBusiness } from '../workspace';
import {
  rangeNames,
  rangeStart,
  skipRows,
  STATISTICS_RANGES,
  statisticRows,
  type StatisticsRange,
} from './rules';

export interface EmailStatisticsProps {
  readonly automationId: string;
  readonly step: string;
}

export default function EmailStatistics({
  automationId,
  step,
}: EmailStatisticsProps): ReactElement {
  const { t, i18n } = useLingui();
  const business = useBusiness();
  const businessId = business.id;
  const client = useMemo(() => apiIn(businessId), [businessId]);
  const rangeId = useId();
  const [range, setRange] = useState<StatisticsRange>('30');
  // The range is counted from when the tab was opened, or the range last changed.
  const [asked, setAsked] = useState(() => new Date());
  const from = rangeStart(range, asked);
  const statistics = useQuery({
    queryKey: ['b', businessId, 'email-step-statistics', automationId, step, from ?? 'all'],
    queryFn: () =>
      client.request(getWorkflowEmailStepStatistics, {
        params: { id: automationId, step },
        query: from === undefined ? {} : { from },
      }),
    staleTime: 30_000,
    retry: (failures, error) =>
      failures < 2 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
  });
  const rows = statistics.data === undefined ? [] : statisticRows(statistics.data);
  const skipped = statistics.data === undefined ? [] : skipRows(statistics.data);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={rangeId} className="text-xs font-medium text-muted-foreground">
          <Trans>Dates</Trans>
        </label>
        <select
          id={rangeId}
          data-field-control
          className="min-h-11 w-full min-w-0 rounded-control border border-input bg-card px-2.5 text-md lg:min-h-9"
          value={range}
          onChange={(event) => {
            const next = STATISTICS_RANGES.find((each) => each === event.target.value);
            if (next === undefined) return;
            setRange(next);
            setAsked(new Date());
          }}
        >
          {STATISTICS_RANGES.map((each) => (
            <option key={each} value={each}>
              {i18n._(rangeNames[each])}
            </option>
          ))}
        </select>
      </div>
      {statistics.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading the statistics…</Trans>
        </p>
      ) : statistics.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>
            {statistics.error instanceof ApiError
              ? statistics.error.message
              : t`The statistics couldn't be loaded. Check your connection and try again.`}
          </p>
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void statistics.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : (
        <>
          <dl aria-label={t`Email statistics`} className="grid min-w-0 grid-cols-2 gap-2">
            {rows.map((row) => (
              <div
                key={row.key}
                data-statistic={row.key}
                className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-border px-3 py-2.5"
              >
                <dt className="text-xs font-medium text-muted-foreground">{row.label}</dt>
                <dd
                  className={
                    row.measured
                      ? 'text-xl font-semibold text-foreground'
                      : 'text-md font-medium text-muted-foreground'
                  }
                >
                  {row.value}
                </dd>
                {row.note === undefined ? null : (
                  <dd className="text-xs text-muted-foreground">{row.note}</dd>
                )}
              </div>
            ))}
          </dl>
          {skipped.length === 0 ? null : (
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                <Trans>Why emails were skipped</Trans>
              </span>
              <ul className="flex min-w-0 list-none flex-col p-0">
                {skipped.map((each) => (
                  <li
                    key={each.reason}
                    className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border py-1.5 text-md last:border-0"
                  >
                    <span className="min-w-0 wrap-anywhere">{each.label}</span>
                    <span className="shrink-0 font-medium">{each.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            <Trans>
              Counts cover every version of this workflow, for contacts who reached the action in
              these dates. Each email this action tried to send is listed in the Execution logs tab,
              under this action.
            </Trans>
          </p>
        </>
      )}
    </div>
  );
}
