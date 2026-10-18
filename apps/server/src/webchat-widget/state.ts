// The web chat widget's state, apart from the page it lives in: what is shown, what was
// sent, what is new. Pure functions over plain values, so they are tested without a
// browser. controller.ts feeds them events; view.ts draws what they return.
import type { WidgetConfig, WidgetMessage } from './api.js';
import type { StringKey } from './strings.js';

export interface ChatItem {
  /** Stable for the life of the item: the message id the widget chose, or its place. */
  readonly id: string;
  /** The message's place in the session, once the server has it. */
  readonly seq: number | null;
  readonly from: 'visitor' | 'team';
  readonly text: string;
  readonly status: 'sent' | 'sending' | 'failed';
}

export interface WidgetState {
  readonly open: boolean;
  readonly view: 'loading' | 'form' | 'chat' | 'unavailable';
  readonly config: WidgetConfig | null;
  readonly items: readonly ChatItem[];
  /** The place to read after. */
  readonly cursor: number;
  /** The last place the visitor has seen with the panel open. */
  readonly seen: number;
  readonly notice: StringKey | null;
  /** A request the visitor started is in flight: its button waits. */
  readonly busy: boolean;
}

export type WidgetEvent =
  | { readonly type: 'opened' }
  | { readonly type: 'closed' }
  | { readonly type: 'config'; readonly config: WidgetConfig; readonly session: boolean }
  | { readonly type: 'unavailable' }
  | { readonly type: 'started' }
  | { readonly type: 'ended'; readonly notice: StringKey | null }
  | { readonly type: 'queued'; readonly id: string; readonly text: string }
  | { readonly type: 'delivered'; readonly id: string; readonly message: WidgetMessage }
  | { readonly type: 'undelivered'; readonly id: string; readonly notice: StringKey }
  | { readonly type: 'page'; readonly messages: readonly WidgetMessage[]; readonly cursor: number }
  | { readonly type: 'notice'; readonly notice: StringKey | null }
  | { readonly type: 'busy'; readonly busy: boolean };

export function initialState(seen: number): WidgetState {
  return {
    open: false,
    view: 'loading',
    config: null,
    items: [],
    cursor: 0,
    seen,
    notice: null,
    busy: false,
  };
}

// Stored messages in their order, then the ones still on their way, as typed.
function ordered(items: readonly ChatItem[]): ChatItem[] {
  const stored = items.filter((item) => item.seq !== null);
  stored.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return [...stored, ...items.filter((item) => item.seq === null)];
}

const stored = (message: WidgetMessage): ChatItem => ({
  id: `s${String(message.seq)}`,
  seq: message.seq,
  from: message.from,
  text: message.text,
  status: 'sent',
});

export function reduce(state: WidgetState, event: WidgetEvent): WidgetState {
  switch (event.type) {
    case 'opened':
      // Opening the panel is seeing what is in it.
      return { ...state, open: true, seen: Math.max(state.seen, state.cursor) };
    case 'closed':
      return { ...state, open: false };
    case 'config':
      return { ...state, config: event.config, view: event.session ? 'chat' : 'form' };
    case 'unavailable':
      return { ...state, view: 'unavailable', busy: false };
    case 'started':
      return { ...state, view: 'chat', notice: null };
    case 'ended':
      // Nothing of the old chat stays on screen: the next visitor at this browser sees none.
      return {
        ...state,
        view: state.config === null ? 'loading' : 'form',
        items: [],
        cursor: 0,
        seen: 0,
        notice: event.notice,
        busy: false,
      };
    case 'queued':
      if (state.items.some((item) => item.id === event.id))
        return {
          ...state,
          notice: null,
          items: state.items.map((item) =>
            item.id === event.id ? { ...item, status: 'sending' } : item,
          ),
        };
      return {
        ...state,
        notice: null,
        items: [
          ...state.items,
          { id: event.id, seq: null, from: 'visitor', text: event.text, status: 'sending' },
        ],
      };
    case 'delivered': {
      const { seq } = event.message;
      // A read that came back first already holds this message: one copy stays.
      const known = state.items.some((item) => item.id !== event.id && item.seq === seq);
      const items = known
        ? state.items.filter((item) => item.id !== event.id)
        : state.items.map((item) =>
            item.id === event.id ? { ...item, seq, status: 'sent' as const } : item,
          );
      return { ...state, items: ordered(items), busy: false };
    }
    case 'undelivered':
      return {
        ...state,
        busy: false,
        notice: event.notice,
        items: state.items.map((item) =>
          item.id === event.id ? { ...item, status: 'failed' } : item,
        ),
      };
    case 'page': {
      const have = new Set(state.items.map((item) => item.seq));
      const fresh = event.messages.filter((message) => !have.has(message.seq)).map(stored);
      const cursor = Math.max(state.cursor, event.cursor);
      return {
        ...state,
        items: fresh.length === 0 ? state.items : ordered([...state.items, ...fresh]),
        cursor,
        seen: state.open ? Math.max(state.seen, cursor) : state.seen,
      };
    }
    case 'notice':
      return { ...state, notice: event.notice };
    case 'busy':
      return { ...state, busy: event.busy };
  }
}

/** Replies from the team that arrived while the panel was closed. */
export function unreadCount(state: WidgetState): number {
  return state.items.filter(
    (item) => item.from === 'team' && item.seq !== null && item.seq > state.seen,
  ).length;
}

export interface PollFacts {
  readonly session: boolean;
  readonly open: boolean;
  /** The page is in a background tab. */
  readonly hidden: boolean;
  /** Reads in a row that brought nothing new. */
  readonly quiet: number;
  /** Reads in a row that failed. */
  readonly failures: number;
  readonly retryAfterSeconds?: number;
}

const OPEN_MS = 4000;
const OPEN_SLOWEST_MS = 15_000;
const CLOSED_MS = 30_000;
const FAILING_SLOWEST_MS = 120_000;

/**
 * How long to wait before reading again, or null to stop reading. Nothing is read without
 * a session or in a background tab. An open panel reads every 4 seconds and slows to 15
 * when nothing comes; a closed one reads every 30. Failures double the wait, to 2 minutes,
 * and the server's own retry time is honoured when it is longer: a widget on a busy site
 * must not be what keeps a struggling server down.
 */
export function pollDelay(facts: PollFacts): number | null {
  if (!facts.session || facts.hidden) return null;
  if (facts.failures > 0) {
    const backoff = Math.min(FAILING_SLOWEST_MS, 5000 * 2 ** Math.min(facts.failures - 1, 10));
    const asked = Math.min(FAILING_SLOWEST_MS, (facts.retryAfterSeconds ?? 0) * 1000);
    return Math.max(backoff, asked);
  }
  if (!facts.open) return CLOSED_MS;
  if (facts.quiet < 5) return OPEN_MS;
  return Math.min(OPEN_SLOWEST_MS, Math.round(OPEN_MS * 1.5 ** Math.min(facts.quiet - 4, 10)));
}

// Deliberately loose: the server decides what an address is. This only catches a slip.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** What is wrong with a message, as the key of the words to show, or null. */
export function checkMessage(config: WidgetConfig, text: string): StringKey | null {
  if (text.trim() === '') return 'messageNeeded';
  return text.length > config.messageLength ? 'messageTooLong' : null;
}

/** What is wrong with the first form, or null. */
export function checkDetails(
  config: WidgetConfig,
  details: { readonly email: string; readonly text: string },
): StringKey | null {
  const email = details.email.trim();
  if (email === '' && config.emailRequired) return 'emailNeeded';
  if (email !== '' && !EMAIL.test(email)) return 'emailInvalid';
  return checkMessage(config, details.text);
}
