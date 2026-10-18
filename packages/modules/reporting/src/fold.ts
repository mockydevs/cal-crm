// From the rows the database counted to the rows of an answer, with no database: which
// groups are kept and which are added up as "Other", the zeros of buckets nothing happened
// in, the comparison beside each row, and money as exact decimals for each currency.
import type { ReportCell } from '@repo/contracts';

/** One group the database counted: by bucket, by the groups' keys and, for money, by currency. */
export interface RawRow {
  /** The bucket's first day; null when the query has no grain of time. */
  readonly bucket: string | null;
  /** One key for each dimension grouped by, as text; null where the row has no value. */
  readonly keys: readonly (string | null)[];
  readonly currency: string | null;
  /** Rows counted. */
  readonly n: number;
  /** Rows that have an amount. */
  readonly valued: number;
  /** The sum of the amounts, as a decimal with at most four places. */
  readonly amount: string;
  /** Different contacts among the rows. */
  readonly people: number;
}

/** What a measure reads of the counted rows. */
export type MeasureRead = 'rows' | 'people' | 'sum' | 'average';

const SCALE = 10_000n;

/** A decimal with at most four places as a whole number of ten-thousandths. */
export function toUnits(amount: string): bigint {
  const negative = amount.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? amount.slice(1) : amount).split('.');
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(4, '0').slice(0, 4));
  return negative ? -units : units;
}

/** Ten-thousandths as a decimal with four places. */
export function fromUnits(units: bigint): string {
  const magnitude = units < 0n ? -units : units;
  const text = `${String(magnitude / SCALE)}.${String(magnitude % SCALE).padStart(4, '0')}`;
  return units < 0n ? `-${text}` : text;
}

/** A sum over a count, rounded half away from zero to four places. */
function average(units: bigint, count: number): bigint {
  const by = BigInt(count);
  const sign = units < 0n ? -1n : 1n;
  return (2n * units + sign * by) / (2n * by);
}

interface Tally {
  n: number;
  /** Null once rows of several groups were added: different contacts cannot be added up. */
  people: number | null;
  readonly money: Map<string, { valued: number; units: bigint }>;
}

/** The rows added up. `whole` says they are one group as counted, so its people stand. */
function tallyOf(rows: readonly RawRow[], whole: boolean): Tally {
  const tally: Tally = { n: 0, people: whole ? 0 : null, money: new Map() };
  for (const row of rows) {
    tally.n += row.n;
    if (tally.people !== null) tally.people += row.people;
    if (row.currency === null) continue;
    const held = tally.money.get(row.currency) ?? { valued: 0, units: 0n };
    held.valued += row.valued;
    held.units += toUnits(row.amount);
    tally.money.set(row.currency, held);
  }
  return tally;
}

function cellOf(read: MeasureRead, tally: Tally): ReportCell {
  if (read === 'rows') return tally.n;
  if (read === 'people') return tally.people;
  return [...tally.money.entries()]
    .filter(([, held]) => held.valued > 0)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([currency, held]) => ({
      currency,
      amount: fromUnits(read === 'sum' ? held.units : average(held.units, held.valued)),
    }));
}

/**
 * What a tally weighs when groups are ordered by a measure. Money of several currencies is
 * added as plain numbers: good enough to order by, and never shown.
 */
function weightOf(read: MeasureRead, tally: Tally): number {
  if (read === 'rows') return tally.n;
  if (read === 'people') return tally.people ?? 0;
  let weight = 0;
  for (const held of tally.money.values())
    if (held.valued > 0)
      weight += Number(read === 'sum' ? held.units : average(held.units, held.valued)) / 1e4;
  return weight;
}

/** The cells of an answer's totals: every counted row of the range, as one group. */
export function totalsOf(reads: readonly MeasureRead[], rows: readonly RawRow[]): ReportCell[] {
  const tally = tallyOf(rows, true);
  return reads.map((read) => cellOf(read, tally));
}

export interface FoldedRow {
  /** The bucket's first day; null without a grain of time. */
  readonly bucket: string | null;
  /** The group's keys; null for the "Other" row. */
  readonly keys: readonly (string | null)[] | null;
  readonly values: ReportCell[];
  readonly compare?: ReportCell[];
}

export interface FoldInput {
  readonly reads: readonly MeasureRead[];
  /** How many dimensions the rows are grouped by. */
  readonly dimensions: number;
  /** The range's buckets in order; null without a grain of time. */
  readonly buckets: readonly string[] | null;
  readonly rows: readonly RawRow[];
  /** The comparison period's rows and buckets, when one was asked for. */
  readonly compare?: {
    readonly rows: readonly RawRow[];
    readonly buckets: readonly string[] | null;
  };
  /** The measure groups are ordered by, as its place in `reads`; or the groups' own order. */
  readonly orderBy: number | 'group';
  readonly direction: 'asc' | 'desc';
  /** How many groups are kept; the rest become one "Other" row. */
  readonly limit: number;
  /** A group's place in its own order: compared part by part. */
  readonly rank: (keys: readonly (string | null)[]) => readonly (string | number)[];
}

const idOf = (keys: readonly (string | null)[]): string => JSON.stringify(keys);

function byRank(left: readonly (string | number)[], right: readonly (string | number)[]): number {
  for (const [index, a] of left.entries()) {
    const b = right[index];
    if (b === undefined || a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a) < String(b) ? -1 : 1;
  }
  return 0;
}

/** Rows by group, and within a group by bucket ('' without one). */
function indexOf(rows: readonly RawRow[]): Map<string, Map<string, RawRow[]>> {
  const groups = new Map<string, Map<string, RawRow[]>>();
  for (const row of rows) {
    const id = idOf(row.keys);
    const buckets = groups.get(id) ?? new Map<string, RawRow[]>();
    const held = buckets.get(row.bucket ?? '') ?? [];
    held.push(row);
    buckets.set(row.bucket ?? '', held);
    groups.set(id, buckets);
  }
  return groups;
}

/**
 * The rows of an answer. Without a grain of time and without dimensions there are none: the
 * totals say it all. A bucket nothing happened in has zeros. A comparison is put beside the
 * same group, and beside a bucket the bucket in the same place of the comparison period.
 */
export function foldRows(input: FoldInput): { rows: FoldedRow[]; other: boolean; kept: number } {
  const { reads, buckets } = input;
  if (buckets === null && input.dimensions === 0) return { rows: [], other: false, kept: 0 };
  const main = indexOf(input.rows);
  const compared = input.compare === undefined ? undefined : indexOf(input.compare.rows);
  const all = (group: Map<string, RawRow[]> | undefined): RawRow[] =>
    [...(group?.values() ?? [])].flat();

  // Without dimensions every row is the one group there is, which may be empty.
  const ids = input.dimensions === 0 ? [idOf([])] : [...main.keys()];
  const keysOf = (id: string): (string | null)[] => all(main.get(id))[0]?.keys.slice() ?? [];
  const ordered = ids
    .map((id) => {
      const keys = keysOf(id);
      const tally = tallyOf(all(main.get(id)), false);
      const weight =
        input.orderBy === 'group' ? 0 : weightOf(reads[input.orderBy] ?? 'rows', tally);
      return { id, keys, weight, rank: input.rank(keys) };
    })
    .sort((left, right) => {
      const sign = input.direction === 'asc' ? 1 : -1;
      if (input.orderBy === 'group') return sign * byRank(left.rank, right.rank);
      return left.weight === right.weight
        ? byRank(left.rank, right.rank)
        : sign * (left.weight - right.weight);
    });
  const kept = ordered.slice(0, input.limit);
  const rest = ordered.slice(input.limit);

  const cells = (rows: readonly RawRow[], whole: boolean): ReportCell[] => {
    const tally = tallyOf(rows, whole);
    return reads.map((read) => cellOf(read, tally));
  };
  /** The rows of some groups in one bucket of an index; every bucket when there is no grain. */
  const pick = (
    index: Map<string, Map<string, RawRow[]>>,
    groups: readonly { readonly id: string }[],
    bucket: string | null | undefined,
  ): RawRow[] =>
    bucket === undefined
      ? []
      : groups.flatMap(({ id }) =>
          bucket === null ? all(index.get(id)) : (index.get(id)?.get(bucket) ?? []),
        );

  const rows: FoldedRow[] = [];
  for (const [place, bucket] of (buckets ?? [null]).entries()) {
    // The comparison's bucket in the same place; none when that period has fewer buckets.
    const beside = bucket === null ? null : input.compare?.buckets?.[place];
    const line = (
      groups: readonly { readonly id: string }[],
      whole: boolean,
    ): Omit<FoldedRow, 'keys'> => ({
      bucket,
      values: cells(pick(main, groups, bucket), whole),
      ...(compared === undefined ? {} : { compare: cells(pick(compared, groups, beside), whole) }),
    });
    for (const group of kept) rows.push({ ...line([group], true), keys: group.keys });
    if (rest.length > 0) rows.push({ ...line(rest, false), keys: null });
  }
  return { rows, other: rest.length > 0, kept: kept.length };
}
