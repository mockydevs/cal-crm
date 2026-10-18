// What the web chat widget does: it joins the API client, the stored session, the state and
// the view, and decides when to ask the CRM for anything. Everything it needs from a
// browser is passed in, so it is tested without one.
//
// Nothing is asked of the CRM until a visitor opens the panel or already has a session:
// a page view alone costs the CRM no request.
import type { Failure, WidgetApi } from './api.js';
import {
  checkDetails,
  checkMessage,
  initialState,
  pollDelay,
  reduce,
  unreadCount,
  type WidgetEvent,
  type WidgetState,
} from './state.js';
import type { SessionStore } from './storage.js';
import type { StringKey } from './strings.js';

export interface ControllerDeps {
  readonly api: WidgetApi;
  readonly store: SessionStore;
  /** Draws the state. Called after every change; must not throw. */
  readonly render: (state: WidgetState, unread: number) => void;
  /** A new id for a message: a random UUID. */
  readonly newId: () => string;
  readonly setTimer: (run: () => void, ms: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
  /** Whether the page is in a background tab. */
  readonly isHidden: () => boolean;
}

export interface Details {
  readonly name: string;
  readonly email: string;
  /** Whether the visitor ticked the marketing box. Never true unless they did. */
  readonly marketingConsent: boolean;
  readonly text: string;
}

export interface Controller {
  open(): void;
  close(): void;
  /** The first form: starts a session, then sends its message. */
  begin(details: Details): Promise<void>;
  send(text: string): Promise<void>;
  /** Sends a message that failed again, under the id it already has. */
  retry(id: string): Promise<void>;
  /** Ends the chat: the session stops working and this browser forgets it. */
  end(): void;
  visibilityChanged(): void;
  state(): WidgetState;
}

/** The most pages read in one go when a visitor returns to a long chat. */
const MAX_PAGES = 10;

const noticeFor = (failure: Failure): StringKey => {
  if (failure === 'limited') return 'slowDown';
  if (failure === 'invalid') return 'detailsRefused';
  if (failure === 'network') return 'offline';
  if (failure === 'unavailable') return 'unavailable';
  return 'sessionEnded';
};

export function createController(deps: ControllerDeps): Controller {
  const { api, store } = deps;
  const restored = store.read();
  let token = restored?.token;
  let expiresAt = restored?.expiresAt ?? '';
  let state = initialState(restored?.seen ?? 0);
  // Bumped when a session ends, so an answer that arrives for the old one is dropped.
  let generation = 0;
  let timer: unknown;
  let polling = false;
  let loading = false;
  let quiet = 0;
  let failures = 0;
  let retryAfterSeconds: number | undefined;

  function dispatch(event: WidgetEvent): void {
    const before = state.seen;
    state = reduce(state, event);
    if (token !== undefined && state.seen !== before)
      store.write({ token, expiresAt, seen: state.seen });
    try {
      deps.render(state, unreadCount(state));
    } catch {
      // A page that breaks the view must not break the chat's state.
    }
  }

  function schedule(soon = false): void {
    deps.clearTimer(timer);
    timer = undefined;
    const delay = pollDelay({
      session: token !== undefined,
      open: state.open,
      hidden: deps.isHidden(),
      quiet,
      failures,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
    if (delay === null) return;
    timer = deps.setTimer(() => void poll(), soon && failures === 0 ? 0 : delay);
  }

  function forget(notice: StringKey | null): void {
    generation += 1;
    token = undefined;
    expiresAt = '';
    quiet = 0;
    failures = 0;
    retryAfterSeconds = undefined;
    store.clear();
    deps.clearTimer(timer);
    timer = undefined;
    dispatch({ type: 'ended', notice });
  }

  async function poll(): Promise<void> {
    const current = token;
    if (current === undefined || polling) return;
    polling = true;
    const mine = generation;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const before = state.items.length;
        const result = await api.messages(current, state.cursor);
        if (mine !== generation) return;
        if (!result.ok) {
          if (result.failure === 'session' || result.failure === 'full') {
            // Said only to someone who was in the chat; a returning visitor just sees the form.
            forget(state.open && state.items.length > 0 ? 'sessionEnded' : null);
            return;
          }
          failures += 1;
          retryAfterSeconds = result.retryAfterSeconds;
          break;
        }
        failures = 0;
        retryAfterSeconds = undefined;
        dispatch({ type: 'page', messages: result.value.messages, cursor: result.value.cursor });
        quiet = state.items.length > before ? 0 : quiet + 1;
        if (!result.value.more) break;
      }
    } finally {
      polling = false;
    }
    if (mine === generation) schedule();
  }

  async function loadConfig(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const result = await api.config();
      if (result.ok)
        dispatch({ type: 'config', config: result.value, session: token !== undefined });
      else dispatch({ type: 'unavailable' });
    } finally {
      loading = false;
    }
  }

  async function deliver(id: string, text: string): Promise<void> {
    const current = token;
    if (current === undefined) return;
    const mine = generation;
    dispatch({ type: 'queued', id, text });
    dispatch({ type: 'busy', busy: true });
    const result = await api.send(current, id, text);
    if (mine !== generation) return;
    if (result.ok) {
      dispatch({ type: 'delivered', id, message: result.value });
      quiet = 0;
      schedule();
      return;
    }
    if (result.failure === 'session' || result.failure === 'full') {
      forget('sessionEnded');
      return;
    }
    dispatch({ type: 'undelivered', id, notice: noticeFor(result.failure) });
  }

  if (token !== undefined) schedule(true);

  return {
    open() {
      dispatch({ type: 'opened' });
      // A widget that could not load tries again each time the visitor opens it.
      if (state.config === null) void loadConfig();
      quiet = 0;
      schedule(true);
    },
    close() {
      dispatch({ type: 'closed' });
      schedule();
    },
    async begin(details) {
      const { config } = state;
      if (config === null || state.busy || token !== undefined) return;
      const problem = checkDetails(config, details);
      if (problem !== null) {
        dispatch({ type: 'notice', notice: problem });
        return;
      }
      dispatch({ type: 'busy', busy: true });
      const name = details.name.trim();
      const email = details.email.trim();
      const result = await api.start({
        ...(name === '' ? {} : { name }),
        ...(email === '' ? {} : { email }),
        // Sent only as ticked, and only when the widget showed a box to tick.
        marketingConsent:
          details.marketingConsent && email !== '' && config.marketingConsentWording !== null,
      });
      if (!result.ok) {
        dispatch({ type: 'busy', busy: false });
        dispatch({ type: 'notice', notice: noticeFor(result.failure) });
        return;
      }
      token = result.value.token;
      expiresAt = result.value.expiresAt;
      store.write({ token, expiresAt, seen: 0 });
      dispatch({ type: 'started' });
      await deliver(deps.newId(), details.text);
    },
    async send(text) {
      const { config } = state;
      if (config === null || token === undefined || state.busy) return;
      const problem = checkMessage(config, text);
      if (problem !== null) {
        dispatch({ type: 'notice', notice: problem });
        return;
      }
      await deliver(deps.newId(), text);
    },
    async retry(id) {
      const item = state.items.find((each) => each.id === id && each.status === 'failed');
      if (item === undefined || state.busy) return;
      await deliver(item.id, item.text);
    },
    end() {
      const ending = token;
      forget(null);
      // Best effort: this browser has forgotten the token whether or not the CRM hears.
      if (ending !== undefined) void api.end(ending);
    },
    visibilityChanged() {
      schedule(!deps.isHidden());
    },
    state: () => state,
  };
}
