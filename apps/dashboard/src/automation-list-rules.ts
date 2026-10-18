// What the list of workflows works out before it draws: where a folder is in the tree, what
// to ask the API for under each tab and filter, and the name a copy gets. No React here.
import {
  AUTOMATION_FOLDER_MAX_DEPTH,
  type AutomationFolder,
  type AutomationSummary,
} from '@repo/contracts';

export type FolderRow = Pick<AutomationFolder, 'id' | 'parentId' | 'name'>;

/** The statuses the list can be narrowed to; a deleted workflow has its own tab. */
export const listStatuses = ['active', 'draft', 'paused'] as const;
export type ListStatus = (typeof listStatuses)[number];

/** The folders from the top level down to this one, itself last; none for one not there. */
export function folderPath<Folder extends FolderRow>(
  folders: readonly Folder[],
  id: string | undefined,
): Folder[] {
  const path: Folder[] = [];
  let next = id;
  // Bounded by the depth folders nest to, so a tree that loops cannot hold the page.
  while (next !== undefined && path.length < AUTOMATION_FOLDER_MAX_DEPTH) {
    const wanted = next;
    const folder = folders.find((each) => each.id === wanted);
    if (folder === undefined) return [];
    path.unshift(folder);
    next = folder.parentId ?? undefined;
  }
  return path;
}

/** The folders directly in a folder, or at the top level, in the order the API gave them. */
export function foldersIn<Folder extends FolderRow>(
  folders: readonly Folder[],
  parent: string | undefined,
): Folder[] {
  return folders.filter((folder) => (folder.parentId ?? undefined) === parent);
}

/** Every folder as a place to move something to, named by its whole path. */
export function folderChoices(
  folders: readonly FolderRow[],
): { readonly id: string; readonly label: string }[] {
  return folders
    .map((folder) => ({
      id: folder.id,
      label: folderPath(folders, folder.id)
        .map((each) => each.name)
        .join(' / '),
    }))
    .filter((choice) => choice.label !== '')
    .sort((one, other) => one.label.localeCompare(other.label));
}

export interface ListQuery {
  readonly status?: ListStatus | 'archived';
  readonly folder?: string;
  readonly q?: string;
}

/**
 * What to ask for. The Deleted list is its own status, in no folder. Otherwise a folder
 * that is open narrows the list to itself; at the top level a search or a status looks in
 * every folder, and with neither the list is the top level alone.
 */
export function listQuery(view: {
  readonly deleted: boolean;
  readonly folder: string | undefined;
  readonly status: ListStatus | undefined;
  readonly q: string;
}): ListQuery {
  const q = view.q.trim();
  const search = q === '' ? {} : { q };
  if (view.deleted) return { status: 'archived', ...search };
  const status = view.status === undefined ? {} : { status: view.status };
  if (view.folder !== undefined) return { ...status, folder: view.folder, ...search };
  return q === '' && view.status === undefined ? { folder: 'root' } : { ...status, ...search };
}

/** Whether the list is narrowed, so folders (which have no status) are left out of it. */
export const isNarrowed = (view: {
  readonly status: ListStatus | undefined;
  readonly q: string;
}): boolean => view.status !== undefined || view.q.trim() !== '';

const NAME_LIMIT = 120;

/** The name a copy starts with: the original's, marked, and never longer than a name may be. */
export function copyName(name: string, mark: string): string {
  const suffix = ` ${mark}`;
  return `${name.slice(0, NAME_LIMIT - suffix.length).trimEnd()}${suffix}`;
}

export interface Overview {
  readonly workflows: number;
  readonly published: number;
  readonly enrolled: number;
  readonly active: number;
}

/** The Overview's numbers, from every workflow that is not deleted. */
export function overviewOf(
  automations: readonly {
    readonly status: string;
    readonly totalEnrolled?: number | undefined;
    readonly activeEnrolled?: number | undefined;
  }[],
): Overview {
  return {
    workflows: automations.length,
    published: automations.filter((each) => each.status === 'active').length,
    enrolled: automations.reduce((sum, each) => sum + (each.totalEnrolled ?? 0), 0),
    active: automations.reduce((sum, each) => sum + (each.activeEnrolled ?? 0), 0),
  };
}

/** The dialog the list has open, and what it is about. */
export type Opened =
  | { readonly kind: 'create-folder' }
  | { readonly kind: 'rename-folder'; readonly folder: AutomationFolder }
  | { readonly kind: 'delete-folder'; readonly folder: AutomationFolder }
  | { readonly kind: 'rename'; readonly automation: AutomationSummary }
  | { readonly kind: 'move'; readonly automation: AutomationSummary }
  | { readonly kind: 'delete'; readonly automation: AutomationSummary };
