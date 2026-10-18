import { MESSAGE_TEMPLATE_FOLDER_MAX_DEPTH } from '@repo/contracts';

/** Sibling names are unique, but names in different branches need their parent path. */
export function folderLabels(
  folders: readonly {
    readonly id: string;
    readonly parentId: string | null;
    readonly name: string;
  }[],
): ReadonlyMap<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const labels = new Map<string, string>();
  for (const folder of folders) {
    const names: string[] = [];
    const visited = new Set<string>();
    let current = byId.get(folder.id);
    while (
      current !== undefined &&
      !visited.has(current.id) &&
      names.length < MESSAGE_TEMPLATE_FOLDER_MAX_DEPTH
    ) {
      visited.add(current.id);
      names.unshift(current.name);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    labels.set(folder.id, names.join(' / '));
  }
  return labels;
}

/** Preserve library order while hiding destinations that would create a cycle. */
export function folderDestinations<
  T extends { readonly id: string; readonly parentId: string | null },
>(folders: readonly T[], movingId?: string): readonly T[] {
  if (movingId === undefined) return folders;
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (folder.parentId === null) continue;
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder.id);
    children.set(folder.parentId, siblings);
  }
  const excluded = new Set<string>();
  const pending = [movingId];
  for (const id of pending) {
    if (excluded.has(id)) continue;
    excluded.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return folders.filter((folder) => !excluded.has(folder.id));
}
