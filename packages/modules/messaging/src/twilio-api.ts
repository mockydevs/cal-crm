// The three Twilio REST calls SMS needs, and nothing else: read the account, list the
// numbers it already owns, create a message. Shapes come from Twilio's OpenAPI file
// (twilio-oai, spec/json/twilio_api_v2010.json; an excerpt is in fixtures/twilio).
//
// There is no code path here that buys, releases, moves or reconfigures a phone number, or
// that changes an account. The host is a constant: no caller, database row or Twilio
// response can change where a request goes.
import * as z from 'zod';

import { isTwilioStatus, type TwilioStatus } from './twilio-status.js';

export const TWILIO_ORIGIN = 'https://api.twilio.com';

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;
const NUMBER_SID = /^PN[0-9a-fA-F]{32}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;

export interface TwilioRequest {
  readonly method: 'GET' | 'POST';
  /** Path and query on api.twilio.com; never a full URL. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}
export interface TwilioResponse {
  readonly status: number;
  readonly body: string;
}
/**
 * Sends one request to Twilio. A rejection means no answer was read: the request may or
 * may not have reached Twilio.
 */
export type TwilioTransport = (request: TwilioRequest) => Promise<TwilioResponse>;

export interface TwilioCredentials {
  readonly accountSid: string;
  /** Signs webhooks, and authenticates REST calls when there is no API key. */
  readonly authToken: string;
  readonly apiKey?: { readonly sid: string; readonly secret: string } | undefined;
}

const ACCOUNT = '/2010-04-01/Accounts/AC[0-9a-fA-F]{32}';
const ALLOWED: readonly { readonly method: TwilioRequest['method']; readonly path: RegExp }[] = [
  { method: 'GET', path: new RegExp(`^${ACCOUNT}\\.json$`) },
  {
    method: 'GET',
    path: new RegExp(`^${ACCOUNT}/IncomingPhoneNumbers\\.json(\\?[A-Za-z0-9=&%_.~+-]*)?$`),
  },
  { method: 'POST', path: new RegExp(`^${ACCOUNT}/Messages\\.json$`) },
];

/** Whether a request is one of the three this module may ever send. */
export function isAllowedTwilioRequest(method: string, path: string): boolean {
  return ALLOWED.some((each) => each.method === method && each.path.test(path));
}

class TwilioRequestRefused extends Error {
  constructor() {
    // No path or body: either could carry what a caller tried to smuggle in.
    super('This Twilio request is not one the SMS module makes.');
    this.name = 'TwilioRequestRefused';
  }
}

export interface TwilioTransportOptions {
  /** The whole exchange, in milliseconds. */
  readonly timeoutMs?: number;
  /** Largest response read; a page of 1,000 numbers is well under this. */
  readonly maxResponseBytes?: number;
}

/**
 * The transport the worker uses: Node's fetch to the fixed host. Redirects are not
 * followed, so credentials can't be forwarded anywhere else.
 */
export function createTwilioTransport(
  fetcher: typeof fetch = fetch,
  options: TwilioTransportOptions = {},
): TwilioTransport {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
  return async (request) => {
    if (!isAllowedTwilioRequest(request.method, request.path)) throw new TwilioRequestRefused();
    const url = new URL(request.path, TWILIO_ORIGIN);
    if (url.origin !== TWILIO_ORIGIN) throw new TwilioRequestRefused();
    const response = await fetcher(url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new Error('The Twilio response was not bytes.');
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader?.cancel();
        throw new Error('The Twilio response was too large to read.');
      }
      chunks.push(chunk);
    }
    return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
  };
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

// An API key authenticates REST calls when there is one; the Account SID stays in the path.
function authorization(credentials: TwilioCredentials): string {
  return credentials.apiKey === undefined
    ? basic(credentials.accountSid, credentials.authToken)
    : basic(credentials.apiKey.sid, credentials.apiKey.secret);
}

async function send(transport: TwilioTransport, request: TwilioRequest): Promise<TwilioResponse> {
  if (!isAllowedTwilioRequest(request.method, request.path)) throw new TwilioRequestRefused();
  return transport(request);
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Twilio's error body: { status, message, code?, more_info? }
// (https://www.twilio.com/docs/usage/twilios-response#exceptions). Only the code is read.
const errorBody = z.object({ code: z.number().int().positive() });
function errorCodeOf(body: string): number | null {
  const parsed = errorBody.safeParse(json(body));
  return parsed.success ? parsed.data.code : null;
}

// --- The account ---------------------------------------------------------------------

// api.v2010.account. The response also carries auth_token: it is never read, kept or
// passed on, and no part of the response body leaves this function except these fields.
const accountBody = z.object({
  sid: z.string().regex(ACCOUNT_SID),
  status: z.enum(['active', 'suspended', 'closed']),
  type: z.enum(['Trial', 'Full']),
  owner_account_sid: z.string().regex(ACCOUNT_SID),
});

export interface TwilioAccount {
  readonly sid: string;
  readonly status: 'active' | 'suspended' | 'closed';
  readonly type: 'trial' | 'full';
  /** A subaccount's owner is another account; a parent account owns itself. */
  readonly subaccount: boolean;
}
export type FetchAccountResult =
  | { readonly outcome: 'ok'; readonly account: TwilioAccount }
  /** Twilio refused the credentials, or they can't see this account. */
  | { readonly outcome: 'refused' }
  /** No usable answer: the network, Twilio, or a response we can't read. */
  | { readonly outcome: 'unavailable' };

/**
 * FetchAccount, always with the Account SID and Auth Token: a Standard API key can't read
 * Accounts, and the Auth Token is the secret that must be right, since it signs webhooks.
 */
export async function fetchAccount(
  transport: TwilioTransport,
  credentials: TwilioCredentials,
): Promise<FetchAccountResult> {
  if (!ACCOUNT_SID.test(credentials.accountSid)) return { outcome: 'refused' };
  let response: TwilioResponse;
  try {
    response = await send(transport, {
      method: 'GET',
      path: `/2010-04-01/Accounts/${credentials.accountSid}.json`,
      headers: {
        accept: 'application/json',
        authorization: basic(credentials.accountSid, credentials.authToken),
      },
    });
  } catch {
    return { outcome: 'unavailable' };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404)
    return { outcome: 'refused' };
  if (response.status !== 200) return { outcome: 'unavailable' };
  const parsed = accountBody.safeParse(json(response.body));
  if (!parsed.success) return { outcome: 'unavailable' };
  const { sid, status, type, owner_account_sid: owner } = parsed.data;
  return {
    outcome: 'ok',
    account: { sid, status, type: type === 'Trial' ? 'trial' : 'full', subaccount: owner !== sid },
  };
}

// --- The numbers the account owns ------------------------------------------------------

export interface TwilioNumber {
  /** The IncomingPhoneNumber SID. */
  readonly sid: string;
  readonly e164: string;
  readonly friendlyName: string;
  readonly capabilities: readonly ('sms' | 'mms' | 'voice')[];
}
export type ListNumbersResult =
  | {
      readonly outcome: 'ok';
      readonly numbers: readonly TwilioNumber[];
      /** True when the account has more numbers than the page limit allowed us to read. */
      readonly truncated: boolean;
    }
  | { readonly outcome: 'refused' }
  | { readonly outcome: 'unavailable' };

// ListIncomingPhoneNumberResponse. Every field of a number is nullable in the spec, so
// each is read on its own and a number that can't be used is left out.
const numbersPage = z.object({
  incoming_phone_numbers: z.array(z.unknown()),
  next_page_uri: z.string().nullable().optional(),
});
const numberBody = z.object({
  sid: z.string().regex(NUMBER_SID),
  account_sid: z.string().regex(ACCOUNT_SID),
  phone_number: z.string().regex(E164),
  friendly_name: z.string().nullable().optional(),
  capabilities: z
    .object({
      sms: z.boolean().optional(),
      mms: z.boolean().optional(),
      voice: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

export const NUMBER_PAGE_SIZE = 1000;
export const NUMBER_PAGE_LIMIT = 20;

/** ListIncomingPhoneNumber: read-only, following next_page_uri as Twilio gives it. */
export async function listIncomingPhoneNumbers(
  transport: TwilioTransport,
  credentials: TwilioCredentials,
): Promise<ListNumbersResult> {
  if (!ACCOUNT_SID.test(credentials.accountSid)) return { outcome: 'refused' };
  const base = `/2010-04-01/Accounts/${credentials.accountSid}/IncomingPhoneNumbers.json`;
  const numbers = new Map<string, TwilioNumber>();
  let path: string | null = `${base}?PageSize=${String(NUMBER_PAGE_SIZE)}`;
  for (let page = 0; page < NUMBER_PAGE_LIMIT && path !== null; page += 1) {
    let response: TwilioResponse;
    try {
      response = await send(transport, {
        method: 'GET',
        path,
        headers: { accept: 'application/json', authorization: authorization(credentials) },
      });
    } catch {
      return { outcome: 'unavailable' };
    }
    if (response.status === 401 || response.status === 403 || response.status === 404)
      return { outcome: 'refused' };
    if (response.status !== 200) return { outcome: 'unavailable' };
    const parsed = numbersPage.safeParse(json(response.body));
    if (!parsed.success) return { outcome: 'unavailable' };
    for (const each of parsed.data.incoming_phone_numbers) {
      const number = numberBody.safeParse(each);
      // Another account's number, or one without an E.164 form, is not ours to offer.
      if (!number.success || number.data.account_sid !== credentials.accountSid) continue;
      const { capabilities } = number.data;
      numbers.set(number.data.sid, {
        sid: number.data.sid,
        e164: number.data.phone_number,
        friendlyName: number.data.friendly_name ?? '',
        capabilities: (['sms', 'mms', 'voice'] as const).filter(
          (name) => capabilities?.[name] === true,
        ),
      });
    }
    const next: string | null = parsed.data.next_page_uri ?? null;
    // Only this account's own list, on the fixed host: anything else is not followed.
    if (next !== null && !(next.startsWith(`${base}?`) && isAllowedTwilioRequest('GET', next)))
      return { outcome: 'unavailable' };
    path = next;
  }
  return { outcome: 'ok', numbers: [...numbers.values()], truncated: path !== null };
}

// --- Creating a message ----------------------------------------------------------------

export interface TwilioMessageInput {
  /** E.164. */
  readonly to: string;
  /** E.164: a number the account owns. */
  readonly from: string;
  readonly body: string;
  /** Where Twilio reports the message's later statuses. */
  readonly statusCallback: string;
}

export type CreateMessageResult =
  | {
      readonly outcome: 'accepted';
      /** The Message SID. */
      readonly sid: string;
      readonly status: TwilioStatus | null;
      readonly segments: number | null;
    }
  /** Twilio answered that it did not create the message. Nothing was sent. */
  | { readonly outcome: 'rejected'; readonly httpStatus: number; readonly code: number | null }
  /**
   * Twilio may have created the message. CreateMessage has no idempotency key, so sending
   * again could text the person twice: an unknown send is never repeated automatically.
   */
  | {
      readonly outcome: 'unknown';
      readonly reason: 'no_response' | 'server_error' | 'unreadable' | 'unexpected_status';
    };

// api.v2010.account.message, as CreateMessage answers (201). num_segments is a string.
const messageBody = z.object({
  sid: z.string().regex(MESSAGE_SID),
  account_sid: z.string().regex(ACCOUNT_SID),
  status: z.string().nullable().optional(),
  num_segments: z.string().nullable().optional(),
});

export interface CreateMessageOptions {
  /**
   * Waits before each retry of an HTTP 429, which Twilio documents as "aren't processed and
   * are safe to retry" (docs/api/errors/20429). Nothing else is ever retried.
   */
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Sorts one CreateMessage answer into accepted, rejected or unknown. */
export function classifyCreateMessage(
  response: TwilioResponse,
  accountSid: string,
): CreateMessageResult {
  const { status } = response;
  if (status >= 200 && status < 300) {
    const parsed = messageBody.safeParse(json(response.body));
    // A success we can't read, or about another account, proves nothing either way.
    if (!parsed.success || parsed.data.account_sid !== accountSid)
      return { outcome: 'unknown', reason: 'unreadable' };
    const reported = parsed.data.status ?? '';
    const segments = /^[0-9]{1,4}$/.test(parsed.data.num_segments ?? '')
      ? Number(parsed.data.num_segments)
      : null;
    return {
      outcome: 'accepted',
      sid: parsed.data.sid,
      status: isTwilioStatus(reported) ? reported : null,
      segments,
    };
  }
  if (status >= 400 && status < 500)
    return { outcome: 'rejected', httpStatus: status, code: errorCodeOf(response.body) };
  if (status >= 500 && status < 600) return { outcome: 'unknown', reason: 'server_error' };
  // 1xx and 3xx are never expected; a redirect is not followed.
  return { outcome: 'unknown', reason: 'unexpected_status' };
}

/** The exact form CreateMessage is sent: these four parameters and no others. */
export function createMessageForm(input: TwilioMessageInput): string {
  return new URLSearchParams([
    ['To', input.to],
    ['From', input.from],
    ['Body', input.body],
    ['StatusCallback', input.statusCallback],
  ]).toString();
}

/**
 * CreateMessage, once. The only repeat is after an HTTP 429, bounded, with the identical
 * request. A timeout, a 5xx or an unreadable answer is `unknown` and is not repeated.
 */
export async function createMessage(
  transport: TwilioTransport,
  credentials: TwilioCredentials,
  input: TwilioMessageInput,
  options: CreateMessageOptions = {},
): Promise<CreateMessageResult> {
  if (!ACCOUNT_SID.test(credentials.accountSid) || !E164.test(input.to) || !E164.test(input.from))
    return { outcome: 'rejected', httpStatus: 0, code: null };
  const request: TwilioRequest = {
    method: 'POST',
    path: `/2010-04-01/Accounts/${credentials.accountSid}/Messages.json`,
    headers: {
      accept: 'application/json',
      authorization: authorization(credentials),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: createMessageForm(input),
  };
  const delays = options.retryDelaysMs ?? [250, 1000];
  const sleep = options.sleep ?? wait;
  for (let attempt = 0; ; attempt += 1) {
    let response: TwilioResponse;
    try {
      response = await send(transport, request);
    } catch {
      return { outcome: 'unknown', reason: 'no_response' };
    }
    const delay = delays[attempt];
    if (response.status !== 429 || delay === undefined)
      return classifyCreateMessage(response, credentials.accountSid);
    await sleep(delay);
  }
}
