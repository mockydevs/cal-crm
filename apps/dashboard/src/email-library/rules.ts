// What the Emails pages (Campaigns and Templates) work out before they draw their library:
// the folder tree as the left panel lists it, and which rows are ticked for a bulk action.

/** The folders in panel order: each under its parent, siblings in the order given. */
export function folderTree<
  T extends { readonly id: string; readonly parentId: string | null; readonly name: string },
>(folders: readonly T[]): readonly (T & { readonly depth: number })[] {
  const ids = new Set(folders.map((each) => each.id));
  const children = new Map<string | null, T[]>();
  for (const each of folders) {
    // A folder whose parent is not listed is shown at the top rather than lost.
    const parent = each.parentId !== null && ids.has(each.parentId) ? each.parentId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(each);
    children.set(parent, siblings);
  }
  const ordered: (T & { readonly depth: number })[] = [];
  const placed = new Set<string>();
  const visit = (parent: string | null, depth: number): void => {
    for (const each of children.get(parent) ?? []) {
      if (placed.has(each.id)) continue;
      placed.add(each.id);
      ordered.push({ ...each, depth });
      visit(each.id, depth + 1);
    }
  };
  visit(null, 0);
  // Folders inside one another in a loop reach the top from nowhere: listed last, flat.
  for (const each of folders) if (!placed.has(each.id)) ordered.push({ ...each, depth: 0 });
  return ordered;
}

/** The ticked rows with one more ticked, or with it unticked. */
export function toggled(selected: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** How much of a page is ticked, for its "select all" box. */
export function pageSelection(
  selected: ReadonlySet<string>,
  page: readonly string[],
): 'none' | 'some' | 'all' {
  const ticked = page.filter((id) => selected.has(id)).length;
  if (ticked === 0) return 'none';
  return ticked === page.length ? 'all' : 'some';
}

/** Every row of a page ticked, or every one unticked; rows of other pages stay as they are. */
export function withPage(
  selected: ReadonlySet<string>,
  page: readonly string[],
  on: boolean,
): ReadonlySet<string> {
  const next = new Set(selected);
  for (const id of page) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/**
 * Promise.allSettled with at most `limit` of the work running at once, so many requests
 * one at a time each (deleting 100 ticked drafts) don't all reach the server together and
 * run into its rate limit. Answers each item in the order given.
 */
export async function settleAtMost<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      try {
        results[index] = { status: 'fulfilled', value: await work(item) };
      } catch (reason: unknown) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
