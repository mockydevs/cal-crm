// One widget of a report: it sends its query with its own range and comparison, or the
// report's, and draws the answer as its kind says. Each widget loads, fails and is empty by
// itself: a query that took too long, too many requests, a source the role cannot read and
// a query the server refuses each say so in the widget, and the rest of the page stays as
// it is.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  runReportQuery,
  type ReportCompareMode,
  type ReportRangeInput,
  type ReportResolvedRange,
  type ReportResult,
  type ReportWidget,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, type ReactElement, type ReactNode } from 'react';
import { apiIn } from '../api';
import {
  BarChart,
  ChartEmpty,
  ChartLoading,
  DataTable,
  DonutChart,
  FunnelChart,
  HorizontalBarChart,
  LineChart,
  StatNumbers,
} from './charts';
import { axisText, countText } from './format';
import { reportingKeys } from './keys';
import { refusalOf, runnableOf, type ChartKind } from './query-rules';
import {
  chartModel,
  isEmptyResult,
  statLines,
  tableModel,
  type ChartModel,
  type Panel,
} from './result-model';
import { useReportWords, type ReportWords } from './words';

export interface ReportDates {
  readonly range: ReportRangeInput;
  readonly compare: ReportCompareMode | null;
}

/** A refused query is not asked again by itself; a fault is, twice. */
const retryQuery = (failures: number, error: unknown): boolean =>
  !(error instanceof ApiError && error.status < 500) && failures < 2;

function Problem({
  children,
  onRetry,
}: {
  readonly children: ReactNode;
  readonly onRetry?: () => void;
}): ReactElement {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 py-4 text-sm">
      <div className="text-body">{children}</div>
      {onRetry === undefined ? null : (
        <Button variant="secondary" size="small" onClick={onRetry}>
          <Trans>Try again</Trans>
        </Button>
      )}
    </div>
  );
}

function Sentences({ items }: { readonly items: readonly string[] }): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <ul className="list-disc pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

/** A panel's name where a chart has more than one: its currency, or "Counts". */
function PanelCaption({
  panel,
  several,
}: {
  readonly panel: Panel;
  readonly several: boolean;
}): ReactElement | null {
  if (panel.unit === null && !several) return null;
  return (
    <p className="text-xs font-medium text-muted-foreground">
      {panel.unit ?? <Trans>Counts</Trans>}
    </p>
  );
}

function Drawing({
  kind,
  title,
  result,
  model,
  categoryLabel,
  height,
  locale,
}: {
  readonly kind: Exclude<ChartKind, 'stat' | 'table'>;
  readonly title: string;
  readonly result: ReportResult;
  readonly model: ChartModel;
  readonly categoryLabel: string;
  readonly height: number;
  readonly locale: string;
}): ReactElement {
  const several = model.panels.length > 1;
  const tickText = (value: number): string => axisText(value, locale);
  const total = result.totals[0];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {model.panels.map((panel) => {
        const label = panel.unit === null ? title : `${title} (${panel.unit})`;
        const shared = {
          label,
          categoryLabel,
          categories: model.categories,
          series: panel.series,
          tickText,
          whole: panel.unit === null,
          height,
        };
        return (
          <div key={panel.unit ?? 'count'} className="flex min-w-0 flex-col gap-1.5">
            <PanelCaption panel={panel} several={several} />
            {kind === 'line' || kind === 'area' ? (
              <LineChart {...shared} area={kind === 'area'} />
            ) : kind === 'bar' ? (
              <BarChart {...shared} />
            ) : kind === 'hbar' ? (
              <HorizontalBarChart
                label={label}
                categories={model.categories}
                series={panel.series}
              />
            ) : (
              panel.series
                .filter((series) => !series.compare)
                .map((series) => {
                  const marks = model.categories.map((category, index) => ({
                    key: category.key,
                    label: category.long,
                    value: series.values[index] ?? 0,
                    text: series.texts[index] ?? '',
                  }));
                  const name = panel.series.length > 1 ? `${label}: ${series.label}` : label;
                  return kind === 'donut' ? (
                    <DonutChart
                      key={series.key}
                      label={name}
                      segments={marks}
                      {...(typeof total === 'number' && panel.unit === null
                        ? { centre: countText(total, locale) }
                        : {})}
                    />
                  ) : (
                    <FunnelChart key={series.key} label={name} steps={marks} />
                  );
                })
            )}
          </div>
        );
      })}
    </div>
  );
}

function Answer({
  widget,
  result,
  words,
}: {
  readonly widget: ReportWidget;
  readonly result: ReportResult;
  readonly words: ReportWords;
}): ReactElement {
  const { t, i18n } = useLingui();
  const locale = i18n.locale;
  const kind = widget.kind;
  const title = widget.title === '' ? words.kind(kind) : widget.title;
  const kept = result.truncated.limit;
  const notes = (
    <>
      {result.truncated.other ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Showing the top {kept}; the rest are added up as Other.</Trans>
        </p>
      ) : null}
      {result.truncated.incomplete ? (
        <p className="text-xs text-muted-foreground">
          <Trans>There are more groups than can be read at once, so Other is incomplete.</Trans>
        </p>
      ) : null}
    </>
  );
  if (kind === 'stat') return <StatNumbers values={statLines(result, locale)} />;
  if (isEmptyResult(result)) return <ChartEmpty />;
  if (kind === 'table' || kind === 'text') {
    const model = tableModel(result, locale, words);
    return (
      <div className="flex min-w-0 flex-col gap-2">
        {model.rows.length === 0 ? (
          <StatNumbers values={statLines(result, locale)} />
        ) : (
          <DataTable label={title} columns={model.columns} rows={model.rows} />
        )}
        {notes}
      </div>
    );
  }
  const model = chartModel(result, locale, words);
  const groups = result.columns.filter((column) => column.role !== 'measure');
  const category = groups.find((column) => column.role === 'time') ?? groups[0];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Drawing
        kind={kind}
        title={title}
        result={result}
        model={model}
        categoryLabel={category?.label ?? t`Total`}
        height={Math.min(Math.max(widget.h * 56, 160), 420)}
        locale={locale}
      />
      {notes}
    </div>
  );
}

export interface WidgetBodyProps {
  readonly businessId: string;
  readonly widget: ReportWidget;
  readonly dates: ReportDates;
  readonly onResolved?: (range: ReportResolvedRange, timeZone: string) => void;
}

/**
 * What a widget shows: its text, or its query's answer. `onResolved` hears the days and the
 * time zone the server read the report's own range as, so the page can say them once.
 */
export function WidgetBody({
  businessId,
  widget,
  dates,
  onResolved,
}: WidgetBodyProps): ReactElement {
  const words = useReportWords();
  const runnable = widget.kind === 'text' ? undefined : runnableOf(widget, dates);
  const query = runnable?.ok === true ? runnable.query : undefined;
  const answer = useQuery({
    queryKey: reportingKeys.query(businessId, query),
    queryFn: () =>
      query === undefined
        ? Promise.reject(new Error('No query'))
        : apiIn(businessId).request(runReportQuery, { body: query }),
    enabled: query !== undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: retryQuery,
  });
  const result = query === undefined ? undefined : answer.data;
  const ownRange = widget.range !== undefined;
  useEffect(() => {
    if (result !== undefined && !ownRange) onResolved?.(result.range, result.timeZone);
  }, [result, ownRange, onResolved]);

  if (widget.kind === 'text')
    return <p className="text-md break-words whitespace-pre-wrap text-body">{widget.text ?? ''}</p>;
  if (runnable?.ok === false)
    return (
      <Problem>
        <p>
          <Trans>This widget can't run yet:</Trans>
        </p>
        <Sentences items={runnable.messages} />
      </Problem>
    );
  if (answer.isError && !answer.isFetching) {
    const refusal = refusalOf(answer.error instanceof ApiError ? answer.error.problem : undefined);
    const retry = (): void => {
      void answer.refetch();
    };
    switch (refusal.kind) {
      case 'forbidden':
        return (
          <Problem>
            <p>
              <Trans>You need permission to read what this widget shows.</Trans>
            </p>
          </Problem>
        );
      case 'timeout':
        return (
          <Problem onRetry={retry}>
            <p>
              <Trans>This query took too long. Narrow the dates, or group by less.</Trans>
            </p>
          </Problem>
        );
      case 'rate_limited':
        return (
          <Problem onRetry={retry}>
            <p>
              <Trans>Too many requests just now. Wait a minute, then try again.</Trans>
            </p>
          </Problem>
        );
      case 'invalid':
      case 'conflict':
      case 'not_found':
        return (
          <Problem>
            <p>
              <Trans>The server refused this widget's query:</Trans>
            </p>
            <Sentences items={refusal.messages} />
          </Problem>
        );
      case 'fault':
        return (
          <Problem onRetry={retry}>
            <p>
              <Trans>This widget couldn't be loaded.</Trans>
            </p>
          </Problem>
        );
    }
  }
  if (result === undefined) return <ChartLoading />;
  return (
    <div aria-busy={answer.isFetching} className="min-w-0">
      <Answer widget={widget} result={result} words={words} />
    </div>
  );
}
