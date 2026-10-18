// What Reporting's pages keep in their addresses, and the plain checks that read it. Kept
// apart, importing nothing, because a route reads its address before the page's own code
// arrives: only this much is in the first load. The presets are the contract's (a test
// holds the two lists equal).

export const rangePresetNames = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
  'last_12_months',
] as const;
export type RangePresetName = (typeof rangePresetNames)[number];
export type RangeChoice = RangePresetName | 'custom';

/** What a fixed report shows when its address names no range. */
export const DEFAULT_RANGE: RangePresetName = 'last_30_days';

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const isPreset = (value: unknown): value is RangePresetName =>
  typeof value === 'string' && (rangePresetNames as readonly string[]).includes(value);
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && dayPattern.test(value);
const idOf = (value: unknown, prefix: string): string | undefined =>
  typeof value === 'string' && value.startsWith(prefix) && /^[a-z]+_[0-9a-z]{6,40}$/.test(value)
    ? value
    : undefined;

/** The range part of an address. The default range is left out. */
export interface RangeSearch {
  readonly range?: RangeChoice;
  /** The first and last day of a custom range, as a date field gives them. */
  readonly from?: string;
  readonly to?: string;
}

export function rangeSearchOf(search: Record<string, unknown>): RangeSearch {
  const { range, from, to } = search;
  if (range === 'custom')
    return { range, ...(isDay(from) ? { from } : {}), ...(isDay(to) ? { to } : {}) };
  return isPreset(range) && range !== DEFAULT_RANGE ? { range } : {};
}

/** The Attribution report's address: first touch and the conversion view are left out. */
export interface AttributionSearch extends RangeSearch {
  readonly attribution?: 'latest';
  readonly view?: 'source';
}

export function attributionSearchOf(search: Record<string, unknown>): AttributionSearch {
  return {
    ...rangeSearchOf(search),
    ...(search['attribution'] === 'latest' ? { attribution: 'latest' as const } : {}),
    ...(search['view'] === 'source' ? { view: 'source' as const } : {}),
  };
}

/** The Appointment report's address: by start date and first touch are left out. */
export interface AppointmentSearch extends RangeSearch {
  readonly by?: 'created';
  readonly calendar?: string;
  readonly attribution?: 'latest';
}

export function appointmentSearchOf(search: Record<string, unknown>): AppointmentSearch {
  const calendar = idOf(search['calendar'], 'cal_');
  return {
    ...rangeSearchOf(search),
    ...(search['by'] === 'created' ? { by: 'created' as const } : {}),
    ...(calendar === undefined ? {} : { calendar }),
    ...(search['attribution'] === 'latest' ? { attribution: 'latest' as const } : {}),
  };
}

/** A saved report's address: which of its pages shows, and whether it is being changed. */
export interface ReportSearch {
  readonly page?: number;
  readonly edit?: true;
}

export function reportSearchOf(search: Record<string, unknown>): ReportSearch {
  const page = Number(search['page']);
  return {
    ...(Number.isInteger(page) && page >= 2 && page <= 20 ? { page } : {}),
    ...(search['edit'] === true || search['edit'] === 'true' || search['edit'] === 1
      ? { edit: true as const }
      : {}),
  };
}
