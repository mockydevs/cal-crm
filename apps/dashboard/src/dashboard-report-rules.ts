// The rules behind the Dashboard's opportunity widgets (dashboard-widgets.tsx): the range of
// dates the address names, what the report's numbers read as, and the geometry of the bars
// and the ring. The report itself is the server's (GET /reports/opportunities); nothing is
// counted here. What the address holds is read in dashboard-search.ts, which the route
// loads first.
import type { OpportunityReport } from '@repo/contracts';
import { barShare, moneyText } from './chart-numbers';
import {
  dashboardSearchOf,
  DEFAULT_PRESET,
  dayPattern as day,
  type DashboardSearch,
  type RangeChoice,
  type RangePreset,
} from './dashboard-search';

export { barShare, moneyText, percentText } from './chart-numbers';
export {
  dashboardSearchOf,
  rangePresets,
  type DashboardSearch,
  type RangeChoice,
  type RangePreset,
} from './dashboard-search';

/** The longest range the report reads, in days (the contract's limit; a test holds them equal). */
export const MAX_RANGE_DAYS = 1096;
const DAY = 86_400_000;

/**
 * The range to ask the report for: `from` and `to` as the server takes them (deals dated at
 * or after `from` and before `to`), and the first and last day it covers, as a date field
 * shows them. Or why a custom range cannot be asked for.
 */
export type ReportRange =
  | {
      readonly ok: true;
      readonly from: string;
      readonly to: string;
      readonly first: string;
      readonly last: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'incomplete' | 'order' | 'too_long';
      readonly first: string;
      readonly last: string;
    };

const two = (value: number): string => String(value).padStart(2, '0');
const dayText = (date: Date): string =>
  `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;

/** The start of a day chosen in a date field, where the reader is. None for a day that is not one. */
function startOfDay(value: string | undefined): Date | undefined {
  const match = value === undefined ? null : day.exec(value);
  if (match === null) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return dayText(date) === value ? date : undefined;
}

/** The first day of a preset and the day after its last, counted from today. */
function presetDays(preset: RangePreset, now: Date): [Date, Date] {
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  const tomorrow = new Date(year, month, date + 1);
  switch (preset) {
    case 'today':
      return [new Date(year, month, date), tomorrow];
    case 'last_7_days':
      return [new Date(year, month, date - 6), tomorrow];
    case 'last_30_days':
      return [new Date(year, month, date - 29), tomorrow];
    case 'last_90_days':
      return [new Date(year, month, date - 89), tomorrow];
    case 'this_month':
      return [new Date(year, month, 1), new Date(year, month + 1, 1)];
    case 'last_month':
      return [new Date(year, month - 1, 1), new Date(year, month, 1)];
    case 'this_year':
      return [new Date(year, 0, 1), new Date(year + 1, 0, 1)];
  }
}

export function rangeOf(search: DashboardSearch, now: Date): ReportRange {
  if (search.range !== 'custom') {
    const [start, end] = presetDays(search.range ?? DEFAULT_PRESET, now);
    const lastDay = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
    return {
      ok: true,
      from: start.toISOString(),
      to: end.toISOString(),
      first: dayText(start),
      last: dayText(lastDay),
    };
  }
  const first = search.from ?? '';
  const last = search.to ?? '';
  const start = startOfDay(search.from);
  const lastDay = startOfDay(search.to);
  if (start === undefined || lastDay === undefined)
    return { ok: false, reason: 'incomplete', first, last };
  const end = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1);
  if (lastDay.getTime() < start.getTime()) return { ok: false, reason: 'order', first, last };
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * DAY)
    return { ok: false, reason: 'too_long', first, last };
  return { ok: true, from: start.toISOString(), to: end.toISOString(), first, last };
}

/** The search for a range chosen by name. Custom starts as the days that were shown. */
export function withPreset(choice: RangeChoice, shown?: ReportRange): DashboardSearch {
  if (choice === 'custom') return withCustomRange(shown?.first ?? '', shown?.last ?? '');
  return choice === DEFAULT_PRESET ? {} : { range: choice };
}

export function withCustomRange(first: string, last: string): DashboardSearch {
  return dashboardSearchOf({ range: 'custom', from: first, to: last });
}

/** The parts of the report the widgets draw. */
export type ReportNumbers = Pick<
  OpportunityReport,
  'count' | 'statuses' | 'conversion' | 'funnel' | 'stages'
>;
export type ReportTotal = ReportNumbers['conversion']['wonTotals'][number];
export type DealStatus = ReportNumbers['statuses'][number]['status'];

export interface Ring {
  readonly circumference: number;
  readonly filled: number;
  /** The stroke-dasharray that draws the filled arc and leaves the rest. */
  readonly dash: string;
}

/** The arc of a ring of this radius that a rate from 0 to 1 fills. */
export function ringOf(rate: number | null, radius: number): Ring {
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * Math.min(Math.max(rate ?? 0, 0), 1);
  return {
    circumference,
    filled,
    dash: `${String(Number(filled.toFixed(2)))} ${String(Number((circumference - filled).toFixed(2)))}`,
  };
}

export interface ValueGroup {
  readonly currency: string;
  readonly rows: readonly {
    readonly status: DealStatus;
    readonly text: string;
    readonly share: number;
  }[];
}

/**
 * Opportunity value, one group for each currency in the order of their codes: what each
 * status adds up to, and its bar against the largest of that currency. A bar's length is
 * the only place an amount is read as a number; what is written stays exact.
 */
export function valueGroups(statuses: ReportNumbers['statuses']): ValueGroup[] {
  const currencies = [
    ...new Set(statuses.flatMap((status) => status.totals.map((total) => total.currency))),
  ].toSorted((one, other) => one.localeCompare(other));
  return currencies.map((currency) => {
    const amounts = statuses.map(
      (status) => status.totals.find((total) => total.currency === currency)?.amount ?? '0',
    );
    const longest = Math.max(...amounts.map(Number));
    return {
      currency,
      rows: statuses.map((status, index) => {
        const amount = amounts[index] ?? '0';
        return {
          status: status.status,
          text: moneyText({ currency, amount }),
          share: barShare(Number(amount), longest),
        };
      }),
    };
  });
}

export const widgetKinds = ['status', 'value', 'conversion', 'funnel', 'stages'] as const;
export type WidgetKind = (typeof widgetKinds)[number];

/** Whether a widget has nothing to draw for the range: it then says "No data found". */
export function widgetEmpty(kind: WidgetKind, report: ReportNumbers): boolean {
  switch (kind) {
    case 'status':
      return report.count === 0;
    case 'value':
      return report.statuses.every((status) => status.totals.length === 0);
    case 'conversion':
      return report.conversion.total === 0;
    case 'funnel':
      return report.funnel.every((section) => section.count === 0);
    case 'stages':
      return report.stages.every((stage) => stage.count === 0);
  }
}

/** The pipelines a widget offers: the ones in use, or all when every one is archived. */
export function pipelineChoices<P extends { readonly archived: boolean }>(
  items: readonly P[],
): readonly P[] {
  const active = items.filter((item) => !item.archived);
  return active.length > 0 ? active : items;
}
