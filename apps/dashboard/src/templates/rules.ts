// What the Templates page works out before it draws: what to ask the list for from the
// address, which place of the library the address shows, and what can be done to a
// template, or to many, where they are.
import type { TemplatesSearch } from '../templates-search';

export interface TemplatesQuery {
  readonly archived: 'exclude' | 'only' | 'include';
  readonly deleted: 'exclude' | 'only';
  readonly sort: 'name' | 'updated' | 'uses';
  readonly limit: number;
  readonly folder?: string;
  readonly q?: string;
  readonly format?: 'html' | 'text';
  readonly used?: 'yes' | 'no';
  readonly after?: string;
}

/** The list's question for what the address shows, at one page. */
export function listQueryOf(
  search: TemplatesSearch,
  page: { readonly limit: number; readonly after: string | undefined },
): TemplatesQuery {
  return {
    // The trash holds templates whether or not they were archived first.
    archived: search.show === 'archived' ? 'only' : search.show === 'trash' ? 'include' : 'exclude',
    deleted: search.show === 'trash' ? 'only' : 'exclude',
    ...(search.folder === undefined ? {} : { folder: search.folder }),
    ...(search.q === undefined ? {} : { q: search.q }),
    ...(search.type === undefined ? {} : { format: search.type }),
    ...(search.used === undefined ? {} : { used: search.used }),
    sort: search.sort ?? 'name',
    limit: page.limit,
    ...(page.after === undefined ? {} : { after: page.after }),
  };
}

/** The panel's place: "all", a folder's id, "archived" or "trash". */
export function placeOf(search: TemplatesSearch): string {
  return search.show ?? search.folder ?? 'all';
}

/** The address at another place of the panel, with the same search, filters and order. */
export function withPlace(search: TemplatesSearch, place: string): TemplatesSearch {
  const { folder: _folder, show: _show, ...kept } = search;
  if (place === 'archived' || place === 'trash') return { show: place, ...kept };
  return place === 'all' ? kept : { folder: place, ...kept };
}

export type RowActionKey =
  'open' | 'edit' | 'duplicate' | 'rename' | 'move' | 'archive' | 'restore' | 'delete';

/**
 * What a template's menu offers. An archived one can't be edited (the server refuses), so
 * it opens to read; one in the trash only comes back. Someone whose role can't change
 * templates reads them, and has nothing to do in the trash.
 */
export function rowActionsOf(
  template: { readonly archivedAt: string | null; readonly deletedAt?: string | null | undefined },
  canManage: boolean,
): readonly RowActionKey[] {
  const trashed = template.deletedAt !== null && template.deletedAt !== undefined;
  if (!canManage) return trashed ? [] : ['open'];
  if (trashed) return ['restore'];
  if (template.archivedAt !== null) return ['open', 'duplicate', 'move', 'restore', 'delete'];
  return ['edit', 'duplicate', 'rename', 'move', 'archive', 'delete'];
}

export type BulkActionKey = 'move' | 'archive' | 'restore' | 'delete';

/** What the bar over ticked templates offers in each place. */
export function bulkActionsOf(show: TemplatesSearch['show']): readonly BulkActionKey[] {
  if (show === 'trash') return ['restore'];
  if (show === 'archived') return ['move', 'restore', 'delete'];
  return ['move', 'archive', 'delete'];
}
