// The Dashboard's opportunity widgets, as GoHighLevel lays them out: a date range for the
// page, then Opportunity status, Opportunity value, Conversion rate, Funnel and Stages
// distribution, each with its own pipeline and the date it goes by. Every number is the
// server's (GET /reports/opportunities); the drawings are SVG in the design system's
// colours, and each has its numbers beside it as text. Loaded on its own, after the page
// (dashboard-widgets-loader.tsx).
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  getOpportunityReport,
  getPipelines,
  type OpportunityReportDate,
  type Pipeline,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import { BookingsWidget, EmailWidget } from './dashboard-activity-widgets';
import { Link } from '@tanstack/react-router';
import { ChartNoAxesColumn, SquareKanban } from 'lucide-react';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { apiIn } from './api';
import {
  barShare,
  MAX_RANGE_DAYS,
  moneyText,
  percentText,
  pipelineChoices,
  rangeOf,
  rangePresets,
  ringOf,
  valueGroups,
  widgetEmpty,
  widgetKinds,
  withCustomRange,
  withPreset,
  type DashboardSearch,
  type DealStatus,
  type RangeChoice,
  type ReportNumbers,
  type ReportRange,
  type ReportTotal,
  type WidgetKind,
} from './dashboard-report-rules';
import { useBusiness } from './workspace';

export interface DashboardWidgetsProps {
  readonly search: DashboardSearch;
  readonly onSearch: (search: DashboardSearch) => void;
}

type OkRange = Extract<ReportRange, { ok: true }>;

const isRangeChoice = (value: string): value is RangeChoice =>
  value === 'custom' || (rangePresets as readonly string[]).includes(value);

export default function DashboardWidgets({
  search,
  onSearch,
}: DashboardWidgetsProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const client = apiIn(business.id);
  // The same read, under the same key, as the Opportunities page: one is enough for both.
  const pipelines = useQuery({
    queryKey: ['pipelines', business.id],
    queryFn: () => client.request(getPipelines, {}),
  });
  // Today is read once: the range holds still while the page is open.
  const [now] = useState(() => new Date());
  const range = rangeOf(search, now);
  const choices = pipelineChoices(pipelines.data?.items ?? []);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <RangeToolbar search={search} range={range} onSearch={onSearch} />
      {pipelines.isPending ? (
        <p role="status">
          <Trans>Loading dashboard…</Trans>
        </p>
      ) : pipelines.isError ? (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p>
            <Trans>The dashboard couldn't be loaded.</Trans>
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              void pipelines.refetch();
            }}
          >
            <Trans>Try again</Trans>
          </Button>
        </div>
      ) : choices.length === 0 ? (
        <NoPipeline slug={business.slug} canManage={pipelines.data.canManage} />
      ) : range.ok ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-6">
          {widgetKinds.map((kind) => (
            <Widget
              key={kind}
              kind={kind}
              title={
                {
                  status: t`Opportunity status`,
                  value: t`Opportunity value`,
                  conversion: t`Conversion rate`,
                  funnel: t`Funnel`,
                  stages: t`Stages distribution`,
                }[kind]
              }
              businessId={business.id}
              pipelines={choices}
              range={range}
            />
          ))}
        </div>
      ) : null}
      {/* Email and bookings need no pipeline: they show whenever the dates are good. */}
      {range.ok ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-6">
          <EmailWidget businessId={business.id} range={range} />
          <BookingsWidget businessId={business.id} range={range} />
        </div>
      ) : null}
    </div>
  );
}

function RangeToolbar({
  search,
  range,
  onSearch,
}: DashboardWidgetsProps & { readonly range: ReportRange }): ReactElement {
  const { t } = useLingui();
  const fromId = useId();
  const toId = useId();
  const choice: RangeChoice = search.range ?? 'last_30_days';
  const labels: Record<RangeChoice, string> = {
    today: t`Today`,
    last_7_days: t`Last 7 days`,
    last_30_days: t`Last 30 days`,
    last_90_days: t`Last 90 days`,
    this_month: t`This month`,
    last_month: t`Last month`,
    this_year: t`This year`,
    custom: t`Custom range`,
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-end gap-2 lg:justify-end">
        <div className="w-full sm:w-52">
          <Select
            aria-label={t`Date range`}
            value={choice}
            onValueChange={(value) => {
              if (isRangeChoice(value)) onSearch(withPreset(value, range));
            }}
          >
            {[...rangePresets, 'custom' as const].map((preset) => (
              <option key={preset} value={preset}>
                {labels[preset]}
              </option>
            ))}
          </Select>
        </div>
        {choice === 'custom' ? (
          <>
            <div className="flex min-w-0 flex-1 flex-col gap-1 sm:w-40 sm:flex-none">
              <label className="text-xs font-medium text-body" htmlFor={fromId}>
                <Trans>From</Trans>
              </label>
              <Input
                id={fromId}
                type="date"
                value={range.first}
                aria-invalid={!range.ok}
                onChange={(event) => {
                  onSearch(withCustomRange(event.target.value, range.last));
                }}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1 sm:w-40 sm:flex-none">
              <label className="text-xs font-medium text-body" htmlFor={toId}>
                <Trans>To</Trans>
              </label>
              <Input
                id={toId}
                type="date"
                value={range.last}
                aria-invalid={!range.ok}
                onChange={(event) => {
                  onSearch(withCustomRange(range.first, event.target.value));
                }}
              />
            </div>
          </>
        ) : null}
      </div>
      {range.ok ? null : (
        <p role="alert" className="text-sm text-destructive lg:text-right">
          {range.reason === 'incomplete'
            ? t`Choose both days.`
            : range.reason === 'order'
              ? t`End the range on or after its first day.`
              : t`Choose at most ${MAX_RANGE_DAYS} days.`}
        </p>
      )}
    </div>
  );
}

/** As the Opportunities page says it: pipelines are created from its Pipelines tab. */
function NoPipeline({
  slug,
  canManage,
}: {
  readonly slug: string;
  readonly canManage: boolean;
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border bg-card px-6 py-12 text-center">
      <SquareKanban aria-hidden size={32} className="text-muted-foreground" />
      <h2 className="mt-1 text-lg font-medium">
        <Trans>No pipeline yet</Trans>
      </h2>
      {canManage ? (
        <>
          <p className="max-w-md text-md text-muted-foreground">
            <Trans>
              The dashboard shows how opportunities move through a pipeline. Create one to start
              tracking opportunities.
            </Trans>
          </p>
          <Link
            to="/b/$slug/deals/pipelines"
            params={{ slug }}
            search={{ mode: 'create' }}
            className="mt-2 inline-flex min-h-11 items-center justify-center rounded-control bg-primary px-3.5 text-md font-medium text-primary-foreground hover:bg-primary-hover lg:min-h-9"
          >
            <Trans>Create pipeline</Trans>
          </Link>
        </>
      ) : (
        <p className="max-w-md text-md text-muted-foreground">
          <Trans>
            The dashboard shows how opportunities move through a pipeline, and this business has
            none yet. Ask someone who manages pipelines to create one.
          </Trans>
        </p>
      )}
    </div>
  );
}

/** Three small cards in the first row, two wide ones in the second; one column below `lg`. */
const spans: Record<WidgetKind, string> = {
  status: 'lg:col-span-2',
  value: 'lg:col-span-2',
  conversion: 'lg:col-span-2',
  funnel: 'lg:col-span-3',
  stages: 'lg:col-span-3',
};

function Widget({
  kind,
  title,
  businessId,
  pipelines,
  range,
}: {
  readonly kind: WidgetKind;
  readonly title: string;
  readonly businessId: string;
  readonly pipelines: readonly Pipeline[];
  readonly range: OkRange;
}): ReactElement {
  const { t } = useLingui();
  const headingId = useId();
  const [chosen, setChosen] = useState<string>();
  const [dateProperty, setDateProperty] = useState<OpportunityReportDate>('status_changed');
  // A pipeline archived or removed since it was chosen gives way to the first on offer.
  const pipelineId = (pipelines.find((pipeline) => pipeline.id === chosen) ?? pipelines[0])?.id;
  const report = useQuery({
    // Widgets on the same pipeline, range and date share one read.
    queryKey: [
      'b',
      businessId,
      'opportunity-report',
      pipelineId,
      range.from,
      range.to,
      dateProperty,
    ],
    enabled: pipelineId !== undefined,
    queryFn: () =>
      apiIn(businessId).request(getOpportunityReport, {
        query: { pipelineId: pipelineId ?? '', from: range.from, to: range.to, dateProperty },
      }),
  });
  return (
    <section
      aria-labelledby={headingId}
      className={`flex min-w-0 flex-col gap-4 rounded-card border bg-card p-4 ${spans[kind]}`}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <h2 id={headingId} className="text-md font-medium text-foreground">
          {title}
        </h2>
        <div className="flex min-w-0 flex-wrap gap-2">
          <div className="min-w-36 flex-1">
            <Select
              aria-label={t`Pipeline for ${title}`}
              value={pipelineId ?? ''}
              onValueChange={setChosen}
            >
              {pipelines.map((pipeline) => (
                <option key={pipeline.id} value={pipeline.id}>
                  {pipeline.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-36 flex-1">
            <Select
              aria-label={t`Dates for ${title}`}
              value={dateProperty}
              onValueChange={(value) => {
                setDateProperty(value === 'created' ? 'created' : 'status_changed');
              }}
            >
              <option value="status_changed">{t`Last status change`}</option>
              <option value="created">{t`Created date`}</option>
            </Select>
          </div>
        </div>
      </div>
      <div className="flex min-h-48 min-w-0 flex-1 flex-col justify-center">
        {report.isPending ? (
          <p role="status" className="text-center text-sm text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : report.isError ? (
          <div role="alert" className="flex flex-col items-center gap-2 text-center text-sm">
            <p>
              <Trans>The numbers couldn't be loaded.</Trans>
            </p>
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void report.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          </div>
        ) : widgetEmpty(kind, report.data) ? (
          <div className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
            <span
              aria-hidden
              className="flex size-10 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
            >
              <ChartNoAxesColumn className="size-5" />
            </span>
            <p>
              <Trans>No data found</Trans>
            </p>
          </div>
        ) : (
          <WidgetBody kind={kind} title={title} report={report.data} />
        )}
      </div>
    </section>
  );
}

function WidgetBody({
  kind,
  title,
  report,
}: {
  readonly kind: WidgetKind;
  readonly title: string;
  readonly report: ReportNumbers;
}): ReactElement {
  switch (kind) {
    case 'status':
      return <StatusChart title={title} report={report} />;
    case 'value':
      return <ValueChart title={title} report={report} />;
    case 'conversion':
      return <ConversionRing report={report} />;
    case 'funnel':
      return <FunnelChart title={title} report={report} />;
    case 'stages':
      return <StagesChart title={title} report={report} />;
  }
}

/** Each status keeps one colour across the widgets, and always has its name beside it. */
const statusFill: Record<DealStatus, string> = {
  open: 'fill-primary',
  won: 'fill-success',
  lost: 'fill-destructive',
};

function useStatusName(): (status: DealStatus) => string {
  const { t } = useLingui();
  return (status) => ({ open: t`Open`, won: t`Won`, lost: t`Lost` })[status];
}

/** A horizontal bar: a track, filled from the left to `share` percent. For the eye only. */
function Bar({
  share,
  className,
}: {
  readonly share: number;
  readonly className: string;
}): ReactElement {
  return (
    <svg
      aria-hidden
      data-share={share}
      viewBox="0 0 100 8"
      preserveAspectRatio="none"
      className="mt-1.5 block h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <rect width={share} height="8" className={className} />
    </svg>
  );
}

const tableClassName = 'w-full table-fixed border-collapse text-left text-sm';
const headClassName = 'pb-2 text-xs font-medium text-muted-foreground';
const numberClassName = 'py-2 pl-3 text-right align-top tabular-nums text-foreground';

function Totals({ totals }: { readonly totals: readonly ReportTotal[] }): ReactNode {
  if (totals.length === 0) return '—';
  return totals.map((total) => (
    <span key={total.currency} className="block break-words">
      {moneyText(total)}
    </span>
  ));
}

function StatusChart({
  title,
  report,
}: {
  readonly title: string;
  readonly report: ReportNumbers;
}): ReactElement {
  const nameOf = useStatusName();
  const longest = Math.max(...report.statuses.map((status) => status.count));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <table className={tableClassName}>
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            <th scope="col" className={headClassName}>
              <Trans>Status</Trans>
            </th>
            <th scope="col" className={`${headClassName} w-28 text-right`}>
              <Trans>Opportunities</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {report.statuses.map((status) => (
            <tr key={status.status}>
              <th scope="row" className="py-2 font-normal text-body">
                {nameOf(status.status)}
                <Bar
                  share={barShare(status.count, longest)}
                  className={statusFill[status.status]}
                />
              </th>
              <td className={numberClassName}>{status.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm text-muted-foreground">
        <Plural value={report.count} one="# opportunity" other="# opportunities" />
      </p>
    </div>
  );
}

function ValueChart({
  title,
  report,
}: {
  readonly title: string;
  readonly report: ReportNumbers;
}): ReactElement {
  const nameOf = useStatusName();
  const groups = valueGroups(report.statuses);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {groups.map((group) => (
        <table key={group.currency} className={tableClassName}>
          <caption className="sr-only">
            {groups.length === 1 ? title : `${title} (${group.currency})`}
          </caption>
          <thead>
            <tr>
              <th scope="col" className={headClassName}>
                <Trans>Status</Trans>
              </th>
              <th scope="col" className={`${headClassName} w-36 text-right`}>
                <Trans>Value</Trans>
              </th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <tr key={row.status}>
                <th scope="row" className="py-2 font-normal text-body">
                  {nameOf(row.status)}
                  <Bar share={row.share} className={statusFill[row.status]} />
                </th>
                <td className={`${numberClassName} break-words`}>{row.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}

const RING_RADIUS = 50;

function ConversionRing({ report }: { readonly report: ReportNumbers }): ReactElement {
  const { conversion } = report;
  const ring = ringOf(conversion.rate, RING_RADIUS);
  return (
    <div className="flex min-w-0 flex-col items-center gap-3 text-center">
      <div className="relative size-36">
        <svg aria-hidden viewBox="0 0 120 120" className="size-full">
          <circle
            cx="60"
            cy="60"
            r={RING_RADIUS}
            strokeWidth="12"
            className="fill-none stroke-muted"
          />
          <circle
            data-ring
            cx="60"
            cy="60"
            r={RING_RADIUS}
            strokeWidth="12"
            strokeDasharray={ring.dash}
            transform="rotate(-90 60 60)"
            className="fill-none stroke-primary"
          />
        </svg>
        <p className="absolute inset-0 flex items-center justify-center text-2xl font-medium text-foreground tabular-nums">
          {percentText(conversion.rate)}
        </p>
      </div>
      <p className="text-sm text-body">
        <Plural
          value={conversion.total}
          one={`${String(conversion.won)} won of # opportunity`}
          other={`${String(conversion.won)} won of # opportunities`}
        />
      </p>
      <dl className="flex min-w-0 flex-col items-center gap-0.5">
        <dt className="text-xs text-muted-foreground">
          <Trans>Won revenue</Trans>
        </dt>
        <dd className="min-w-0 text-md font-medium text-foreground">
          <Totals totals={conversion.wonTotals} />
        </dd>
      </dl>
    </div>
  );
}

function FunnelChart({
  title,
  report,
}: {
  readonly title: string;
  readonly report: ReportNumbers;
}): ReactElement {
  return (
    <table className={`${tableClassName} self-start`}>
      <caption className="sr-only">{title}</caption>
      <thead>
        <tr>
          <th scope="col" className={headClassName}>
            <Trans>Stage</Trans>
          </th>
          <th scope="col" className={`${headClassName} w-24 text-right`}>
            <Trans>Cumulative</Trans>
          </th>
          <th scope="col" className={`${headClassName} w-24 text-right`}>
            <Trans>Next step conversion</Trans>
          </th>
        </tr>
      </thead>
      <tbody>
        {report.funnel.map((section) => (
          <tr key={section.stageId} className="border-t">
            <th scope="row" className="py-2 font-normal">
              <span className="block break-words font-medium text-foreground">{section.name}</span>{' '}
              <span className="block break-words text-xs text-body">
                <Plural value={section.count} one="# opportunity" other="# opportunities" />
                {section.totals.map((total) => ` · ${moneyText(total)}`).join('')}
              </span>
              {/* The section's deals over the first section's: the funnel's own shape. */}
              <Bar share={barShare(section.cumulativeRate ?? 0, 1)} className="fill-primary" />
            </th>
            <td className={numberClassName}>{percentText(section.cumulativeRate)}</td>
            <td className={numberClassName}>{percentText(section.nextStepRate)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StagesChart({
  title,
  report,
}: {
  readonly title: string;
  readonly report: ReportNumbers;
}): ReactElement {
  const { t } = useLingui();
  const archivedName = (name: string): string => t`${name} (archived)`;
  const longest = Math.max(...report.stages.map((stage) => stage.count));
  return (
    <table className={`${tableClassName} self-start`}>
      <caption className="sr-only">{title}</caption>
      <thead>
        <tr>
          <th scope="col" className={headClassName}>
            <Trans>Stage</Trans>
          </th>
          <th scope="col" className={`${headClassName} w-16 text-right`}>
            <Trans>Open</Trans>
          </th>
          <th scope="col" className={`${headClassName} w-32 text-right`}>
            <Trans>Value</Trans>
          </th>
        </tr>
      </thead>
      <tbody>
        {report.stages.map((stage) => (
          <tr key={stage.stageId} className="border-t">
            <th scope="row" className="py-2 font-normal">
              <span className="block break-words font-medium text-foreground">
                {stage.archived ? archivedName(stage.name) : stage.name}
              </span>
              <Bar share={barShare(stage.count, longest)} className="fill-primary" />
            </th>
            <td className={numberClassName}>{stage.count}</td>
            <td className={numberClassName}>
              <Totals totals={stage.totals} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
