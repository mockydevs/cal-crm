// What the Dashboard keeps in its address, and the plain checks that read it. Apart from
// the other rules (dashboard-report-rules.ts) because the route reads its address before
// the widgets' code arrives: only this much is in the first load.

/** The ranges on offer by name. Each ends where the reader's day does. */
export const rangePresets = [
  'today',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_month',
  'last_month',
  'this_year',
] as const;
export type RangePreset = (typeof rangePresets)[number];
export type RangeChoice = RangePreset | 'custom';

export const DEFAULT_PRESET: RangePreset = 'last_30_days';

/** What the Dashboard keeps in its address. The default range is left out. */
export interface DashboardSearch {
  readonly range?: RangeChoice;
  /** The first and last day of a custom range, as a date field gives them. */
  readonly from?: string;
  readonly to?: string;
}

export const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const isPreset = (value: unknown): value is RangePreset =>
  typeof value === 'string' && (rangePresets as readonly string[]).includes(value);

export function dashboardSearchOf(search: Record<string, unknown>): DashboardSearch {
  const { range, from, to } = search;
  if (range === 'custom')
    return {
      range,
      ...(typeof from === 'string' && dayPattern.test(from) ? { from } : {}),
      ...(typeof to === 'string' && dayPattern.test(to) ? { to } : {}),
    };
  return isPreset(range) && range !== DEFAULT_PRESET ? { range } : {};
}
