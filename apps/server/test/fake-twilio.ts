// A local HTTP stand-in for Twilio's REST API, for tests of the real Twilio adapter and
// transport over a real socket. It never talks to Twilio, and nothing here is a Twilio
// account: SIDs and tokens are made up by the test that starts it.
//
// It answers the three requests the SMS module may make and no others, with the recorded
// fixtures of packages/modules/messaging/src/fixtures/twilio (built from Twilio's OpenAPI
// file, twilio-oai spec/json/twilio_api_v2010.json; each fixture names its source):
//
//   GET  /2010-04-01/Accounts/{Sid}.json                              FetchAccount, 200
//   GET  /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json  ListIncomingPhoneNumber, 200
//   POST /2010-04-01/Accounts/{AccountSid}/Messages.json              CreateMessage, 201
//
// HTTP Basic authentication, form-encoded request bodies and the error body are as the
// same file and https://www.twilio.com/docs/usage/twilios-response#exceptions give them.
// Any other request is answered 404 and kept in `unexpected`, for a test to assert on.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const FIXTURES = new URL(
  '../../../packages/modules/messaging/src/fixtures/twilio/',
  import.meta.url,
);
const ACCOUNT_PATH = /^\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\.json$/;
const NUMBERS_PATH = /^\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\/IncomingPhoneNumbers\.json$/;
const MESSAGES_PATH = /^\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\/Messages\.json$/;
const CONTROL = '/__fake';
const MAX_BODY_BYTES = 256 * 1024;

type Json = Record<string, unknown>;

async function fixture(name: string): Promise<Json> {
  const data: unknown = JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8'));
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new Error(`The Twilio fixture ${name} is not an object.`);
  return Object.fromEntries(Object.entries(data));
}

/** A made-up account, with one number it owns. */
export interface FakeTwilioAccount {
  readonly accountSid: string;
  readonly authToken: string;
  readonly numberSid: string;
  /** E.164. */
  readonly number: string;
}

/** A message the fake "created": what the adapter posted, and the SID it was answered. */
export interface FakeTwilioMessage {
  readonly accountSid: string;
  /** Null when the scripted answer created nothing. */
  readonly sid: string | null;
  readonly contentType: string;
  readonly authorization: string;
  /** The form exactly as posted: every parameter, in order. */
  readonly form: readonly (readonly [string, string])[];
  /** The HTTP status this request was answered with. */
  readonly answered: number;
}

/** What the next CreateMessage request is answered with instead of 201. */
export type FakeCreateAnswer =
  | { readonly kind: 'error'; readonly status: number; readonly code: number }
  /** A status with a body nobody can read: Twilio may or may not have created it. */
  | { readonly kind: 'unreadable'; readonly status: number };

export interface FakeTwilioState {
  readonly reads: readonly { readonly method: string; readonly path: string }[];
  readonly messages: readonly FakeTwilioMessage[];
  readonly unexpected: readonly { readonly method: string; readonly path: string }[];
}

export interface FakeTwilio {
  /** Where it listens, such as http://127.0.0.1:49152. */
  readonly origin: string;
  /** Adds an account, so that its credentials are accepted. */
  addAccount(account?: Partial<FakeTwilioAccount>): FakeTwilioAccount;
  /** Every request so far. */
  state(): FakeTwilioState;
  /** Answers the next CreateMessage differently, once. */
  answerNextCreate(answer: FakeCreateAnswer): void;
  stop(): Promise<void>;
}

/** A new made-up account. The number is one of Twilio's documentation examples by default. */
export function newFakeAccount(patch: Partial<FakeTwilioAccount> = {}): FakeTwilioAccount {
  return {
    accountSid: `AC${randomBytes(16).toString('hex')}`,
    authToken: randomBytes(16).toString('hex'),
    numberSid: `PN${randomBytes(16).toString('hex')}`,
    number: '+15017122661',
    ...patch,
  };
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

async function bodyOf(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) return undefined;
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

// Twilio's error body: { code, message, more_info, status }.
const errorBody = (status: number, code: number): Json => ({
  code,
  message: 'A fixture error.',
  more_info: `https://www.twilio.com/docs/errors/${String(code)}`,
  status,
});

function parseAnswer(value: unknown): FakeCreateAnswer | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const entries = new Map(Object.entries(value));
  const kind: unknown = entries.get('kind');
  const status: unknown = entries.get('status');
  const code: unknown = entries.get('code');
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  if (kind === 'unreadable') return { kind, status };
  if (kind === 'error' && typeof code === 'number') return { kind, status, code };
  return undefined;
}

/**
 * Starts the stand-in on a free loopback port. A test in the same process calls its
 * methods; a test in another process (the browser suite) uses the same three through
 * HTTP: GET /__fake/state, POST /__fake/accounts and POST /__fake/next-create.
 */
export async function startFakeTwilio(): Promise<FakeTwilio> {
  const accountFixture = await fixture('account.json');
  const numbersFixture = await fixture('incoming-phone-numbers-page-1.json');
  const messageFixture = await fixture('message-created.json');
  const listed = numbersFixture['incoming_phone_numbers'];
  const first: unknown = Array.isArray(listed) ? listed[0] : undefined;
  if (first === null || typeof first !== 'object')
    throw new Error('The numbers fixture has no number.');
  const numberFixture = Object.fromEntries(Object.entries(first));

  const accounts = new Map<string, FakeTwilioAccount>();
  const reads: { method: string; path: string }[] = [];
  const messages: FakeTwilioMessage[] = [];
  const unexpected: { method: string; path: string }[] = [];
  const scripted: FakeCreateAnswer[] = [];

  const addAccount = (patch: Partial<FakeTwilioAccount> = {}): FakeTwilioAccount => {
    const account = newFakeAccount(patch);
    accounts.set(account.accountSid, account);
    return account;
  };
  const state = (): FakeTwilioState => ({
    reads: [...reads],
    messages: [...messages],
    unexpected: [...unexpected],
  });

  /** The account a request is for, when its Basic credentials are that account's own. */
  const authenticated = (request: IncomingMessage, sid: string): FakeTwilioAccount | undefined => {
    const account = accounts.get(sid);
    const header = request.headers.authorization ?? '';
    if (account === undefined || !header.startsWith('Basic ')) return undefined;
    const given = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    return sameText(given, `${account.accountSid}:${account.authToken}`) ? account : undefined;
  };

  async function control(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    if (request.method === 'GET' && path === `${CONTROL}/state`) {
      send(response, 200, state());
      return;
    }
    const text = request.method === 'POST' ? await bodyOf(request) : undefined;
    const parsed: unknown = text === undefined || text === '' ? {} : JSON.parse(text);
    if (request.method === 'POST' && path === `${CONTROL}/accounts`) {
      send(response, 201, addAccount());
      return;
    }
    const answer = parseAnswer(parsed);
    if (request.method === 'POST' && path === `${CONTROL}/next-create` && answer !== undefined) {
      scripted.push(answer);
      send(response, 204, {});
      return;
    }
    send(response, 404, {});
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? '';
    const url = new URL(request.url ?? '/', 'http://fake.invalid');
    const path = url.pathname;
    if (path.startsWith(`${CONTROL}/`)) {
      await control(request, response, path);
      return;
    }
    const accountSid =
      (method === 'GET' ? (ACCOUNT_PATH.exec(path) ?? NUMBERS_PATH.exec(path)) : null)?.[1] ??
      (method === 'POST' ? MESSAGES_PATH.exec(path)?.[1] : undefined);
    if (accountSid === undefined) {
      unexpected.push({ method, path });
      // Twilio's documented 404 has a status and a message, and no code.
      send(response, 404, { status: 404, message: 'The requested resource was not found' });
      return;
    }
    const account = authenticated(request, accountSid);
    if (account === undefined) {
      send(response, 401, errorBody(401, 20003));
      return;
    }
    if (method === 'GET') {
      reads.push({ method, path: path + url.search });
      if (ACCOUNT_PATH.test(path)) {
        send(response, 200, {
          ...accountFixture,
          sid: account.accountSid,
          owner_account_sid: account.accountSid,
          uri: path,
        });
        return;
      }
      send(response, 200, {
        ...numbersFixture,
        incoming_phone_numbers: [
          {
            ...numberFixture,
            sid: account.numberSid,
            account_sid: account.accountSid,
            phone_number: account.number,
            capabilities: { voice: false, sms: true, mms: false, fax: false },
          },
        ],
        next_page_uri: null,
      });
      return;
    }
    const text = await bodyOf(request);
    if (text === undefined) {
      // The stand-in's own bound, not an answer of Twilio's.
      response.writeHead(413).end();
      return;
    }
    const form = [...new URLSearchParams(text).entries()];
    const answer = scripted.shift();
    const record = (sid: string | null, answered: number): void => {
      messages.push({
        accountSid: account.accountSid,
        sid,
        contentType: request.headers['content-type'] ?? '',
        authorization: request.headers.authorization ?? '',
        form,
        answered,
      });
    };
    if (answer?.kind === 'error') {
      record(null, answer.status);
      send(response, answer.status, errorBody(answer.status, answer.code));
      return;
    }
    if (answer?.kind === 'unreadable') {
      record(null, answer.status);
      response.writeHead(answer.status, { 'content-type': 'text/html' });
      response.end('<html>upstream</html>');
      return;
    }
    const values = new Map(form);
    const sid = `SM${randomBytes(16).toString('hex')}`;
    record(sid, 201);
    send(response, 201, {
      ...messageFixture,
      sid,
      account_sid: account.accountSid,
      to: values.get('To') ?? null,
      from: values.get('From') ?? null,
      body: values.get('Body') ?? null,
      uri: `/2010-04-01/Accounts/${account.accountSid}/Messages/${sid}.json`,
    });
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('The Twilio stand-in has no port.');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    addAccount,
    state,
    answerNextCreate: (answer) => {
      scripted.push(answer);
    },
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((failure) => {
          if (failure === undefined) resolve();
          else reject(failure);
        });
      }),
  };
}

/**
 * A fetch for createTwilioTransport that sends each request to the stand-in instead. The
 * transport has already checked the request against its allowlist and built the URL on
 * Twilio's fixed host; only the origin is replaced here, never by product configuration.
 */
export function fetchFromFakeTwilio(origin: string): typeof fetch {
  return (input, init) => {
    const asked = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (asked.origin !== 'https://api.twilio.com')
      return Promise.reject(new Error('Only requests for Twilio are sent to the stand-in.'));
    return fetch(new URL(asked.pathname + asked.search, origin), init);
  };
}

/**
 * Twilio's webhook signature, as https://www.twilio.com/docs/usage/security#validating-requests
 * gives it: the full URL, then each POST parameter's name and value in name order, signed
 * with HMAC-SHA1 under the Auth Token, base64. The module's own check is a port of the
 * SDK's and is compared with the SDK in its tests; this is the sender's side.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  params: Readonly<Record<string, string>>,
): string {
  const sorted = Object.keys(params).sort();
  return createHmac('sha1', authToken)
    .update(url + sorted.map((name) => name + (params[name] ?? '')).join(''), 'utf8')
    .digest('base64');
}

/**
 * Posts a webhook as Twilio would: form-encoded and signed for `url`, the public address
 * Twilio was given. It is delivered to `deliverTo`, the address the server listens on,
 * which a test reaches directly where Twilio would go through the public one.
 */
export async function postTwilioWebhook(options: {
  readonly url: string;
  readonly deliverTo: string;
  readonly authToken: string;
  readonly params: Readonly<Record<string, string>>;
}): Promise<{ readonly status: number; readonly body: string }> {
  const target = new URL(options.url);
  const response = await fetch(new URL(target.pathname + target.search, options.deliverTo), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': twilioSignature(options.authToken, options.url, options.params),
    },
    body: new URLSearchParams(options.params).toString(),
  });
  return { status: response.status, body: await response.text() };
}
