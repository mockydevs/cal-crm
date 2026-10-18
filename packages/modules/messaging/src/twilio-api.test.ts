// The Twilio REST client, against an injected transport. No test opens a socket: the
// fixtures in fixtures/twilio are built from Twilio's OpenAPI schemas, never captured.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  classifyCreateMessage,
  createMessage,
  createMessageForm,
  createTwilioTransport,
  fetchAccount,
  isAllowedTwilioRequest,
  listIncomingPhoneNumbers,
  NUMBER_PAGE_LIMIT,
  TWILIO_ORIGIN,
  type TwilioCredentials,
  type TwilioRequest,
  type TwilioResponse,
  type TwilioTransport,
} from './twilio-api.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/twilio/${name}`, import.meta.url), 'utf8');
const record = (name: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(fixture(name));
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${name} is not an object`);
  return { ...parsed };
};

const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? { ...value } : {};
const listOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.map((each: unknown) => each) : [];

const ACCOUNT = `AC${'0'.repeat(31)}1`;
const AUTH_TOKEN = 'auth-token-secret-value';
const KEY_SECRET = 'api-key-secret-value';
const withToken: TwilioCredentials = { accountSid: ACCOUNT, authToken: AUTH_TOKEN };
const withKey: TwilioCredentials = {
  ...withToken,
  apiKey: { sid: `SK${'a'.repeat(32)}`, secret: KEY_SECRET },
};
const MESSAGE = {
  to: '+15558675310',
  from: '+15017122661',
  body: 'Hello & welcome = 100% + more',
  statusCallback:
    'https://crm.example.test/webhooks/twilio/token/status?m=0198a5d0-0000-7000-8000-000000000001',
};

type Answer = TwilioResponse | Error;
function recording(...answers: Answer[]): { transport: TwilioTransport; sent: TwilioRequest[] } {
  const sent: TwilioRequest[] = [];
  const queue = [...answers];
  return {
    sent,
    transport: (request) => {
      sent.push(request);
      const answer = queue.length > 1 ? queue.shift() : queue[0];
      if (answer === undefined) return Promise.reject(new Error('No answer prepared.'));
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}
const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const noSleep = { sleep: () => Promise.resolve(), retryDelaysMs: [1, 1] };

describe('fixtures', () => {
  const excerpt = record('spec-excerpt.json');
  const keysOf = (schema: string) => {
    const properties = excerpt[schema];
    if (typeof properties !== 'object' || properties === null) throw new Error(schema);
    return Object.keys(properties);
  };
  const own = (value: Record<string, unknown>) =>
    Object.keys(value).filter((key) => key !== '$source' && key !== 'schema');

  it('have exactly the properties of the OpenAPI schema they claim', () => {
    expect(own(record('account.json')).sort()).toEqual(keysOf('api.v2010.account').sort());
    expect(own(record('message-created.json')).sort()).toEqual(
      keysOf('api.v2010.account.message').sort(),
    );
    for (const name of [
      'incoming-phone-numbers-page-0.json',
      'incoming-phone-numbers-page-1.json',
    ]) {
      const page = record(name);
      expect(own(page).sort()).toEqual(keysOf('ListIncomingPhoneNumberResponse').sort());
      const numbers = page['incoming_phone_numbers'];
      if (!Array.isArray(numbers)) throw new Error('numbers');
      for (const number of numbers)
        expect(Object.keys(objectOf(number)).sort()).toEqual(
          keysOf('api.v2010.account.incoming_phone_number').sort(),
        );
    }
  });

  it('say where their shape comes from', () => {
    for (const name of [
      'account.json',
      'message-created.json',
      'incoming-phone-numbers-page-0.json',
      'incoming-phone-numbers-page-1.json',
      'error-21211.json',
      'status-callback.json',
      'inbound-message.json',
    ])
      expect(String(record(name)['$source'])).toMatch(/twilio/i);
  });
});

describe('the requests that can be made at all', () => {
  it('are the three the module needs', () => {
    expect(isAllowedTwilioRequest('GET', `/2010-04-01/Accounts/${ACCOUNT}.json`)).toBe(true);
    expect(
      isAllowedTwilioRequest(
        'GET',
        `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?PageSize=1000&Page=1&PageToken=PAPN1`,
      ),
    ).toBe(true);
    expect(isAllowedTwilioRequest('POST', `/2010-04-01/Accounts/${ACCOUNT}/Messages.json`)).toBe(
      true,
    );
  });

  it.each([
    // Buying, releasing, moving or reconfiguring a number.
    ['POST', `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json`],
    ['POST', `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers/Local.json`],
    ['DELETE', `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers/PN${'0'.repeat(32)}.json`],
    ['POST', `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers/PN${'0'.repeat(32)}.json`],
    ['GET', `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers/PN${'0'.repeat(32)}.json`],
    // Changing or creating accounts.
    ['POST', `/2010-04-01/Accounts/${ACCOUNT}.json`],
    ['POST', '/2010-04-01/Accounts.json'],
    // Reading, deleting or redacting messages.
    ['GET', `/2010-04-01/Accounts/${ACCOUNT}/Messages.json`],
    ['DELETE', `/2010-04-01/Accounts/${ACCOUNT}/Messages/SM${'0'.repeat(32)}.json`],
    // Anywhere else.
    ['GET', `https://evil.example/2010-04-01/Accounts/${ACCOUNT}.json`],
    ['GET', `//evil.example/2010-04-01/Accounts/${ACCOUNT}.json`],
    ['GET', `/2010-04-01/Accounts/${ACCOUNT}.json/../../x`],
    ['GET', `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?x=1#@evil.example`],
    ['GET', `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?x=/../../Messages.json`],
    ['GET', '/2010-04-01/Accounts/ACnot-a-sid.json'],
    ['get', `/2010-04-01/Accounts/${ACCOUNT}.json`],
  ])('never %s %s', (method, path) => {
    expect(isAllowedTwilioRequest(method, path)).toBe(false);
  });

  it('refuses any other request before the transport sees it, without quoting it', async () => {
    const { transport, sent } = recording({ status: 200, body: fixture('account.json') });
    for (const accountSid of [
      'AC/../x',
      `${ACCOUNT}?x`,
      `${ACCOUNT}#`,
      'evil.example',
      `${ACCOUNT}@evil`,
      '',
    ]) {
      const credentials = { accountSid, authToken: AUTH_TOKEN };
      expect(await fetchAccount(transport, credentials)).toEqual({ outcome: 'refused' });
      expect(await listIncomingPhoneNumbers(transport, credentials)).toEqual({
        outcome: 'refused',
      });
      expect(await createMessage(transport, credentials, MESSAGE)).toEqual({
        outcome: 'rejected',
        httpStatus: 0,
        code: null,
      });
    }
    expect(sent).toEqual([]);
  });
});

describe('the real transport', () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = (answer: () => Response): typeof fetch =>
    ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
      return Promise.resolve(answer());
    }) satisfies typeof fetch;

  it('sends to the fixed host only, never follows a redirect, and sets a deadline', async () => {
    calls.length = 0;
    const transport = createTwilioTransport(fetcher(() => new Response('{"ok":true}')));
    const response = await transport({
      method: 'GET',
      path: `/2010-04-01/Accounts/${ACCOUNT}.json`,
      headers: { authorization: 'Basic x' },
    });
    expect(response).toEqual({ status: 200, body: '{"ok":true}' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${TWILIO_ORIGIN}/2010-04-01/Accounts/${ACCOUNT}.json`);
    expect(calls[0]?.init?.redirect).toBe('manual');
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it.each([
    `https://evil.example/2010-04-01/Accounts/${ACCOUNT}.json`,
    `//evil.example/2010-04-01/Accounts/${ACCOUNT}.json`,
    `/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers/Local.json`,
    '/other',
  ])('refuses %s without calling fetch', async (path) => {
    calls.length = 0;
    const transport = createTwilioTransport(fetcher(() => new Response('')));
    const failure = await transport({ method: 'GET', path, headers: {} }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('evil');
    expect(calls).toEqual([]);
  });

  it('hands back a redirect as its status, for the caller to treat as unknown', async () => {
    const transport = createTwilioTransport(
      fetcher(
        () => new Response(null, { status: 307, headers: { location: 'https://evil.example/' } }),
      ),
    );
    const response = await transport({
      method: 'POST',
      path: `/2010-04-01/Accounts/${ACCOUNT}/Messages.json`,
      headers: {},
      body: 'To=1',
    });
    expect(response.status).toBe(307);
    expect(classifyCreateMessage(response, ACCOUNT)).toEqual({
      outcome: 'unknown',
      reason: 'unexpected_status',
    });
  });

  it('stops reading a response that is too large', async () => {
    const transport = createTwilioTransport(
      fetcher(() => new Response('x'.repeat(2000))),
      {
        maxResponseBytes: 1000,
      },
    );
    await expect(
      transport({ method: 'GET', path: `/2010-04-01/Accounts/${ACCOUNT}.json`, headers: {} }),
    ).rejects.toThrow('too large');
  });

  it('gives up at the deadline', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const transport = createTwilioTransport(hanging, { timeoutMs: 20 });
    await expect(
      transport({ method: 'GET', path: `/2010-04-01/Accounts/${ACCOUNT}.json`, headers: {} }),
    ).rejects.toThrow('aborted');
  });
});

describe('fetchAccount', () => {
  it('reads four facts and nothing else, with the Account SID and Auth Token', async () => {
    const { transport, sent } = recording({ status: 200, body: fixture('account.json') });
    const result = await fetchAccount(transport, withKey);
    expect(result).toEqual({
      outcome: 'ok',
      account: { sid: ACCOUNT, status: 'active', type: 'full', subaccount: false },
    });
    expect(sent).toEqual([
      {
        method: 'GET',
        path: `/2010-04-01/Accounts/${ACCOUNT}.json`,
        // Never the API key: a Standard key can't read Accounts, and the token must be proven.
        headers: { accept: 'application/json', authorization: basic(ACCOUNT, AUTH_TOKEN) },
      },
    ]);
    // The response carries the account's auth token; none of it may come back.
    expect(fixture('account.json')).toContain('fixture-auth-token-never-log-me');
    expect(JSON.stringify(result)).not.toContain('fixture-auth-token');
  });

  it('reports a trial account and a subaccount', async () => {
    const body = JSON.stringify({
      ...record('account.json'),
      type: 'Trial',
      status: 'suspended',
      owner_account_sid: `AC${'9'.repeat(32)}`,
    });
    expect(await fetchAccount(recording({ status: 200, body }).transport, withToken)).toEqual({
      outcome: 'ok',
      account: { sid: ACCOUNT, status: 'suspended', type: 'trial', subaccount: true },
    });
  });

  it.each([401, 403, 404])('reports HTTP %i as refused credentials', async (status) => {
    const { transport } = recording({ status, body: '{"code":20003,"status":401}' });
    expect(await fetchAccount(transport, withToken)).toEqual({ outcome: 'refused' });
  });

  it.each([
    ['a server error', { status: 500, body: 'oops' }],
    ['a rate limit', { status: 429, body: '{}' }],
    ['a redirect', { status: 302, body: '' }],
    ['a body that is not JSON', { status: 200, body: '<html>' }],
    ['a body without the fields', { status: 200, body: '{"sid":"AC1"}' }],
    ['a network failure', new Error(`connect failed ${AUTH_TOKEN}`)],
  ])('reports %s as unavailable, quoting nothing', async (_what, answer) => {
    const result = await fetchAccount(recording(answer).transport, withToken);
    expect(result).toEqual({ outcome: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain(AUTH_TOKEN);
  });
});

describe('listIncomingPhoneNumbers', () => {
  const pages = () =>
    recording(
      { status: 200, body: fixture('incoming-phone-numbers-page-0.json') },
      { status: 200, body: fixture('incoming-phone-numbers-page-1.json') },
    );

  it('follows next_page_uri to the end, with the API key when there is one', async () => {
    const { transport, sent } = pages();
    const result = await listIncomingPhoneNumbers(transport, withKey);
    expect(result).toEqual({
      outcome: 'ok',
      truncated: false,
      numbers: [
        {
          sid: `PN${'0'.repeat(31)}1`,
          e164: '+15017122661',
          friendlyName: '(501) 712-2661',
          capabilities: ['sms', 'mms', 'voice'],
        },
        {
          sid: `PN${'0'.repeat(31)}2`,
          e164: '+15558675310',
          friendlyName: 'Voice only',
          capabilities: ['voice'],
        },
        {
          sid: `PN${'0'.repeat(31)}3`,
          e164: '+14155552671',
          friendlyName: 'Second page',
          capabilities: ['sms'],
        },
      ],
    });
    expect(sent.map((each) => `${each.method} ${each.path}`)).toEqual([
      `GET /2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?PageSize=1000`,
      `GET /2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?PageSize=1000&Page=1&PageToken=PAPN${'0'.repeat(31)}2`,
    ]);
    for (const each of sent)
      expect(each.headers['authorization']).toBe(basic(`SK${'a'.repeat(32)}`, KEY_SECRET));
  });

  it.each([
    'https://evil.example/2010-04-01/Accounts/AC00000000000000000000000000000001/IncomingPhoneNumbers.json?Page=1',
    '//evil.example/x',
    '/2010-04-01/Accounts/AC99999999999999999999999999999999/IncomingPhoneNumbers.json?Page=1',
    '/2010-04-01/Accounts/AC00000000000000000000000000000001/Messages.json',
    '/2010-04-01/Accounts/AC00000000000000000000000000000001/IncomingPhoneNumbers/Local.json?Page=1',
    '/2010-04-01/Accounts/AC00000000000000000000000000000001/IncomingPhoneNumbers.json',
  ])('does not follow a next page of %s', async (next) => {
    const first = { ...record('incoming-phone-numbers-page-0.json'), next_page_uri: next };
    const { transport, sent } = recording({ status: 200, body: JSON.stringify(first) });
    expect(await listIncomingPhoneNumbers(transport, withToken)).toEqual({
      outcome: 'unavailable',
    });
    expect(sent).toHaveLength(1);
  });

  it('leaves out a number of another account, without E.164, or without a SID', async () => {
    const page = record('incoming-phone-numbers-page-1.json');
    const [good] = listOf(page['incoming_phone_numbers']);
    const body = JSON.stringify({
      ...page,
      incoming_phone_numbers: [
        { ...objectOf(good), account_sid: `AC${'9'.repeat(32)}` },
        { ...objectOf(good), phone_number: '(415) 555-2671' },
        { ...objectOf(good), sid: null },
        { ...objectOf(good), capabilities: null, friendly_name: null },
        'not a number',
      ],
    });
    expect(
      await listIncomingPhoneNumbers(recording({ status: 200, body }).transport, withToken),
    ).toEqual({
      outcome: 'ok',
      truncated: false,
      numbers: [
        { sid: `PN${'0'.repeat(31)}3`, e164: '+14155552671', friendlyName: '', capabilities: [] },
      ],
    });
  });

  it('stops at the page limit and says the list is incomplete', async () => {
    const endless = record('incoming-phone-numbers-page-0.json');
    const { transport, sent } = recording({ status: 200, body: JSON.stringify(endless) });
    const result = await listIncomingPhoneNumbers(transport, withToken);
    expect(result).toMatchObject({ outcome: 'ok', truncated: true });
    expect(sent).toHaveLength(NUMBER_PAGE_LIMIT);
  });

  it('reports refused credentials and an unusable answer apart', async () => {
    expect(
      await listIncomingPhoneNumbers(recording({ status: 401, body: '{}' }).transport, withToken),
    ).toEqual({ outcome: 'refused' });
    for (const answer of [{ status: 503, body: '' }, { status: 200, body: '[]' }, new Error('x')])
      expect(await listIncomingPhoneNumbers(recording(answer).transport, withToken)).toEqual({
        outcome: 'unavailable',
      });
  });
});

describe('createMessage', () => {
  const created = { status: 201, body: fixture('message-created.json') };

  it('posts exactly To, From, Body and StatusCallback as a form', async () => {
    const { transport, sent } = recording(created);
    const result = await createMessage(transport, withToken, MESSAGE);
    expect(result).toEqual({
      outcome: 'accepted',
      sid: `SM${'0'.repeat(31)}1`,
      status: 'queued',
      segments: 1,
    });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe(`/2010-04-01/Accounts/${ACCOUNT}/Messages.json`);
    expect(request?.headers).toEqual({
      accept: 'application/json',
      authorization: basic(ACCOUNT, AUTH_TOKEN),
      'content-type': 'application/x-www-form-urlencoded',
    });
    const form = new URLSearchParams(request?.body);
    expect([...form.keys()]).toEqual(['To', 'From', 'Body', 'StatusCallback']);
    expect(Object.fromEntries(form)).toEqual({
      To: MESSAGE.to,
      From: MESSAGE.from,
      Body: MESSAGE.body,
      StatusCallback: MESSAGE.statusCallback,
    });
    // Every name is a CreateMessage parameter in the OpenAPI file; MaxPrice is obsolete.
    const operations = objectOf(record('spec-excerpt.json')['operations']);
    const allowed = listOf(objectOf(operations['CreateMessage'])['parameters']);
    expect(allowed.length).toBeGreaterThan(20);
    for (const name of form.keys()) expect(allowed).toContain(name);
    expect(request?.body).not.toContain('MaxPrice');
    expect(createMessageForm(MESSAGE)).toBe(request?.body);
  });

  it('authenticates with the API key when there is one, the Account SID still in the path', async () => {
    const { transport, sent } = recording(created);
    await createMessage(transport, withKey, MESSAGE);
    expect(sent[0]?.headers['authorization']).toBe(basic(`SK${'a'.repeat(32)}`, KEY_SECRET));
    expect(sent[0]?.path).toBe(`/2010-04-01/Accounts/${ACCOUNT}/Messages.json`);
  });

  it('accepts any 2xx that names a message of this account', async () => {
    const { transport } = recording({ status: 200, body: created.body });
    expect(await createMessage(transport, withToken, MESSAGE)).toMatchObject({
      outcome: 'accepted',
    });
  });

  it('reads an unknown status or segment count as absent, not as an error', async () => {
    const body = JSON.stringify({
      ...record('message-created.json'),
      status: 'something_new',
      num_segments: null,
    });
    expect(
      await createMessage(recording({ status: 201, body }).transport, withToken, MESSAGE),
    ).toEqual({ outcome: 'accepted', sid: `SM${'0'.repeat(31)}1`, status: null, segments: null });
  });

  it.each([
    ['a body that is not JSON', '<html>Created</html>'],
    ['a body without a SID', JSON.stringify({ ...record('message-created.json'), sid: null })],
    ['a malformed SID', JSON.stringify({ ...record('message-created.json'), sid: 'SM123' })],
    [
      "another account's message",
      JSON.stringify({ ...record('message-created.json'), account_sid: `AC${'9'.repeat(32)}` }),
    ],
    ['an empty body', ''],
  ])('treats a success with %s as unknown, and sends once', async (_what, body) => {
    const { transport, sent } = recording({ status: 201, body });
    expect(await createMessage(transport, withToken, MESSAGE, noSleep)).toEqual({
      outcome: 'unknown',
      reason: 'unreadable',
    });
    expect(sent).toHaveLength(1);
  });

  it.each([500, 502, 503, 504])('treats HTTP %i as unknown, and sends once', async (status) => {
    const { transport, sent } = recording({ status, body: '{"code":20500}' });
    expect(await createMessage(transport, withToken, MESSAGE, noSleep)).toEqual({
      outcome: 'unknown',
      reason: 'server_error',
    });
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['a timeout', new DOMException('The operation timed out.', 'TimeoutError')],
    ['a reset connection', Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' })],
    ['a refused connection', Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })],
    ['a response too large to read', new Error('The Twilio response was too large to read.')],
  ])('treats %s as unknown, and sends once', async (_what, failure) => {
    const { transport, sent } = recording(failure);
    expect(await createMessage(transport, withToken, MESSAGE, noSleep)).toEqual({
      outcome: 'unknown',
      reason: 'no_response',
    });
    expect(sent).toHaveLength(1);
  });

  it.each([301, 302, 307, 308, 100])(
    'treats HTTP %i as unknown, and sends once',
    async (status) => {
      const { transport, sent } = recording({ status, body: '' });
      expect(await createMessage(transport, withToken, MESSAGE, noSleep)).toEqual({
        outcome: 'unknown',
        reason: 'unexpected_status',
      });
      expect(sent).toHaveLength(1);
    },
  );

  it('reports a refusal with its Twilio error code, and sends once', async () => {
    const { transport, sent } = recording({ status: 400, body: fixture('error-21211.json') });
    expect(await createMessage(transport, withToken, MESSAGE, noSleep)).toEqual({
      outcome: 'rejected',
      httpStatus: 400,
      code: 21211,
    });
    expect(sent).toHaveLength(1);
  });

  it.each([
    [401, '{"code":20003,"status":401}', 20003],
    [403, '<html>Forbidden</html>', null],
    [404, '{"status":404,"message":"not found"}', null],
    [400, '{"code":"21610"}', null],
  ])('reports HTTP %i as rejected', async (status, body, code) => {
    const { transport, sent } = recording({ status, body });
    expect(await createMessage(transport, withToken, MESSAGE, noSleep)).toEqual({
      outcome: 'rejected',
      httpStatus: status,
      code,
    });
    expect(sent).toHaveLength(1);
  });

  it('repeats the identical request after a 429, then accepts', async () => {
    const waits: number[] = [];
    const { transport, sent } = recording({ status: 429, body: '{"code":20429}' }, created);
    const result = await createMessage(transport, withToken, MESSAGE, {
      retryDelaysMs: [5, 7],
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(result).toMatchObject({ outcome: 'accepted' });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(waits).toEqual([5]);
  });

  it('gives up on a 429 after the bounded retries, as not sent', async () => {
    const { transport, sent } = recording({ status: 429, body: '{"code":20429}' });
    expect(await createMessage(transport, withToken, MESSAGE, noSleep)).toEqual({
      outcome: 'rejected',
      httpStatus: 429,
      code: 20429,
    });
    expect(sent).toHaveLength(3);
  });

  it('never repeats after a 429 was followed by an ambiguous answer', async () => {
    const { transport, sent } = recording(
      { status: 429, body: '{}' },
      { status: 503, body: '' },
      created,
    );
    expect(await createMessage(transport, withToken, MESSAGE, noSleep)).toEqual({
      outcome: 'unknown',
      reason: 'server_error',
    });
    expect(sent).toHaveLength(2);
  });

  it('refuses a recipient or sender that is not E.164 without sending', async () => {
    const { transport, sent } = recording(created);
    for (const patch of [{ to: '5558675310' }, { to: 'whatsapp:+15558675310' }, { from: 'CRM' }])
      expect(await createMessage(transport, withToken, { ...MESSAGE, ...patch })).toEqual({
        outcome: 'rejected',
        httpStatus: 0,
        code: null,
      });
    expect(sent).toEqual([]);
  });

  it('never puts a secret, the text or the recipient in a result', async () => {
    const answers: Answer[] = [
      created,
      { status: 400, body: fixture('error-21211.json') },
      { status: 500, body: `echo ${AUTH_TOKEN} ${MESSAGE.body}` },
      new Error(`failed with ${basic(ACCOUNT, AUTH_TOKEN)} to ${MESSAGE.to}`),
    ];
    for (const answer of answers) {
      const result = JSON.stringify(
        await createMessage(recording(answer).transport, withKey, MESSAGE, noSleep),
      );
      for (const secret of [AUTH_TOKEN, KEY_SECRET, MESSAGE.body, MESSAGE.to, 'Basic '])
        expect(result).not.toContain(secret);
    }
  });
});
