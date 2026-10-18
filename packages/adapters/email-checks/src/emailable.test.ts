import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { emailableProvider } from './emailable.js';

// Responses recorded from Emailable's API reference (https://emailable.com/docs/api/emails/,
// account/, rate-limits/, status-codes/), served by a local HTTP server.
const DOCUMENTED_VERIFY = {
  accept_all: null,
  birth_year: null,
  did_you_mean: null,
  disposable: false,
  domain: 'gmail.com',
  duration: 0.493,
  email: 'john.smith@gmail.com',
  first_name: 'John',
  free: true,
  full_name: 'John Smith',
  gender: 'male',
  last_name: 'Smith',
  mailbox_full: false,
  mx_record: 'aspmx.l.google.com',
  no_reply: false,
  reason: 'accepted_email',
  role: false,
  score: 100,
  smtp_provider: 'google',
  state: 'deliverable',
  tag: null,
  user: 'john.smith',
};
const DOCUMENTED_249 = {
  message: 'Your request is taking longer than normal. Please send your request again.',
};
const DOCUMENTED_ACCOUNT = { owner_email: 'john@smith.com', available_credits: 1337 };

/** The documented single-verify response with other documented state, reason and flags. */
function verifyBody(changes: Readonly<Record<string, unknown>>) {
  return { ...DOCUMENTED_VERIFY, free: false, ...changes };
}

interface Seen {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
}

type Reply = (response: ServerResponse) => void;

const json =
  (status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): Reply =>
  (response) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

let server: Server;
let baseUrl: string;
let replies: Reply[] = [];
let seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    seen.push({
      path: url.pathname,
      query: url.searchParams,
      authorization: request.headers.authorization,
    });
    const reply = replies.shift();
    if (reply === undefined) json(500, { message: 'no reply queued' })(response);
    else reply(response);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});

afterEach(() => {
  replies = [];
  seen = [];
});

const LIVE_KEY = 'live_fake_fake_fake';
const provider = (
  extra: { apiKey?: string; slowRetries?: number; requestTimeoutMs?: number } = {},
) => emailableProvider({ apiKey: LIVE_KEY, baseUrl, ...extra });

describe('emailableProvider: verify', () => {
  it('asks GET /v1/verify with the key in a Bearer header, never in the URL', async () => {
    replies.push(json(200, DOCUMENTED_VERIFY));
    const outcome = await provider().verify('john.smith@gmail.com');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/v1/verify');
    expect(seen[0]?.authorization).toBe(`Bearer ${LIVE_KEY}`);
    expect(Object.fromEntries(seen[0]?.query ?? [])).toEqual({
      email: 'john.smith@gmail.com',
      timeout: '10',
    });
    expect(outcome).toEqual({
      kind: 'result',
      status: 'valid',
      reasons: ['free_provider'],
      raw: { state: 'deliverable', reason: 'accepted_email' },
      charged: true,
    });
  });

  it('keeps none of the names or other details Emailable infers', async () => {
    replies.push(json(200, DOCUMENTED_VERIFY));
    const text = JSON.stringify(await provider().verify('john.smith@gmail.com'));
    for (const detail of ['John', 'Smith', 'male', 'john.smith', LIVE_KEY])
      expect(text).not.toContain(detail);
  });

  it.each([
    [{ state: 'deliverable', reason: 'accepted_email', role: true }, 'valid', ['role']],
    [{ state: 'deliverable', reason: 'accepted_email', accept_all: true }, 'risky', ['catch_all']],
    [{ state: 'deliverable', reason: 'accepted_email', disposable: true }, 'risky', ['disposable']],
    [
      { state: 'deliverable', reason: 'accepted_email', mailbox_full: true },
      'risky',
      ['mailbox_full'],
    ],
    [{ state: 'undeliverable', reason: 'invalid_email' }, 'invalid', ['bad_syntax']],
    [{ state: 'undeliverable', reason: 'invalid_domain' }, 'invalid', ['domain_not_found']],
    [{ state: 'undeliverable', reason: 'rejected_email' }, 'invalid', ['mailbox_not_found']],
    [{ state: 'undeliverable', reason: 'invalid_smtp' }, 'invalid', ['smtp_rejected']],
    [{ state: 'undeliverable', reason: 'some_new_reason' }, 'invalid', []],
    [{ state: 'risky', reason: 'low_quality', role: true }, 'risky', ['low_quality', 'role']],
    [{ state: 'risky', reason: 'low_deliverability' }, 'risky', ['low_deliverability']],
    [{ state: 'risky', reason: null, free: true }, 'risky', ['free_provider']],
    [{ state: 'unknown', reason: 'no_connect' }, 'unknown', ['mail_server_unavailable']],
    [{ state: 'unknown', reason: 'timeout' }, 'unknown', ['mail_server_unavailable']],
    [{ state: 'unknown', reason: 'unavailable_smtp' }, 'unknown', ['mail_server_unavailable']],
    [{ state: 'unknown', reason: 'unexpected_error' }, 'unknown', ['provider_error']],
  ])('maps %j to %s %j', async (changes, status, reasons) => {
    replies.push(json(200, verifyBody(changes)));
    const outcome = await provider().verify('someone@example.com');
    expect(outcome).toMatchObject({ kind: 'result', status, reasons });
  });

  it('is charged for every state but unknown, and never with a test key', async () => {
    replies.push(json(200, verifyBody({ state: 'unknown', reason: 'timeout' })));
    await expect(provider().verify('a@example.com')).resolves.toMatchObject({ charged: false });
    replies.push(json(200, verifyBody({ state: 'undeliverable', reason: 'rejected_email' })));
    await expect(provider().verify('a@example.com')).resolves.toMatchObject({ charged: true });
    replies.push(json(200, verifyBody({})));
    await expect(provider({ apiKey: 'test_abc' }).verify('a@example.com')).resolves.toMatchObject({
      charged: false,
    });
  });

  it('asks again after a 249 and returns the answer when it comes', async () => {
    replies.push(json(249, DOCUMENTED_249), json(200, DOCUMENTED_VERIFY));
    await expect(provider().verify('a@example.com')).resolves.toMatchObject({
      kind: 'result',
      status: 'valid',
    });
    expect(seen).toHaveLength(2);
  });

  it('gives up as slow after its retries, without marking the connection', async () => {
    replies.push(json(249, DOCUMENTED_249), json(249, DOCUMENTED_249), json(249, DOCUMENTED_249));
    await expect(provider().verify('a@example.com')).resolves.toEqual({
      kind: 'failed',
      problem: 'slow',
      connectionFailing: false,
    });
    expect(seen).toHaveLength(3);
  });

  it.each([
    [400, 'bad_request', false],
    [401, 'unauthorized', true],
    [402, 'no_credits', true],
    [403, 'unauthorized', true],
    [404, 'unexpected_status', false],
    [500, 'unavailable', false],
    [503, 'unavailable', false],
    [302, 'unexpected_status', false],
  ])('reads HTTP %i as %s', async (status, problem, connectionFailing) => {
    replies.push(json(status, { message: 'API key is required' }));
    await expect(provider().verify('a@example.com')).resolves.toEqual({
      kind: 'failed',
      problem,
      connectionFailing,
    });
  });

  it('waits until the rate limit window resets after a 429', async () => {
    const reset = String(Math.ceil(Date.now() / 1000) + 3);
    replies.push(json(429, { message: 'Rate Limit Exceeded' }, { 'ratelimit-reset': reset }));
    const outcome = await provider().verify('a@example.com');
    expect(outcome).toMatchObject({
      kind: 'failed',
      problem: 'rate_limited',
      connectionFailing: false,
    });
    const wait = outcome.kind === 'failed' ? (outcome.retryAfterMs ?? 0) : 0;
    expect(wait).toBeGreaterThan(1000);
    expect(wait).toBeLessThanOrEqual(4000);
  });

  it('waits one second after a 429 without a usable reset, and never more than a minute', async () => {
    replies.push(json(429, { message: 'Rate Limit Exceeded' }));
    await expect(provider().verify('a@example.com')).resolves.toMatchObject({ retryAfterMs: 1000 });
    const far = String(Math.ceil(Date.now() / 1000) + 3600);
    replies.push(json(429, { message: 'Rate Limit Exceeded' }, { 'ratelimit-reset': far }));
    await expect(provider().verify('a@example.com')).resolves.toMatchObject({
      retryAfterMs: 60_000,
    });
  });

  it.each([
    ['not JSON', '{"state":'],
    ['no state', { reason: 'accepted_email' }],
    ['a state Emailable does not document for one address', { state: 'duplicate', reason: null }],
    ['not an object', 'null'],
  ])('reads a response with %s as a bad response', async (_, body) => {
    replies.push(json(200, body));
    await expect(provider().verify('a@example.com')).resolves.toEqual({
      kind: 'failed',
      problem: 'bad_response',
      connectionFailing: false,
    });
  });

  it('times out a request that never answers', async () => {
    replies.push(() => undefined);
    await expect(provider({ requestTimeoutMs: 50 }).verify('a@example.com')).resolves.toEqual({
      kind: 'failed',
      problem: 'timeout',
      connectionFailing: false,
    });
  });

  it('stops when the caller cancels', async () => {
    replies.push(() => undefined);
    const controller = new AbortController();
    const outcome = provider().verify('a@example.com', { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 20);
    await expect(outcome).resolves.toMatchObject({ kind: 'failed', problem: 'cancelled' });
  });

  it('reads a refused connection as a network failure, quoting neither address nor key', async () => {
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, '127.0.0.1', done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((done) => closed.close(done));
    const outcome = await emailableProvider({
      apiKey: LIVE_KEY,
      baseUrl: `http://127.0.0.1:${String(port)}/v1/`,
    }).verify('secret.person@example.com');
    expect(outcome).toEqual({ kind: 'failed', problem: 'network', connectionFailing: false });
  });
});

describe('emailableProvider: account', () => {
  it('reads the credits left from GET /v1/account, and nothing about the owner', async () => {
    replies.push(json(200, DOCUMENTED_ACCOUNT));
    await expect(provider().account()).resolves.toEqual({
      kind: 'ok',
      availableCredits: 1337,
      testMode: false,
    });
    expect(seen[0]?.path).toBe('/v1/account');
    expect(seen[0]?.authorization).toBe(`Bearer ${LIVE_KEY}`);
    expect([...(seen[0]?.query.keys() ?? [])]).toEqual([]);
  });

  it('says when the key is a test key', async () => {
    replies.push(json(200, DOCUMENTED_ACCOUNT));
    await expect(provider({ apiKey: 'test_abc' }).account()).resolves.toMatchObject({
      testMode: true,
    });
  });

  it('reports a refused key and a malformed answer', async () => {
    replies.push(json(403, { message: 'API key is invalid' }));
    await expect(provider().account()).resolves.toMatchObject({
      problem: 'unauthorized',
      connectionFailing: true,
    });
    replies.push(json(200, { owner_email: 'john@smith.com' }));
    await expect(provider().account()).resolves.toMatchObject({ problem: 'bad_response' });
  });
});

describe('emailableProvider: options', () => {
  it('needs a key', () => {
    expect(() => emailableProvider({ apiKey: '  ' })).toThrow(TypeError);
  });

  it.each([
    { timeoutSeconds: 1 },
    { timeoutSeconds: 11 },
    { timeoutSeconds: 2.5 },
    { slowRetries: -1 },
    { slowRetries: 11 },
  ])('refuses %j', (bad) => {
    expect(() => emailableProvider({ apiKey: LIVE_KEY, ...bad })).toThrow(RangeError);
  });

  it('passes the chosen Emailable timeout and asks once with no retries', async () => {
    replies.push(json(249, DOCUMENTED_249));
    const outcome = await emailableProvider({
      apiKey: LIVE_KEY,
      baseUrl,
      timeoutSeconds: 2,
      slowRetries: 0,
    }).verify('a@example.com');
    expect(outcome).toMatchObject({ problem: 'slow' });
    expect(seen.map((each) => each.query.get('timeout'))).toEqual(['2']);
  });

  it('is named emailable', () => {
    expect(provider().name).toBe('emailable');
  });
});
