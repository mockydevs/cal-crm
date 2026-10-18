// A page's versions, as the Versions panel lists them. The editor saves by itself into one
// working draft, which is rewritten in place; a version is kept when a person saves one on
// purpose (with a name or without), publishes, or restores an older one; and when a new
// working draft begins, the one before it stays as an automatic checkpoint. The server says
// which is which (`kind`); this file only sorts them into the panel's three lists.

export type VersionKind = 'saved' | 'draft' | 'checkpoint';

export interface ListedVersion {
  readonly number: number;
  readonly createdAt: string;
  /** Left out by a server from before the working draft: every version was a kept one. */
  readonly kind?: VersionKind | undefined;
  readonly name?: string | null | undefined;
  readonly updatedAt?: string | undefined;
  readonly restoredFrom: number | null;
  readonly current: boolean;
  readonly published: boolean;
}

export const kindOf = (version: ListedVersion): VersionKind => version.kind ?? 'saved';

/** The name a version was saved under, or undefined for one that has none. */
export function nameOf(version: ListedVersion): string | undefined {
  const name = version.name?.trim();
  return name === undefined || name === '' ? undefined : name;
}

/** When a version was last written: a working draft and a checkpoint by their last autosave. */
export const writtenAt = (version: ListedVersion): string =>
  kindOf(version) === 'saved' ? version.createdAt : (version.updatedAt ?? version.createdAt);

export interface VersionGroups<Version extends ListedVersion> {
  /** The working draft, when the newest version is one: what autosaves rewrite. */
  readonly draft: Version | undefined;
  /** Kept on purpose: named, published, restored, or the page as it was created. Newest first. */
  readonly kept: readonly Version[];
  /** Earlier working drafts, kept as they were when a newer version began. Newest first. */
  readonly checkpoints: readonly Version[];
}

/**
 * The versions in the panel's three lists. A page has at most one working draft, and it is
 * the newest version; a stray second one (which the server never sends) is listed with the
 * checkpoints, so nothing a page holds is left out of the panel.
 */
export function groupVersions<Version extends ListedVersion>(
  items: readonly Version[],
): VersionGroups<Version> {
  const newestFirst = [...items].sort((one, other) => other.number - one.number);
  const draft = newestFirst.find((version) => kindOf(version) === 'draft' && version.current);
  return {
    draft,
    kept: newestFirst.filter((version) => kindOf(version) === 'saved'),
    checkpoints: newestFirst.filter((version) => kindOf(version) !== 'saved' && version !== draft),
  };
}

/** A name as the server takes one for a version: trimmed, or undefined when left empty. */
export function versionNameOf(typed: string): string | undefined {
  const name = typed.trim();
  return name === '' ? undefined : name;
}

/** The longest name a version takes: the contract's own bound. */
export const VERSION_NAME_MAX = 120;
