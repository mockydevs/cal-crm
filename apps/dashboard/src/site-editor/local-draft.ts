// Unsaved work that survives a reload: while a page is edited, what is on screen is also
// kept in this browser, one entry per page. The entry is removed once the server has the
// work; one that is still there when the page is opened again is offered back. A browser
// that refuses storage (private mode, a full quota) changes nothing else: every call here
// answers instead of throwing.

/** What is kept for one page. */
export interface LocalDraft {
  /** The version the edits started from: what a save of this draft names as its base. */
  readonly baseVersion: number;
  /** When it was written, by this browser's clock. */
  readonly savedAt: string;
  /** The page as the canvas held it: not checked, the editor checks it before saving. */
  readonly document: unknown;
}

/** The part of a browser's storage this file uses. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const draftKey = (businessId: string, pageId: string): string =>
  `crm.site-draft.${businessId}.${pageId}`;

/** This browser's storage, or nothing where there is none to be had. */
export function browserStorage(): DraftStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Keeps a draft. False when the browser would not take it. */
export function writeDraft(storage: DraftStorage | null, key: string, draft: LocalDraft): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(storage: DraftStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing was kept, or nothing can be removed: either way there is nothing to offer.
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The draft kept for a page, or null when there is none that can be read. */
export function readDraft(storage: DraftStorage | null, key: string): LocalDraft | null {
  if (storage === null) return null;
  try {
    const kept: unknown = JSON.parse(storage.getItem(key) ?? 'null');
    if (!isRecord(kept)) return null;
    const { baseVersion, savedAt, document } = kept;
    if (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 1)
      return null;
    if (typeof savedAt !== 'string' || Number.isNaN(Date.parse(savedAt))) return null;
    // Only a visual page is edited here; anything else is not a draft of this editor.
    if (!isRecord(document) || document['mode'] !== 'visual') return null;
    if (!Array.isArray(document['sections']) || !Array.isArray(document['popups'])) return null;
    return { baseVersion, savedAt, document };
  } catch {
    return null;
  }
}

/** A value as text with its keys in order, so two readings of one page compare equal. */
function ordered(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(ordered).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${ordered(value[key])}`)
      .join(',')}}`;
  return value === undefined ? 'null' : JSON.stringify(value);
}

/** Whether two documents say the same thing, whatever order their keys are in. */
export const sameDocument = (one: unknown, other: unknown): boolean =>
  ordered(one) === ordered(other);

/**
 * Whether a kept draft is offered back when its page is opened: it must differ from what
 * the server holds, and be newer than it. A draft made on the server's newest version is
 * newer by construction; one made on an older version is newer only if it was written
 * after the server's was saved (then saving it meets the conflict question, since it
 * still names the older version as its base).
 */
export function isRestorable(
  draft: LocalDraft | null,
  server: {
    readonly currentVersion: number;
    readonly updatedAt: string;
    readonly document: unknown;
  },
): draft is LocalDraft {
  if (draft === null) return false;
  if (sameDocument(draft.document, server.document)) return false;
  if (draft.baseVersion === server.currentVersion) return true;
  return (
    draft.baseVersion < server.currentVersion &&
    Date.parse(draft.savedAt) > Date.parse(server.updatedAt)
  );
}
