// What a bulk action on opportunities works out around its requests: the server takes at
// most a hundred opportunities at a time (DEAL_BULK_LIMIT), so a larger selection goes in
// several requests, and what became of all of them is added up.
import type { BulkDealsResult } from '@repo/contracts';

/** The items in groups of at most `size`, in order. */
export function batchesOf<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    batches.push(items.slice(start, start + size));
  return batches;
}

export interface BulkTally {
  /** Changed. */
  readonly done: number;
  /** Already as asked, so nothing was written. */
  readonly unchanged: number;
  /** Left as they were: not found, or in the trash. */
  readonly skipped: number;
  /** The ids that were changed, so the page can let go of them. */
  readonly changed: readonly string[];
}

export const emptyTally: BulkTally = { done: 0, unchanged: 0, skipped: 0, changed: [] };

/** What became of the opportunities of every request together. */
export function tallyOf(results: readonly BulkDealsResult[]): BulkTally {
  return results.reduce<BulkTally>(
    (tally, result) => ({
      done: tally.done + result.done,
      unchanged: tally.unchanged + result.unchanged,
      skipped: tally.skipped + result.skipped,
      changed: [
        ...tally.changed,
        ...result.results.filter((each) => each.outcome === 'done').map((each) => each.id),
      ],
    }),
    emptyTally,
  );
}

/** The selection without the ids that are no longer among the opportunities shown. */
export function selectionAmong(
  selected: ReadonlySet<string>,
  shown: readonly { readonly id: string; readonly canManage: boolean }[],
): string[] {
  return shown.filter((deal) => deal.canManage && selected.has(deal.id)).map((deal) => deal.id);
}

/** The selection with one opportunity put in or taken out. */
export function toggled(selected: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(selected);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}
