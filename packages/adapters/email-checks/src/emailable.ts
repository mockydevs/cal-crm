import type {
  MailboxOutcome,
  MailboxProvider,
  ProviderCallOptions,
  ProviderFailure,
  ProviderProblem,
  VerificationReason,
  VerificationStatus,
} from './provider.js';

// Emailable's API as its reference documents it (https://emailable.com/docs/api/):
//   GET /v1/verify?email=…   one address (emails/)
//   GET /v1/account          the credits left (account/)
// The key goes in an Authorization: Bearer header, never the URL (authentication/). A key
// starting test_ simulates answers and uses no credits.

export interface EmailableOptions {
  readonly apiKey: string;
  /** https://api.emailable.com/v1/ unless given; tests point it at a local server. */
  readonly baseUrl?: string;
  /**
   * How long Emailable waits on the mail server before answering 249 "try again", in
   * seconds: 2 to 10, its default 5. Ten here, since checks run in the background.
   */
  readonly timeoutSeconds?: number;
  /**
   * How often a 249 is asked again at once before giving up as slow. Emailable charges
   * nothing for asking again within five minutes.
   */
  readonly slowRetries?: number;
  /** The whole request's limit, in milliseconds: timeoutSeconds plus 5 s unless given. */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.emailable.com/v1/';

// The reasons Emailable gives per state ("All possible states and reasons", and the
// reason_counts of a batch's status), mapped onto ours.
const UNDELIVERABLE: Readonly<Record<string, VerificationReason>> = {
  invalid_email: 'bad_syntax',
  invalid_domain: 'domain_not_found',
  rejected_email: 'mailbox_not_found',
  invalid_smtp: 'smtp_rejected',
};
const RISKY: Readonly<Record<string, VerificationReason>> = {
  low_quality: 'low_quality',
  low_deliverability: 'low_deliverability',
};
const UNKNOWN: Readonly<Record<string, VerificationReason>> = {
  no_connect: 'mail_server_unavailable',
  timeout: 'mail_server_unavailable',
  unavailable_smtp: 'mail_server_unavailable',
  unexpected_error: 'provider_error',
};
const STATES: Readonly<Record<string, VerificationStatus>> = {
  deliverable: 'valid',
  undeliverable: 'invalid',
  risky: 'risky',
  unknown: 'unknown',
};

type Answer = { readonly kind: 'json'; readonly body: unknown } | ProviderFailure;

/** A mailbox provider on Emailable's single-address API. */
export function emailableProvider(options: EmailableOptions): MailboxProvider {
  const apiKey = options.apiKey.trim();
  if (apiKey === '') throw new TypeError('An Emailable API key is required.');
  const timeoutSeconds = options.timeoutSeconds ?? 10;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 2 || timeoutSeconds > 10)
    throw new RangeError('timeoutSeconds must be a whole number from 2 to 10.');
  const slowRetries = options.slowRetries ?? 2;
  if (!Number.isInteger(slowRetries) || slowRetries < 0 || slowRetries > 10)
    throw new RangeError('slowRetries must be a whole number from 0 to 10.');
  const requestTimeoutMs = options.requestTimeoutMs ?? timeoutSeconds * 1000 + 5000;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const testMode = apiKey.startsWith('test_');

  async function get(
    path: string,
    query: Readonly<Record<string, string>>,
    call: ProviderCallOptions,
  ): Promise<Answer> {
    const url = new URL(path, baseUrl);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const timer = AbortSignal.timeout(requestTimeoutMs);
    const signal = call.signal === undefined ? timer : AbortSignal.any([timer, call.signal]);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        // A redirect is answered as an unexpected status: the key is never sent on.
        redirect: 'manual',
        signal,
      });
    } catch {
      // The error may quote the URL, which holds the address: only its kind is kept.
      return failure(call.signal?.aborted ? 'cancelled' : timer.aborted ? 'timeout' : 'network');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return statusFailure(response);
    }
    try {
      return { kind: 'json', body: await response.json() };
    } catch {
      return failure(timer.aborted ? 'timeout' : 'bad_response');
    }
  }

  return {
    name: 'emailable',

    async verify(address, call = {}) {
      const query = { email: address, timeout: String(timeoutSeconds) };
      let answer = await get('verify', query, call);
      for (let retry = 0; retry < slowRetries && isSlow(answer); retry += 1)
        answer = await get('verify', query, call);
      return answer.kind === 'json' ? readVerification(answer.body, testMode) : answer;
    },

    async account(call = {}) {
      const answer = await get('account', {}, call);
      if (answer.kind !== 'json') return answer;
      const credits = field(answer.body, 'available_credits');
      return typeof credits === 'number' && Number.isInteger(credits)
        ? { kind: 'ok', availableCredits: credits, testMode }
        : failure('bad_response');
    },
  };
}

function isSlow(answer: Answer): boolean {
  return answer.kind === 'failed' && answer.problem === 'slow';
}

function failure(problem: ProviderProblem, retryAfterMs?: number): ProviderFailure {
  const connectionFailing = problem === 'unauthorized' || problem === 'no_credits';
  return retryAfterMs === undefined
    ? { kind: 'failed', problem, connectionFailing }
    : { kind: 'failed', problem, connectionFailing, retryAfterMs };
}

// Emailable's status codes (https://emailable.com/docs/api/status-codes/).
function statusFailure(response: Response): ProviderFailure {
  switch (response.status) {
    case 249:
      return failure('slow');
    case 400:
      return failure('bad_request');
    case 401: // no key sent
    case 403: // the key is invalid, or the request failed to authenticate
      return failure('unauthorized');
    case 402:
      return failure('no_credits');
    case 429:
      return failure('rate_limited', retryAfter(response.headers.get('ratelimit-reset')));
    case 500:
    case 503:
      return failure('unavailable');
    default:
      return failure('unexpected_status');
  }
}

/**
 * The wait a 429 asks for. The rate limits page documents ratelimit-reset as "the
 * timestamp, in seconds, when the current window resets"; the limits are per second, so
 * one second is waited when it is missing or already past, and never more than a minute.
 */
function retryAfter(reset: string | null): number {
  const seconds = Number(reset);
  const wait = reset !== null && Number.isFinite(seconds) ? seconds * 1000 - Date.now() : 0;
  return Math.min(Math.max(Math.ceil(wait), 1000), 60_000);
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && name in body
    ? (body as Readonly<Record<string, unknown>>)[name]
    : undefined;
}

function readVerification(body: unknown, testMode: boolean): MailboxOutcome {
  const state = field(body, 'state');
  const reasonWord = field(body, 'reason');
  if (typeof state !== 'string') return failure('bad_response');
  const status = STATES[state];
  if (status === undefined) return failure('bad_response');
  const reason = typeof reasonWord === 'string' ? reasonWord : null;
  const flag = (name: string) => field(body, name) === true;

  const reasons: VerificationReason[] = [];
  let mapped: VerificationReason | undefined;
  if (reason !== null) {
    if (status === 'invalid') mapped = UNDELIVERABLE[reason];
    else if (status === 'risky') mapped = RISKY[reason];
    else if (status === 'unknown') mapped = UNKNOWN[reason];
  }
  if (mapped !== undefined) reasons.push(mapped);
  if (flag('disposable')) reasons.push('disposable');
  if (flag('accept_all')) reasons.push('catch_all');
  if (flag('mailbox_full')) reasons.push('mailbox_full');
  if (flag('role')) reasons.push('role');
  if (flag('free')) reasons.push('free_provider');

  // A deliverable mailbox on a disposable service, at an accept-all server, or full may
  // still lose the mail: a warning, as Emailable's own help says of these attributes.
  const warned =
    status === 'valid' && (flag('disposable') || flag('accept_all') || flag('mailbox_full'));
  return {
    kind: 'result',
    status: warned ? 'risky' : status,
    reasons,
    raw: { state, reason },
    // "We do not charge credits for the following Email States: Unknown" (How Credits
    // Work); a test key uses none at all.
    charged: !testMode && status !== 'unknown',
  };
}
