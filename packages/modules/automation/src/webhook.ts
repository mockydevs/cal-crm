// The core of the webhook.call step: one signed HTTPS request to an outside app, with a
// deadline, a capped response, and a guard that keeps it off private networks. It returns a
// result rather than throwing, and says whether a failure is worth retrying; the runner
// decides when, with webhookRetryDelay.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { isAllowedWebhookHeader, type AutomationStep } from '@repo/contracts';

export const WEBHOOK_TIMESTAMP_HEADER = 'X-CRM-Timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'X-CRM-Signature';
export const WEBHOOK_DELIVERY_HEADER = 'X-CRM-Delivery';
/** The scheme in front of the signature, so the signing can change without breaking receivers. */
export const WEBHOOK_SIGNATURE_SCHEME = 'v1';
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_RETRY_BASE_MS = 60_000;
export const WEBHOOK_RETRY_CAP_MS = 3_600_000;

const HTTPS_PORT = 443;
const MAX_TIMEOUT_MS = 60_000;
const EXCERPT_LENGTH = 200;

/** The part of the step's config this needs; `body` is rendered into the payload before here. */
export type WebhookCallConfig = Pick<
  Extract<AutomationStep, { readonly type: 'webhook.call' }>['config'],
  'url' | 'method'
>;

export type WebhookFailureCode =
  | 'invalid_url'
  | 'invalid_payload'
  | 'blocked_address'
  | 'timeout'
  | 'network_error'
  | 'redirect'
  | 'http_error'
  | 'invalid_header';

export type WebhookCallResult =
  | {
      readonly ok: true;
      readonly status: number;
      /** The response body, cut at the cap. It comes from outside: treat it as untrusted. */
      readonly body: string;
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      readonly code: WebhookFailureCode;
      readonly retryable: boolean;
      readonly message: string;
      readonly status?: number;
      /** What a 429 or 503 asked for in Retry-After, for webhookRetryDelay. */
      readonly retryAfterMs?: number;
    };

export interface WebhookAddress {
  readonly address: string;
  readonly family: number;
}

/** DNS for a host name: every address it has. */
export type WebhookLookup = (hostname: string) => Promise<readonly WebhookAddress[]>;

export type WebhookAddressResult =
  | { readonly ok: true; readonly address: string; readonly family: 4 | 6 }
  | {
      readonly ok: false;
      readonly code: 'blocked_address' | 'dns_error';
      readonly message: string;
    };

export type WebhookUrlResult =
  | { readonly ok: true; readonly url: URL; readonly port: number }
  | { readonly ok: false; readonly message: string };

/** The parts of node:https's response and request this uses, so tests can stand in for them. */
export interface WebhookResponseStream {
  readonly statusCode?: number | undefined;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  destroy(): unknown;
}

export interface WebhookRequestStream {
  on(event: 'response', listener: (response: WebhookResponseStream) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  end(body: string): unknown;
  destroy(): unknown;
}

export type WebhookRequester = (options: RequestOptions) => WebhookRequestStream;

export interface WebhookHeaderValue {
  readonly name: string;
  readonly value: string;
}

export interface WebhookCallOptions {
  /** The signing secret. It goes into the HMAC and nowhere else. */
  readonly secret: string;
  /**
   * Names this delivery to the receiver. A retry of the same delivery carries the same id,
   * so a receiver that got the first attempt can ignore the repeat.
   */
  readonly deliveryId?: string;
  /**
   * The step's own headers, with their values filled in. A value may be a secret: like
   * the signing secret, it goes into the request and nowhere else.
   */
  readonly headers?: readonly WebhookHeaderValue[];
  readonly now?: () => Date;
  /** One deadline for DNS, connecting, sending and reading the whole response. */
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  /** Trusted install configuration, never taken from an automation: ports besides 443. */
  readonly allowedPorts?: readonly number[];
  readonly lookup?: WebhookLookup;
  readonly requester?: WebhookRequester;
}

/**
 * The address with every query value hidden, for what a run's history shows: a value there
 * may be a key. The names are kept, so the history still says what was sent.
 */
export function redactWebhookUrl(value: string): string {
  if (!URL.canParse(value)) return value;
  const url = new URL(value);
  if (url.search === '') return value;
  const names = [...url.searchParams.keys()];
  url.search = names.map((name) => `${encodeURIComponent(name)}=redacted`).join('&');
  return url.toString();
}

// Signing

/** HMAC-SHA256 over `${timestamp}.${body}`, in hex. The timestamp is Unix seconds. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');
}

/**
 * For receivers: whether a signature header (`v1=<hex>`) matches. Compared in constant time,
 * so a wrong guess can't be improved by timing it. Receivers should also refuse old timestamps.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
): boolean {
  const expected = Buffer.from(
    `${WEBHOOK_SIGNATURE_SCHEME}=${signWebhook(secret, timestamp, body)}`,
  );
  const given = Buffer.from(signature);
  // timingSafeEqual throws on unequal lengths; the length of a signature is no secret.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The address guard

// IPv4 that is not the public internet (IANA special-purpose registry; the same set the mail
// adapter refuses through ipaddr.js). BlockList also matches the IPv4-mapped IPv6 form of each.
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

// Inside global unicast (2000::/3) but not public: protocol assignments including Teredo,
// documentation, and 6to4, which carries an IPv4 address that would go unchecked.
const BLOCKED_V6: readonly (readonly [string, number])[] = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
];

const blocked = new BlockList();
for (const [network, prefix] of BLOCKED_V4) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of BLOCKED_V6) blocked.addSubnet(network, prefix, 'ipv6');

// Everything public in IPv6 is in 2000::/3; loopback, unique-local, link-local, multicast
// and NAT64 are all outside it, so one allow rule covers them and whatever is reserved next.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

const mappedV4 = new BlockList();
mappedV4.addSubnet('::ffff:0:0', 96, 'ipv6');

/** Whether an IP address is on the public internet. Anything else, or not an IP, is false. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // A zone (fe80::1%eth0) names a local interface.
  if (family !== 6 || address.includes('%')) return false;
  // An IPv4-mapped address connects over IPv4, so the IPv4 rules decide.
  if (mappedV4.check(address, 'ipv6')) return !blocked.check(address, 'ipv6');
  return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

const systemLookup: WebhookLookup = (hostname) => dnsLookup(hostname, { all: true });

/**
 * Resolves a host once and refuses it if ANY of its addresses is not public, so a name can't
 * hide a private address behind a public one. The caller must connect to the address returned
 * (see pinnedLookup), not resolve the name again. `hostname` is as URL.hostname gives it.
 */
export async function resolvePublicAddress(
  hostname: string,
  lookup: WebhookLookup = systemLookup,
): Promise<WebhookAddressResult> {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly string[];
  if (isIP(host) === 0) {
    try {
      addresses = (await lookup(host)).map((item) => item.address);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0)
      return { ok: false, code: 'dns_error', message: "The webhook's host could not be found." };
  } else addresses = [host];
  const [first] = addresses;
  if (first === undefined || !addresses.every(isPublicAddress))
    return {
      ok: false,
      code: 'blocked_address',
      message: "The webhook's host is not on the public internet.",
    };
  return { ok: true, address: first, family: isIP(first) === 6 ? 6 : 4 };
}

/**
 * Checks the URL's shape: https, no credentials, and port 443 unless the install allows
 * another. Other ports are refused by default so a webhook can't be aimed at a mail server
 * or database that happens to have a public address. The message never repeats the URL.
 */
export function parseWebhookUrl(
  value: string,
  allowedPorts: readonly number[] = [],
): WebhookUrlResult {
  if (!URL.canParse(value)) return { ok: false, message: 'The webhook address is not a URL.' };
  const url = new URL(value);
  if (url.protocol !== 'https:')
    return { ok: false, message: 'The webhook address must start with https://.' };
  if (url.username !== '' || url.password !== '')
    return { ok: false, message: "The webhook address can't hold a user name or password." };
  // URL drops the scheme's default port, so an empty port is 443.
  const port = url.port === '' ? HTTPS_PORT : Number(url.port);
  if (port !== HTTPS_PORT && !allowedPorts.includes(port))
    return { ok: false, message: `The webhook address can't use port ${String(port)}.` };
  return { ok: true, url, port };
}

/**
 * A lookup for node:https that answers with the checked address whatever it is asked, so the
 * socket goes where the guard looked and a second DNS answer can't redirect it. The request's
 * host stays the name, so TLS still sends it as SNI and checks the certificate against it.
 */
function pinnedLookup(address: string, family: number): LookupFunction {
  return (_hostname, options, callback) => {
    // net asks for a list when it may try several families, and for one address otherwise.
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

// Retries

/**
 * How long to wait before the next attempt, or undefined when the attempts are used up.
 * `attempt` counts the attempts already made: 1 minute after the first, doubling, at most an
 * hour. A Retry-After from the server can lengthen the wait up to that cap, never shorten it.
 */
export function webhookRetryDelay(attempt: number, retryAfterMs?: number): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new RangeError('The attempt must be a whole number from 1.');
  if (attempt >= WEBHOOK_MAX_ATTEMPTS) return undefined;
  const backoff = WEBHOOK_RETRY_BASE_MS * 2 ** (attempt - 1);
  return Math.min(Math.max(backoff, retryAfterMs ?? 0), WEBHOOK_RETRY_CAP_MS);
}

const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const LONG_DAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = `(?<month>${MONTHS.join('|')})`;
const TIME = '(?<hour>\\d{2}):(?<minute>\\d{2}):(?<second>\\d{2})';
// The three HTTP-date forms of RFC 9110 section 5.6.7, which a recipient must accept.
const HTTP_DATES = [
  new RegExp(`^${DAY}, (?<day>\\d{2}) ${MONTH} (?<year>\\d{4}) ${TIME} GMT$`),
  new RegExp(`^${LONG_DAY}, (?<day>\\d{2})-${MONTH}-(?<shortYear>\\d{2}) ${TIME} GMT$`),
  new RegExp(`^${DAY} ${MONTH} (?<day>\\d{2}| \\d) ${TIME} (?<year>\\d{4})$`),
];

function parseHttpDate(value: string, now: Date): number | undefined {
  for (const form of HTTP_DATES) {
    const parts = form.exec(value)?.groups;
    if (parts === undefined) continue;
    const { shortYear } = parts;
    const month = MONTHS.indexOf(parts['month'] ?? '');
    const day = Number(parts['day']);
    const hour = Number(parts['hour']);
    const minute = Number(parts['minute']);
    // A leap second (23:59:60) is allowed by the grammar; the clock here has none.
    const second = Math.min(Number(parts['second']), 59);
    let year = Number(parts['year']);
    if (shortYear !== undefined) {
      const thisYear = now.getUTCFullYear();
      year = thisYear - (thisYear % 100) + Number(shortYear);
      // RFC 9110: a two-digit year more than 50 years ahead means the century before.
      if (year > thisYear + 50) year -= 100;
    }
    const date = new Date(Date.UTC(year, month, day, hour, minute, second));
    // Date.UTC rolls 31 Feb or 25:00 over into the next month or day: those aren't dates.
    return date.getUTCMonth() === month && date.getUTCDate() === day && date.getUTCHours() === hour
      ? date.getTime()
      : undefined;
  }
  return undefined;
}

/**
 * Reads a Retry-After value (RFC 9110 section 10.2.3: a count of seconds, or an HTTP-date)
 * as milliseconds to wait from `now`. Undefined when it is neither.
 */
export function parseRetryAfter(value: string, now: Date): number | undefined {
  const text = value.trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, Number.MAX_SAFE_INTEGER);
  const at = parseHttpDate(text, now);
  return at === undefined ? undefined : Math.max(at - now.getTime(), 0);
}

// The call

type WebhookFailure = Extract<WebhookCallResult, { readonly ok: false }>;

const RETRYABLE_STATUSES = new Set([408, 429]);

const failure = (
  code: Exclude<WebhookFailureCode, 'http_error' | 'redirect'>,
  message: string,
): WebhookFailure => ({
  ok: false,
  code,
  retryable: code === 'timeout' || code === 'network_error',
  message,
});

function jsonOf(payload: unknown): string | undefined {
  try {
    // undefined for a value with no JSON form at all, such as undefined or a function.
    const text: unknown = JSON.stringify(payload);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The start of a response body for an error message: bounded, with no control characters. */
function excerptOf(body: string): string {
  const clean = body
    .slice(0, EXCERPT_LENGTH * 2)
    // eslint-disable-next-line no-control-regex -- removing them is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .trim();
  return clean.length > EXCERPT_LENGTH ? `${clean.slice(0, EXCERPT_LENGTH)}…` : clean;
}

function resultOf(
  response: WebhookResponseStream,
  body: string,
  truncated: boolean,
  now: Date,
): WebhookCallResult {
  const status = response.statusCode ?? 0;
  if (status >= 200 && status < 300) return { ok: true, status, body, truncated };
  // node:https never follows a redirect, and this doesn't either: the new address would be
  // unchecked, and a redirect is the classic way round an address guard.
  if (status >= 300 && status < 400)
    return {
      ok: false,
      code: 'redirect',
      retryable: false,
      message: `The webhook answered ${String(status)}, a redirect, which is not followed.`,
      status,
    };
  const excerpt = excerptOf(body);
  const header = response.headers['retry-after'];
  const retryAfterMs =
    (status === 429 || status === 503) && typeof header === 'string'
      ? parseRetryAfter(header, now)
      : undefined;
  return {
    ok: false,
    code: 'http_error',
    retryable: RETRYABLE_STATUSES.has(status) || status >= 500,
    message:
      excerpt === ''
        ? `The webhook answered ${String(status)}.`
        : `The webhook answered ${String(status)}: ${excerpt}`,
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

// What node:http accepts in a field value (its validateHeaderValue): no line breaks, which
// would end the header and start another, and nothing outside Latin-1.
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,100}$/;

/**
 * The step's headers as node:https takes them, or why they can't be sent. Checked again
 * here though the document was: a merge field's value is known only now. The message
 * names the header, never its value.
 */
function ownHeaders(
  headers: readonly WebhookHeaderValue[],
): { ok: true; headers: Record<string, string> } | { ok: false; message: string } {
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  for (const { name, value } of headers) {
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name) || !isAllowedWebhookHeader(name) || seen.has(lower))
      return { ok: false, message: `The header ${name.slice(0, 100)} can't be sent.` };
    if (!HEADER_VALUE.test(value))
      return {
        ok: false,
        message: `The header ${name}'s value holds a line break or a character a header can't carry.`,
      };
    seen.add(lower);
    result[name] = value;
  }
  return { ok: true, headers: result };
}

const errorCode = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown';

/** Sends the request and reads the response up to the cap. Settles once, whatever happens. */
function exchange(
  options: RequestOptions,
  body: string,
  settings: {
    readonly requester: WebhookRequester;
    readonly maxBytes: number;
    readonly now: Date;
    readonly cancelled: AbortSignal;
  },
): Promise<WebhookCallResult> {
  return new Promise((resolve) => {
    // The message names the error's code only: its text can carry addresses and more.
    const unreachable = (error: unknown): void => {
      resolve(failure('network_error', `The webhook could not be reached (${errorCode(error)}).`));
    };
    let request: WebhookRequestStream;
    try {
      request = settings.requester(options);
    } catch (error) {
      unreachable(error);
      return;
    }
    // The deadline, or the end of the call: either way the socket must not linger.
    settings.cancelled.addEventListener('abort', () => request.destroy(), { once: true });
    request.on('error', unreachable);
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (truncated: boolean): void => {
        resolve(
          resultOf(response, Buffer.concat(chunks).toString('utf8'), truncated, settings.now),
        );
      };
      response.on('error', unreachable);
      response.on('end', () => {
        finish(false);
      });
      response.on('data', (chunk) => {
        const room = settings.maxBytes - size;
        if (chunk.length <= room) {
          chunks.push(chunk);
          size += chunk.length;
          return;
        }
        // Past the cap: keep what fits and hang up, rather than read whatever is sent.
        chunks.push(chunk.subarray(0, room));
        size = settings.maxBytes;
        response.destroy();
        finish(true);
      });
    });
    request.end(body);
  });
}

/**
 * Makes one webhook call: checks the URL and the host's addresses, then sends the payload as
 * JSON, signed, to the address it checked. Expected failures come back as a result with a
 * code; it throws only for a mistake in the calling code (no secret, a timeout out of range).
 */
export async function callWebhook(
  config: WebhookCallConfig,
  payload: unknown,
  options: WebhookCallOptions,
): Promise<WebhookCallResult> {
  if (options.secret === '') throw new RangeError('A webhook needs a signing secret.');
  // Our own ids only: nothing that could end the header or start another.
  if (options.deliveryId !== undefined && !/^[!-~]{1,200}$/.test(options.deliveryId))
    throw new RangeError('A delivery id is 1 to 200 visible ASCII characters.');
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)
    throw new RangeError(
      `A webhook timeout must be between 1 and ${String(MAX_TIMEOUT_MS)} milliseconds.`,
    );
  const target = parseWebhookUrl(config.url, options.allowedPorts);
  if (!target.ok) return failure('invalid_url', target.message);
  const body = jsonOf(payload);
  if (body === undefined) return failure('invalid_payload', "The webhook's body is not JSON.");
  const own = ownHeaders(options.headers ?? []);
  if (!own.ok) return failure('invalid_header', own.message);

  const now = options.now?.() ?? new Date();
  const timestamp = Math.floor(now.getTime() / 1000);
  const cancel = new AbortController();
  const attempt = async (): Promise<WebhookCallResult> => {
    const resolved = await resolvePublicAddress(target.url.hostname, options.lookup);
    if (!resolved.ok)
      return failure(
        resolved.code === 'dns_error' ? 'network_error' : 'blocked_address',
        resolved.message,
      );
    // DNS can answer after the deadline; nothing may be sent by then.
    if (cancel.signal.aborted) return failure('timeout', 'The webhook call was abandoned.');
    return exchange(
      {
        method: config.method,
        host: target.url.hostname.replace(/^\[|\]$/g, ''),
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        // The step's own first, so none of the engine's can be replaced.
        headers: {
          ...own.headers,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'User-Agent': 'CRM-Webhook/1',
          ...(options.deliveryId === undefined
            ? {}
            : { [WEBHOOK_DELIVERY_HEADER]: options.deliveryId }),
          [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
          [WEBHOOK_SIGNATURE_HEADER]: `${WEBHOOK_SIGNATURE_SCHEME}=${signWebhook(options.secret, timestamp, body)}`,
        },
        // A fresh connection every time: a pooled socket would skip the lookup below.
        agent: false,
        lookup: pinnedLookup(resolved.address, resolved.family),
      },
      body,
      {
        requester: options.requester ?? ((request) => httpsRequest(request)),
        maxBytes: options.maxResponseBytes ?? WEBHOOK_MAX_RESPONSE_BYTES,
        now,
        cancelled: cancel.signal,
      },
    );
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<WebhookCallResult>((resolve) => {
    timer = setTimeout(() => {
      resolve(
        failure('timeout', `The webhook did not answer within ${String(timeoutMs)} milliseconds.`),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([attempt(), deadline]);
  } finally {
    clearTimeout(timer);
    cancel.abort();
  }
}
