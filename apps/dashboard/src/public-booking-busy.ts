// What the public booking page does when the server says it is busy. Each business has a
// short line for its booking requests (apps/server/src/intake-gate.ts, and the shared
// limiter): one that finds the line full is answered 429 with Retry-After. The calendar is
// fine and so is the link, so the page says it is busy and asks again by itself: after the
// time the server names, or after two seconds and then longer, a few times, and only then
// leaves trying again to the visitor.
//
// The SDK's ApiError carries the problem and no headers (packages/sdk/src/client.ts), but
// a client takes the fetch it sends with (`ClientOptions.fetch`): the header is read there,
// where the request is made, and nothing of the SDK is changed.
import type { Endpoint, EndpointOutput } from '@repo/contracts';
import { ApiError, createClient, type RequestInput } from '@repo/sdk';

/** How many times a busy answer is asked again by itself before the visitor is asked to. */
export const BUSY_TRIES = 3;
/** How long to wait before each new try when the server names no time: longer each time. */
const WAITS_MS = [2000, 4000, 8000] as const;
/** The least and the most a named wait is taken as: never at once, never out of sight. */
const SHORTEST_MS = 1000;
const LONGEST_MS = 30_000;

/** The server is busy with this business's booking requests: asked again, it will answer. */
export class BusyError extends Error {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- the error's name, for whoever reads a log
  override readonly name = 'BusyError';

  constructor(
    /** How long the server asked to be left alone, or null when it named no time. */
    readonly retryAfterMs: number | null,
  ) {
    // Never shown: the page says it in the reader's language.
    super('busy');
  }
}

/**
 * A Retry-After header as milliseconds from now: a number of seconds, or a date (RFC 9110,
 * 10.2.3). Null for a header that is missing or says neither. Kept between one second and
 * thirty, whatever it says.
 */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const text = header.trim();
  // A date is written with the names of its day and month: a bare number that is not a
  // count of seconds ("-3", "1.5") is neither, though a browser would read a year into it.
  const wait = /^\d+$/.test(text)
    ? Number(text) * 1000
    : /[A-Za-z]/.test(text)
      ? Date.parse(text) - now
      : Number.NaN;
  if (!Number.isFinite(wait)) return null;
  return Math.min(LONGEST_MS, Math.max(SHORTEST_MS, wait));
}

/** How long to wait before try number `attempt` (from 1) of a request that was told to wait. */
export function waitBeforeTry(attempt: number, named: number | null): number {
  return named ?? WAITS_MS[Math.min(attempt, WAITS_MS.length) - 1] ?? WAITS_MS[0];
}

const baseUrl = '/api/v1';

/**
 * Calls an endpoint outside any business, as the page's own client does, and says
 * `BusyError` with the server's Retry-After when the answer is 429.
 */
export async function requestOrBusy<E extends Endpoint>(
  endpoint: E,
  input: RequestInput<E>,
  send: typeof fetch = fetch,
): Promise<EndpointOutput<E>> {
  let named: number | null = null;
  const client = createClient({
    baseUrl,
    fetch: async (...sent) => {
      const response = await send(...sent);
      if (response.status === 429)
        named = retryAfterMs(response.headers.get('retry-after'), Date.now());
      return response;
    },
  });
  return client.request(endpoint, input).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 429) throw new BusyError(named);
    throw error;
  });
}

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      // eslint-disable-next-line lingui/no-unlocalized-strings -- the platform's own name for a stopped wait
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

export interface BusyOptions {
  /** Hears each time the request is told to wait and will be sent again; and when it ends. */
  readonly onWaiting?: (waiting: boolean) => void;
  /** Stops waiting: the page no longer wants the answer. */
  readonly signal?: AbortSignal | undefined;
  /** The wait itself, for a test to stand in for. */
  readonly pause?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

/**
 * Runs a request, and runs it again by itself each time it is told the server is busy, up
 * to BUSY_TRIES more times. `run` sends the very same request each time, so a booking that
 * did arrive is recognised by its request id and stored once. Anything else it throws, and
 * a busy answer after the last try, is thrown on.
 */
export async function againWhenBusy<Result>(
  run: () => Promise<Result>,
  { onWaiting, signal, pause = sleep }: BusyOptions = {},
): Promise<Result> {
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (!(error instanceof BusyError) || attempt > BUSY_TRIES) throw error;
        onWaiting?.(true);
        await pause(waitBeforeTry(attempt, error.retryAfterMs), signal);
      }
    }
  } finally {
    onWaiting?.(false);
  }
}
