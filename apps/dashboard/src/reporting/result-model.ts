// What a report query's answer becomes before it is drawn (packages/contracts
// reporting-query.ts, ReportResult): the categories along a chart's axis, its series, the
// lines of a number card, and the rows of a table. Money is never added across currencies:
// a money measure gives one series for each currency, and series of different units are
// drawn in panels of their own, so no axis mixes counts with money or one currency with
// another. Nothing is counted here; a missing combination is the server's zero.
import type { ReportGrain, ReportResult, ReportRow } from '@repo/contracts';
import {
  amountsOf,
  bucketText,
  cellLines,
  cellOrder,
  comparedOf,
  countText,
  moneyText,
  weekdayText,
  type Compared,
} from './format';

type Column = ReportResult['columns'][number];
type GroupEntry = ReportRow['group'][number];

/** The words a model needs that the answer does not carry. */
export interface ModelWords {
  /** The row that adds up the groups past the limit. */
  readonly other: string;
  /** A group without a value, such as contacts with no campaign. */
  readonly none: string;
  /** The one category of an answer that is not grouped. */
  readonly total: string;
  /** A series of the comparison period, by the name of the series it is compared with. */
  readonly previous: (label: string) => string;
  /** A week by its first day. */
  readonly weekOf: (day: string) => string;
}

export interface Category {
  readonly key: string;
  /** Short, for an axis. */
  readonly label: string;
  /** Whole, for a table and for what is read out. */
  readonly long: string;
  readonly other: boolean;
}

export interface Series {
  readonly key: string;
  readonly label: string;
  /** One for each category, for the drawing. */
  readonly values: readonly number[];
  /** One for each category, as written. */
  readonly texts: readonly string[];
  /** True for the same measure over the comparison period. */
  readonly compare: boolean;
}

export interface Panel {
  /** The currency its series are in; null for counts. */
  readonly unit: string | null;
  readonly series: readonly Series[];
}

export interface ChartModel {
  readonly categories: readonly Category[];
  readonly panels: readonly Panel[];
  /** The grain of the categories, when they are buckets of time. */
  readonly grain: ReportGrain | null;
}

const isGrain = (kind: string): kind is ReportGrain =>
  kind === 'day' || kind === 'week' || kind === 'month';

const OTHER_KEY = '\u0000other';
const NONE_KEY = '\u0000none';

function entryText(
  column: Column,
  entry: GroupEntry | undefined,
  other: boolean,
  locale: string,
  words: ModelWords,
  form: 'short' | 'long',
): string {
  const key = entry?.key ?? null;
  if (isGrain(column.kind) && key !== null) {
    const text = bucketText(key, column.kind, locale, form);
    return column.kind === 'week' && form === 'long' ? words.weekOf(text) : text;
  }
  if (key === null && other) return words.other;
  const label = entry?.label ?? '';
  if (label !== '') return label;
  if (column.kind === 'weekday' && key !== null && Number(key) >= 1 && Number(key) <= 7)
    return weekdayText(Number(key), locale, form);
  return key ?? words.none;
}

const entryKey = (entry: GroupEntry | undefined, other: boolean): string =>
  entry?.key ?? (other ? OTHER_KEY : NONE_KEY);

const zeroText = (unit: string | null, locale: string): string =>
  unit === null ? countText(0, locale) : moneyText({ currency: unit, amount: '0' });

interface Building {
  readonly key: string;
  readonly label: string;
  readonly unit: string | null;
  readonly compare: boolean;
  readonly cells: Map<number, { value: number; text: string }>;
}

/** The answer as a chart's categories and series. */
export function chartModel(result: ReportResult, locale: string, words: ModelWords): ChartModel {
  const groupColumns = result.columns.filter((column) => column.role !== 'measure');
  const measures = result.columns.filter((column) => column.role === 'measure');
  const timePlace = groupColumns.findIndex((column) => column.role === 'time');
  const categoryPlace = groupColumns.length === 0 ? -1 : Math.max(timePlace, 0);
  const categoryColumn = groupColumns[categoryPlace];
  const seriesPlaces = groupColumns.map((_, place) => place).filter((p) => p !== categoryPlace);
  const withCompare =
    result.compare !== undefined && seriesPlaces.length === 0 && categoryColumn !== undefined;

  const categories: Category[] = [];
  const places = new Map<string, number>();
  const building = new Map<string, Building>();

  const put = (
    seriesKey: string,
    label: string,
    compare: boolean,
    category: number,
    cell: ReportRow['values'][number] | undefined,
  ): void => {
    for (const amount of amountsOf(cell, locale)) {
      const key = `${seriesKey}\u0001${amount.currency ?? ''}\u0001${compare ? 'c' : ''}`;
      let series = building.get(key);
      if (series === undefined) {
        series = { key, label, unit: amount.currency, compare, cells: new Map() };
        building.set(key, series);
      }
      series.cells.set(category, { value: amount.value, text: amount.text });
    }
  };

  const rows: readonly Pick<ReportRow, 'group' | 'other' | 'values' | 'compare'>[] =
    categoryColumn === undefined
      ? [
          {
            group: [],
            other: false,
            values: result.totals,
            ...(result.compare === undefined ? {} : { compare: result.compare.totals }),
          },
        ]
      : result.rows;

  for (const row of rows) {
    let category = 0;
    if (categoryColumn === undefined) {
      if (categories.length === 0)
        categories.push({ key: 'total', label: words.total, long: words.total, other: false });
    } else {
      const entry = row.group[categoryPlace];
      // In a row of "Other" every group is empty, but a bucket of time keeps its day.
      const other = row.other && (entry?.key ?? null) === null;
      const key = entryKey(entry, other);
      const known = places.get(key);
      if (known === undefined) {
        category = categories.length;
        places.set(key, category);
        categories.push({
          key,
          label: entryText(categoryColumn, entry, other, locale, words, 'short'),
          long: entryText(categoryColumn, entry, other, locale, words, 'long'),
          other,
        });
      } else category = known;
    }
    const groupKey = seriesPlaces.map((place) => entryKey(row.group[place], row.other)).join('|');
    const groupLabel = seriesPlaces
      .map((place) => {
        const column = groupColumns[place];
        return column === undefined
          ? ''
          : entryText(column, row.group[place], row.other, locale, words, 'long');
      })
      .join(' · ');
    for (const [index, measure] of measures.entries()) {
      const label =
        seriesPlaces.length === 0
          ? measure.label
          : measures.length > 1
            ? `${groupLabel} · ${measure.label}`
            : groupLabel;
      const seriesKey = `${groupKey}\u0001${measure.key}`;
      put(seriesKey, label, false, category, row.values[index]);
      if (withCompare || categoryColumn === undefined)
        put(seriesKey, words.previous(label), true, category, row.compare?.[index]);
    }
  }

  const panels = new Map<string | null, Series[]>();
  for (const series of building.values()) {
    const zero = zeroText(series.unit, locale);
    const list = panels.get(series.unit) ?? [];
    list.push({
      key: series.key,
      label: series.label,
      compare: series.compare,
      values: categories.map((_, index) => series.cells.get(index)?.value ?? 0),
      texts: categories.map((_, index) => series.cells.get(index)?.text ?? zero),
    });
    panels.set(series.unit, list);
  }
  return {
    categories,
    grain:
      categoryColumn !== undefined && isGrain(categoryColumn.kind) ? categoryColumn.kind : null,
    panels: [...panels.entries()]
      .toSorted(([one], [other]) => (one ?? '').localeCompare(other ?? ''))
      .map(([unit, series]) => ({
        unit,
        // A measure, then the same measure before: the pair reads together.
        series: series.toSorted((one, other) => Number(one.compare) - Number(other.compare)),
      })),
  };
}

export interface StatLine {
  readonly key: string;
  readonly label: string;
  /** One for each currency; one for a count; none where money has no value at all. */
  readonly amounts: readonly Compared[];
}

/** The answer as a number card's lines: each measure over the whole range, and before. */
export function statLines(result: ReportResult, locale: string): StatLine[] {
  return result.columns
    .filter((column) => column.role === 'measure')
    .map((measure, index) => ({
      key: measure.key,
      label: measure.label,
      amounts: comparedOf(result.totals[index], result.compare?.totals[index], locale),
    }));
}

/** Whether the answer has nothing to draw: no rows, and nothing in any total. */
export function isEmptyResult(result: ReportResult): boolean {
  const nothing = (cell: ReportResult['totals'][number]): boolean =>
    cell === null ||
    cell === 0 ||
    (Array.isArray(cell) && cell.every((m) => Number(m.amount) === 0));
  return result.totals.every(nothing) && result.rows.every((row) => row.values.every(nothing));
}

export interface TableColumn {
  readonly key: string;
  readonly label: string;
  readonly numeric: boolean;
}

export interface TableRow {
  readonly key: string;
  readonly other: boolean;
  /** One for each column: its lines of text, one for each currency. */
  readonly cells: readonly (readonly string[])[];
  /** One for each column: what the row is ordered by there. */
  readonly order: readonly (number | string)[];
}

export interface TableModel {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
}

/** The answer as a table: its group columns, then each measure, with the period before. */
export function tableModel(result: ReportResult, locale: string, words: ModelWords): TableModel {
  const groupColumns = result.columns.filter((column) => column.role !== 'measure');
  const measures = result.columns.filter((column) => column.role === 'measure');
  const compared = result.compare !== undefined;
  const columns: TableColumn[] = [
    ...groupColumns.map((column) => ({ key: column.key, label: column.label, numeric: false })),
    ...measures.flatMap((measure) => [
      { key: measure.key, label: measure.label, numeric: true },
      ...(compared
        ? [{ key: `${measure.key}:before`, label: words.previous(measure.label), numeric: true }]
        : []),
    ]),
  ];
  const rows = result.rows.map((row, index): TableRow => {
    const groups = groupColumns.map((column, place) => {
      const other = row.other && (row.group[place]?.key ?? null) === null;
      return entryText(column, row.group[place], other, locale, words, 'long');
    });
    const groupOrder = groupColumns.map((column, place) =>
      isGrain(column.kind) || column.kind === 'weekday'
        ? (row.group[place]?.key ?? '')
        : (groups[place] ?? '').toLowerCase(),
    );
    const values = measures.flatMap((_, place) => [
      row.values[place],
      ...(compared ? [row.compare?.[place]] : []),
    ]);
    return {
      key: `${String(index)}:${row.group.map((entry) => entry.key ?? '').join('|')}`,
      other: row.other,
      cells: [...groups.map((text) => [text]), ...values.map((cell) => cellLines(cell, locale))],
      order: [...groupOrder, ...values.map(cellOrder)],
    };
  });
  return { columns, rows };
}

export interface Sort {
  readonly column: number;
  readonly direction: 'asc' | 'desc';
}

/** Rows in the order asked for. The row of "Other" stays last, whatever the order. */
export function sortedRows<Row extends Pick<TableRow, 'other' | 'order'>>(
  rows: readonly Row[],
  sort: Sort | undefined,
): Row[] {
  if (sort === undefined) return [...rows];
  const sign = sort.direction === 'asc' ? 1 : -1;
  return rows.toSorted((one, other) => {
    if (one.other !== other.other) return one.other ? 1 : -1;
    const a = one.order[sort.column] ?? '';
    const b = other.order[sort.column] ?? '';
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
    return String(a).localeCompare(String(b), undefined, { numeric: true }) * sign;
  });
}

/** The sort after a column's heading is pressed: that column, turned round if it was the one. */
export function nextSort(sort: Sort | undefined, column: number, numeric: boolean): Sort {
  if (sort?.column === column)
    return { column, direction: sort.direction === 'asc' ? 'desc' : 'asc' };
  // Numbers are wanted largest first, names from A.
  return { column, direction: numeric ? 'desc' : 'asc' };
}
