// Where the web chat widget keeps a visitor's session between page loads: the website's own
// localStorage, under a name that carries the widget's key.
//
// It is first-party storage, so it does not depend on third-party cookies or on how a
// browser treats embedded frames. The price, stated plainly: any script running on the
// website can read it. The token opens one visitor's web chat with one widget and nothing
// else, and such a script could already read what the visitor types.
//
// A token is only ever read from here. Nothing takes one from the page's address, from a
// message between windows or from a cookie, so nobody can hand a visitor a session of
// their own choosing by a link.

export interface StoredSession {
  readonly token: string;
  /** When the server ends it, as it said when it issued the token. */
  readonly expiresAt: string;
  /** The last place the visitor has seen, so old replies are not announced as new. */
  readonly seen: number;
}

export interface SessionStore {
  read(): StoredSession | undefined;
  write(session: StoredSession): void;
  clear(): void;
}

/** The part of localStorage the store uses. */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function parse(text: string | null, now: number): StoredSession | undefined {
  if (text === null || text.length > 1000) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { token, expiresAt, seen }: { token?: unknown; expiresAt?: unknown; seen?: unknown } =
    value;
  if (typeof token !== 'string' || !TOKEN.test(token)) return undefined;
  if (typeof expiresAt !== 'string') return undefined;
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires) || expires <= now) return undefined;
  return {
    token,
    expiresAt,
    seen: typeof seen === 'number' && Number.isSafeInteger(seen) && seen >= 0 ? seen : 0,
  };
}

/**
 * The store for one widget. `storage` may throw each time it is asked: browsers refuse
 * localStorage in private windows, with site data blocked, or in a sandboxed page. Then the
 * session lives in memory for this page only, and the chat still works.
 */
export function createSessionStore(
  widgetKey: string,
  storage: () => KeyValue,
  now: () => number,
): SessionStore {
  const name = `crm-webchat:${widgetKey}`;
  let memory: StoredSession | undefined;
  return {
    read() {
      try {
        const stored = parse(storage().getItem(name), now());
        if (stored !== undefined) return stored;
      } catch {
        // Fall through to what this page holds.
      }
      if (memory !== undefined && Date.parse(memory.expiresAt) <= now()) memory = undefined;
      return memory;
    },
    write(session) {
      memory = session;
      try {
        storage().setItem(name, JSON.stringify(session));
      } catch {
        // Kept in memory instead.
      }
    },
    clear() {
      memory = undefined;
      try {
        storage().removeItem(name);
      } catch {
        // Nothing was stored there.
      }
    },
  };
}
