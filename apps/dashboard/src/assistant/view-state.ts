// What the assistant's panel remembers for the person looking, in this browser tab only:
// whether it is open, which conversation it has open, and the page the full-screen view
// was opened from. Conveniences, kept in sessionStorage; everything else is the server's.
// A browser that keeps nothing (private windows, blocked storage) still works: the panel
// then starts closed on each page load.
//
// This file arrives with the first page, for the launcher: it imports nothing but React.
import { useCallback, useSyncExternalStore } from 'react';

export interface AssistantView {
  readonly open: boolean;
  /** The conversation the panel shows; null for one not started yet. */
  readonly threadId: string | null;
  /** The address the full-screen view was opened from, to go back to. */
  readonly from: string | null;
  /**
   * What the assistant was told of that page (its path and the id of its record), so a
   * message typed full-screen is still about it. Read back as unknown: whoever uses it
   * checks it.
   */
  readonly fromPage: unknown;
}

const closed: AssistantView = { open: false, threadId: null, from: null, fromPage: null };
const keyOf = (businessId: string): string => `assistant:${businessId}`;

const views = new Map<string, AssistantView>();
const listeners = new Set<() => void>();

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** What the tab kept, or a closed panel where it kept nothing that can be read. */
function stored(businessId: string): AssistantView {
  try {
    const kept: unknown = JSON.parse(window.sessionStorage.getItem(keyOf(businessId)) ?? 'null');
    if (typeof kept !== 'object' || kept === null) return closed;
    const { open, threadId, from, fromPage } = kept as Record<string, unknown>;
    return {
      open: open === true,
      threadId: textOrNull(threadId),
      from: textOrNull(from),
      fromPage: fromPage ?? null,
    };
  } catch {
    return closed;
  }
}

/** How the panel stands in one business. */
export function readAssistantView(businessId: string): AssistantView {
  let view = views.get(businessId);
  if (view === undefined) {
    view = stored(businessId);
    views.set(businessId, view);
  }
  return view;
}

/** Changes how the panel stands in one business, for every part of the page that shows it. */
export function setAssistantView(businessId: string, change: Partial<AssistantView>): void {
  const view = { ...readAssistantView(businessId), ...change };
  views.set(businessId, view);
  try {
    window.sessionStorage.setItem(keyOf(businessId), JSON.stringify(view));
  } catch {
    // Nothing is kept; the panel still works until the page is reloaded.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How the panel stands in one business, drawn again when it changes. */
export function useAssistantView(businessId: string): AssistantView {
  return useSyncExternalStore(
    subscribe,
    useCallback(() => readAssistantView(businessId), [businessId]),
  );
}

/** Forgets what was read, so a test starts from what the tab keeps. */
export function forgetAssistantViews(): void {
  views.clear();
}
