// The web chat widget's calls to the CRM. Runs in a visitor's browser on someone else's
// website, so it trusts nothing it receives and never throws: every outcome is a value, and
// anything unexpected reads as "not available".

/** What the widget's form needs, from GET /public/webchat/{key}. */
export interface WidgetConfig {
  readonly title: string;
  readonly greeting: string;
  readonly emailRequired: boolean;
  readonly marketingConsentWording: string | null;
  readonly messageLength: number;
}

export interface WidgetMessage {
  readonly seq: number;
  readonly from: 'visitor' | 'team';
  readonly text: string;
  readonly sentAt: string;
}

export interface WidgetSession {
  readonly token: string;
  readonly expiresAt: string;
}

export interface WidgetPage {
  readonly messages: readonly WidgetMessage[];
  readonly cursor: number;
  readonly more: boolean;
}

export type Failure =
  /** The session no longer answers: forget it. */
  | 'session'
  /** The session has had every message it takes: forget it. */
  | 'full'
  /** Too fast, or too many: wait. */
  | 'limited'
  /** The details were refused. */
  | 'invalid'
  /** The widget is off, the website is not allowed, or the CRM answered with an error. */
  | 'unavailable'
  /** No answer at all: offline, blocked, or refused before the CRM could say why. */
  | 'network';

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: Failure; readonly retryAfterSeconds?: number };

/** The part of fetch the client uses; tests pass their own. */
export type Fetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly credentials: 'omit';
    readonly mode: 'cors';
    readonly cache: 'no-store';
    readonly referrerPolicy: 'no-referrer';
    readonly redirect: 'error';
  },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface WidgetApi {
  config(): Promise<Outcome<WidgetConfig>>;
  start(details: {
    readonly name?: string;
    readonly email?: string;
    readonly marketingConsent: boolean;
  }): Promise<Outcome<WidgetSession>>;
  send(token: string, clientMessageId: string, text: string): Promise<Outcome<WidgetMessage>>;
  messages(token: string, after: number): Promise<Outcome<WidgetPage>>;
  end(token: string): Promise<Outcome<null>>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A message exactly as the contract gives it, or undefined: nothing else is ever shown. */
export function readMessage(value: unknown): WidgetMessage | undefined {
  if (!isRecord(value)) return undefined;
  const { seq, from, text, sentAt } = value;
  if (!isCount(seq) || seq < 1) return undefined;
  if (from !== 'visitor' && from !== 'team') return undefined;
  if (typeof text !== 'string' || typeof sentAt !== 'string') return undefined;
  return { seq, from, text, sentAt };
}

function readConfig(value: unknown): WidgetConfig | undefined {
  if (!isRecord(value)) return undefined;
  const { title, greeting, emailRequired, marketingConsentWording: wording, messageLength } = value;
  if (typeof title !== 'string' || typeof greeting !== 'string') return undefined;
  if (typeof emailRequired !== 'boolean') return undefined;
  if (wording !== null && typeof wording !== 'string') return undefined;
  if (!isCount(messageLength) || messageLength < 1) return undefined;
  return { title, greeting, emailRequired, marketingConsentWording: wording, messageLength };
}

function readSession(value: unknown): WidgetSession | undefined {
  if (!isRecord(value)) return undefined;
  const { token, expiresAt } = value;
  // The token goes into a request header later: only the alphabet it is made of.
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  return typeof expiresAt === 'string' ? { token, expiresAt } : undefined;
}

function readPage(value: unknown): WidgetPage | undefined {
  if (!isRecord(value)) return undefined;
  const { messages, cursor, more } = value;
  if (!Array.isArray(messages) || !isCount(cursor) || typeof more !== 'boolean') return undefined;
  const read: WidgetMessage[] = [];
  for (const each of messages) {
    const message = readMessage(each);
    if (message === undefined) return undefined;
    read.push(message);
  }
  return { messages: read, cursor, more };
}

function failureOf(status: number): Failure {
  if (status === 401) return 'session';
  if (status === 410) return 'full';
  if (status === 429) return 'limited';
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'invalid';
  // 409 is a request that met another of the same session: sending again settles it.
  if (status === 409) return 'network';
  return 'unavailable';
}

function retryAfter(header: string | null): number | undefined {
  if (header === null || !/^\d{1,5}$/.test(header)) return undefined;
  const seconds = Number(header);
  return seconds >= 1 ? seconds : undefined;
}

/**
 * The client for one widget. `base` is the CRM's own address, taken from the script's URL;
 * `widgetKey` comes from the embedding page and is checked before it is put in a path.
 * Requests carry no cookies, no referrer and follow no redirect.
 */
export function createWidgetApi(base: string, widgetKey: string, fetch: Fetch): WidgetApi {
  const root = `${base}/api/v1/public/webchat/${encodeURIComponent(widgetKey)}`;

  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    read: (value: unknown) => T | undefined,
    options: { readonly token?: string; readonly body?: unknown; readonly empty?: boolean } = {},
  ): Promise<Outcome<T>> {
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${root}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      });
      if (response.status < 200 || response.status > 299) {
        const wait = retryAfter(response.headers.get('retry-after'));
        return {
          ok: false,
          failure: failureOf(response.status),
          ...(wait === undefined ? {} : { retryAfterSeconds: wait }),
        };
      }
      const value = options.empty === true ? read(null) : read(await response.json());
      return value === undefined ? { ok: false, failure: 'unavailable' } : { ok: true, value };
    } catch {
      return { ok: false, failure: 'network' };
    }
  }

  return {
    config: () => call('GET', '', readConfig),
    start: (details) => call('POST', '/sessions', readSession, { body: details }),
    send: (token, clientMessageId, text) =>
      call('POST', '/messages', readMessage, { token, body: { clientMessageId, text } }),
    messages: (token, after) =>
      call('GET', `/messages?after=${String(Math.max(0, Math.trunc(after)))}`, readPage, { token }),
    end: (token) =>
      call('POST', '/session/end', (value) => (value === null ? null : undefined), {
        token,
        empty: true,
      }),
  };
}
