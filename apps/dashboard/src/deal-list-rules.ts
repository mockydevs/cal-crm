// What the opportunities list works out before it draws: which columns its table shows for
// a saved view, the five-column list a view is still saved with, and the order the server
// is asked for. The keys are the contract's (packages/contracts/src/saved-views.ts and
// deals.ts).
import type { DealSort, dealViewColumnKeys, SortDirection } from '@repo/contracts';
import { dealColumnsOf, type DealColumnKey } from './list-columns';

/** One of the five columns the first opportunity table had, which a saved view still names. */
export type FirstDealColumnKey = (typeof dealViewColumnKeys)[number];

/** The columns a list shows when its address and its view name none. */
export const defaultDealColumns: readonly DealColumnKey[] = [
  'name',
  'value',
  'stage',
  'status',
  'expectedClose',
  'contact',
  'owner',
  'tags',
];

/**
 * The columns a saved view's table shows: its own choice when it has one; else the five it
 * was saved with, followed by the contact, the owner and the tags, which the table showed
 * after them before a view could choose.
 */
export function dealColumnsOfView(view: {
  readonly tableColumns?: readonly DealColumnKey[] | null | undefined;
  readonly columns: readonly FirstDealColumnKey[];
}): DealColumnKey[] {
  return (
    dealColumnsOf(view.tableColumns ?? [...view.columns, 'contact', 'owner', 'tags']) ?? [
      ...defaultDealColumns,
    ]
  );
}

/** The five-column list a view is still saved with: those of them the table shows. */
export function firstDealColumns(columns: readonly DealColumnKey[]): FirstDealColumnKey[] {
  return columns.flatMap((key): FirstDealColumnKey[] =>
    key === 'value'
      ? ['amount']
      : key === 'status'
        ? ['outcome']
        : key === 'name' || key === 'stage' || key === 'expectedClose'
          ? [key]
          : [],
  );
}

/**
 * The built-in orders of the list, each of the server's four in both directions; the first
 * is the one a list has when nothing is chosen.
 */
export const dealOrderKeys = [
  'created',
  'created:asc',
  'updated',
  'updated:asc',
  'name',
  'name:desc',
  'value',
  'value:asc',
] as const;
export type DealOrderKey = (typeof dealOrderKeys)[number];

interface DealOrderState {
  readonly sort?: DealSort | undefined;
  readonly direction?: SortDirection | undefined;
}

/** The way an order runs when none is named: names from A, the others newest or largest first. */
const usual = (sort: DealSort): SortDirection => (sort === 'name' ? 'asc' : 'desc');

/** Which built-in order an address or a view names. */
export function dealOrderOf({ sort = 'created', direction }: DealOrderState): DealOrderKey {
  const way = direction ?? usual(sort);
  return (
    dealOrderKeys.find((key) => key === (way === usual(sort) ? sort : `${sort}:${way}`)) ??
    'created'
  );
}

/**
 * What the address keeps, and the server is asked, for a built-in order: nothing for the
 * newest first, and a direction only when it is not the order's usual one.
 */
export function dealOrderState(key: DealOrderKey): DealOrderState {
  const [sort, direction] = key.split(':') as [DealSort, SortDirection | undefined];
  if (direction !== undefined) return { sort, direction };
  return sort === 'created' ? {} : { sort };
}
