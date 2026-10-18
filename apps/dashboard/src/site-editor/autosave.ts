// Saving a page while it is edited: the draft is saved by itself after a pause in the
// edits, with the version the edits started from. Those saves go into the page's one
// working draft, which the server rewrites in place, so an hour of editing is one version
// and not hundreds; a version is kept only when a person asks for one, publishes or
// restores; a save that fails keeps the work and is tried again; a save the server refuses
// because someone else saved first waits for the person to choose. This file is the whole
// of that as a state machine with no clock and no network in it: the page feeds it what
// happened and reads from it what to say and what to do next. Nothing here ever publishes.

/** How long after the last edit the draft is saved. */
export const SAVE_PAUSE_MS = 1500;
/** How long to wait before each new try of a save that failed: longer each time. */
const RETRY_MS = [2000, 5000, 15_000, 30_000] as const;

export type SaveStatus =
  /** Everything on screen is saved. */
  | 'saved'
  /** Edited since the last save: a save is due after the pause. */
  | 'dirty'
  /** Edited, but the page as it stands is not one the server would take. */
  | 'invalid'
  /** A save is on its way. */
  | 'saving'
  /** The last save did not arrive: it is tried again. */
  | 'failed'
  /** Someone else saved a newer version: the person chooses whose stays. */
  | 'conflict';

export interface Autosave {
  readonly status: SaveStatus;
  /** The version the edits on screen started from: what a save names as its base. */
  readonly baseVersion: number;
  /** Goes up with every edit. */
  readonly edits: number;
  /** The count of edits the save on its way, or the last one sent, carried. */
  readonly sent: number;
  /** Whether the page as it stands passes the contract. */
  readonly valid: boolean;
  /** How many saves in a row have failed. */
  readonly failures: number;
}

export type AutosaveEvent =
  | { readonly type: 'edited' }
  /** The page as it stands was checked against the contract. */
  | { readonly type: 'checked'; readonly valid: boolean }
  | { readonly type: 'save_started' }
  | { readonly type: 'save_succeeded'; readonly version: number }
  | { readonly type: 'save_failed' }
  /** The server would not take the page as it stands: trying again would change nothing. */
  | { readonly type: 'save_refused' }
  | { readonly type: 'conflict' }
  /** "Keep mine": the next save is made on top of the version someone else saved. */
  | { readonly type: 'kept_mine'; readonly baseVersion: number }
  /** A page was loaded in place of the edits: theirs, an older version, or a fresh read. */
  | { readonly type: 'loaded'; readonly version: number }
  /**
   * The saved page was kept as a version on purpose, or published: the newest version may
   * have a new number, which is what the next save starts from. What is on screen and
   * whether it is saved do not change.
   */
  | { readonly type: 'version_moved'; readonly version: number };

export const startAutosave = (baseVersion: number): Autosave => ({
  status: 'saved',
  baseVersion,
  edits: 0,
  sent: 0,
  valid: true,
  failures: 0,
});

const waiting = (valid: boolean): SaveStatus => (valid ? 'dirty' : 'invalid');

export function autosave(state: Autosave, event: AutosaveEvent): Autosave {
  switch (event.type) {
    case 'edited': {
      // An edit may have put right what was wrong: the page is taken as valid until it
      // is checked again, which happens before every save.
      const next = { ...state, edits: state.edits + 1, valid: true };
      // A save on its way, and a choice the person owes, are not interrupted by an edit:
      // the edit is saved by the save that follows.
      if (state.status === 'saving' || state.status === 'conflict') return next;
      return { ...next, status: 'dirty', failures: 0 };
    }
    case 'checked': {
      const next = { ...state, valid: event.valid };
      return state.status === 'dirty' || state.status === 'invalid'
        ? { ...next, status: waiting(event.valid) }
        : next;
    }
    case 'save_started':
      return { ...state, status: 'saving', sent: state.edits };
    case 'save_succeeded':
      return {
        ...state,
        baseVersion: event.version,
        failures: 0,
        status: state.edits === state.sent ? 'saved' : waiting(state.valid),
      };
    case 'save_failed':
      return { ...state, status: 'failed', failures: state.failures + 1 };
    case 'save_refused':
      return { ...state, status: 'invalid', valid: false, failures: 0 };
    case 'conflict':
      return { ...state, status: 'conflict' };
    case 'kept_mine':
      return {
        ...state,
        baseVersion: event.baseVersion,
        failures: 0,
        status: waiting(state.valid),
      };
    case 'version_moved':
      return { ...state, baseVersion: event.version };
    case 'loaded':
      return {
        ...state,
        status: 'saved',
        baseVersion: event.version,
        sent: state.edits,
        valid: true,
        failures: 0,
      };
  }
}

/** Whether leaving now would lose something: anything not yet saved. */
export const hasUnsavedWork = (state: Autosave): boolean => state.status !== 'saved';

/**
 * How long from now the next save should start, or null when none is due: after the pause
 * for an edit, after a longer wait for each save that failed. A page that is not valid, a
 * save on its way and a conflict wait for something else to happen first.
 */
export function saveDueIn(state: Autosave): number | null {
  if (state.status === 'dirty') return SAVE_PAUSE_MS;
  if (state.status === 'failed')
    return RETRY_MS[Math.min(state.failures, RETRY_MS.length) - 1] ?? RETRY_MS[0];
  return null;
}

/** Whether a save may start this moment (on leaving the page, or when asked to). */
export const canSaveNow = (state: Autosave): boolean =>
  state.status === 'dirty' || state.status === 'failed';
