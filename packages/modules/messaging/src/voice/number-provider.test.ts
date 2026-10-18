// The phone-number provider boundary, against injected transports and fetchers. No test opens
// a socket, buys, releases or verifies anything: fixtures/numbers is built from Twilio's
// OpenAPI schemas, never captured from an account.
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { TwilioCredentials, TwilioResponse } from '../twilio-api.js';
import {
  CALLER_ID_PAGE_LIMIT,
  configureNumberVoice,
  createNumberTransport,
  fetchNumberPricing,
  fetchOwnedNumber,
  findOwnedNumber,
  isAllowedNumberRequest,
  listVerifiedCallerIds,
  NUMBER_API_ORIGIN,
  NUMBER_PRICING_ORIGIN,
  type NumberRequest,
  type NumberTransport,
  purchaseNumber,
  releaseNumber,
  searchAvailableNumbers,
  startCallerIdVerification,
} from './number-provider.js';

const fixture = (name: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL(`./fixtures/numbers/${name}`, import.meta.url), 'utf8'),
  );
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${name} is not an object`);
  return { ...parsed };
};
const firstOf = (value: unknown): Record<string, unknown> => {
  const first: unknown = Array.isArray(value) ? value[0] : undefined;
  return typeof first === 'object' && first !== null ? { ...first } : {};
};

const ACCOUNT = `AC${'0'.repeat(31)}1`;
const OTHER_ACCOUNT = `AC${'9'.repeat(32)}`;
const AUTH_TOKEN = 'synthetic-auth-token';
const KEY_SID = `SK${'a'.repeat(32)}`;
const KEY_SECRET = 'synthetic-key-secret';
const withToken: TwilioCredentials = { accountSid: ACCOUNT, authToken: AUTH_TOKEN };
const withKey: TwilioCredentials = { ...withToken, apiKey: { sid: KEY_SID, secret: KEY_SECRET } };
const BASE = `/2010-04-01/Accounts/${ACCOUNT}`;
const NUMBER_SID = 'PN00000000000000000000000000000101';
const basic = (user: string, secret: string) =>
  `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
const refusedInput = { outcome: 'rejected', httpStatus: 0, code: null };

type Answer = TwilioResponse | Error;
function recording(...answers: Answer[]): { transport: NumberTransport; sent: NumberRequest[] } {
  const sent: NumberRequest[] = [];
  const queue = [...answers];
  return {
    sent,
    transport: (request) => {
      sent.push(request);
      const answer = queue.length > 1 ? queue.shift() : queue[0];
      if (answer === undefined || answer instanceof Error)
        return Promise.reject(answer ?? new Error('no answer'));
      return Promise.resolve(answer);
    },
  };
}
const ok = (body: unknown, status = 200): TwilioResponse => ({
  status,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const twilioError = (status: number, code: number): TwilioResponse =>
  ok(
    { code, message: 'Synthetic error', more_info: 'https://www.twilio.com/docs/errors', status },
    status,
  );

describe('number request boundary', () => {
  const instance = `${BASE}/IncomingPhoneNumbers/${NUMBER_SID}.json`;
  it.each([
    ['api', 'GET', `${BASE}/AvailablePhoneNumbers/US/Local.json?AreaCode=415&PageSize=20`],
    ['api', 'GET', `${BASE}/AvailablePhoneNumbers/GB/Mobile.json?PageSize=20`],
    ['api', 'GET', `${BASE}/AvailablePhoneNumbers/US/TollFree.json?Contains=*%2400`],
    ['pricing', 'GET', '/v1/PhoneNumbers/Countries/US'],
    ['api', 'POST', `${BASE}/IncomingPhoneNumbers.json`],
    ['api', 'GET', `${BASE}/IncomingPhoneNumbers.json?PhoneNumber=%2B14155550101&PageSize=50`],
    ['api', 'GET', instance],
    ['api', 'DELETE', instance],
    ['api', 'POST', instance],
    ['api', 'GET', `${BASE}/OutgoingCallerIds.json?PageSize=1000`],
    ['api', 'POST', `${BASE}/OutgoingCallerIds.json`],
  ] as const)('allows %s %s %s', (host, method, path) => {
    expect(isAllowedNumberRequest(host, method, path)).toBe(true);
  });

  it.each([
    // DELETE only ever on one owned number.
    ['api', 'DELETE', `${BASE}/IncomingPhoneNumbers.json`],
    ['api', 'DELETE', `${BASE}/OutgoingCallerIds/${NUMBER_SID}.json`],
    ['api', 'DELETE', `/2010-04-01/Accounts/${ACCOUNT}.json`],
    // Reconfiguring a caller ID is not part of this boundary.
    ['api', 'POST', `${BASE}/OutgoingCallerIds/${NUMBER_SID}.json`],
    ['api', 'POST', `${BASE}/IncomingPhoneNumbers.json?AreaCode=415`],
    ['api', 'GET', `${BASE}/AvailablePhoneNumbers/US/National.json`],
    ['api', 'GET', `${BASE}/AvailablePhoneNumbers/us/Local.json`],
    ['api', 'GET', `${BASE}/AvailablePhoneNumbers/US/Local.json?x=<script>`],
    ['api', 'GET', `${BASE}/IncomingPhoneNumbers/${NUMBER_SID}.json/../../Calls.json`],
    ['api', 'GET', `${BASE}/Messages.json`],
    ['api', 'GET', 'https://evil.example/2010-04-01/Accounts'],
    ['api', 'GET', `//evil.example${BASE}/OutgoingCallerIds.json`],
    ['api', 'PUT', `${BASE}/IncomingPhoneNumbers.json`],
    // The two hosts never cross.
    ['api', 'GET', '/v1/PhoneNumbers/Countries/US'],
    ['pricing', 'GET', `${BASE}/IncomingPhoneNumbers/${NUMBER_SID}.json`],
    ['pricing', 'GET', '/v1/PhoneNumbers/Countries/US?x=1'],
    ['pricing', 'GET', '/v1/Voice/Countries/US'],
    ['other', 'GET', '/v1/PhoneNumbers/Countries/US'],
  ] as const)('refuses %s %s %s', (host, method, path) => {
    expect(isAllowedNumberRequest(host, method, path)).toBe(false);
  });
});

describe('createNumberTransport', () => {
  const pricingRequest: NumberRequest = {
    host: 'pricing',
    method: 'GET',
    path: '/v1/PhoneNumbers/Countries/US',
    headers: { accept: 'application/json' },
  };

  it('sends to the fixed host with no redirects, a timeout and the request as given', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"a":1}')));
    const answer = await createNumberTransport({ fetcher })(pricingRequest);
    expect(answer).toEqual({ status: 200, body: '{"a":1}' });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(
      `${NUMBER_PRICING_ORIGIN}/v1/PhoneNumbers/Countries/US`,
    );
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ accept: 'application/json' });
    expect(init).not.toHaveProperty('body');
  });

  it('passes a body and uses the API host for api requests', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
    const answer = await createNumberTransport({ fetcher })({
      host: 'api',
      method: 'POST',
      path: `${BASE}/IncomingPhoneNumbers.json`,
      headers: {},
      body: 'PhoneNumber=%2B14155550101',
    });
    expect(answer).toEqual({ status: 204, body: '' });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : url).toBe(
      `${NUMBER_API_ORIGIN}${BASE}/IncomingPhoneNumbers.json`,
    );
    expect(init?.body).toBe('PhoneNumber=%2B14155550101');
  });

  it('refuses a request outside the allowlist before anything is fetched', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const transport = createNumberTransport({ fetcher });
    await expect(
      transport({
        host: 'api',
        method: 'DELETE',
        path: `${BASE}/IncomingPhoneNumbers.json`,
        headers: {},
      }),
    ).rejects.toThrow('not allowed');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops reading a response that is too large', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('x'.repeat(64))));
    await expect(
      createNumberTransport({ fetcher, maxResponseBytes: 16 })(pricingRequest),
    ).rejects.toThrow('too large');
  });

  it('refuses a body that is not bytes', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue('text, not bytes');
        controller.close();
      },
    });
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(stream)));
    await expect(createNumberTransport({ fetcher })(pricingRequest)).rejects.toThrow('not bytes');
  });

  it('gives up when the exchange runs past its timeout', async () => {
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    await expect(createNumberTransport({ fetcher, timeoutMs: 5 })(pricingRequest)).rejects.toThrow(
      'aborted',
    );
  });

  it('never puts a credential or a refused path into its errors', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error('network down')));
    const refused: unknown = await createNumberTransport({ fetcher })({
      host: 'api',
      method: 'GET',
      path: `/x?token=${AUTH_TOKEN}`,
      headers: { authorization: basic(ACCOUNT, AUTH_TOKEN) },
    }).catch((error: unknown) => error);
    expect(String(refused)).not.toContain(AUTH_TOKEN);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('searchAvailableNumbers', () => {
  it('reads one page of local numbers with exactly the requested filters', async () => {
    const { transport, sent } = recording(ok(fixture('available-local.json')));
    const result = await searchAvailableNumbers(transport, withKey, {
      country: 'US',
      kind: 'local',
      areaCode: 415,
      contains: '555%',
      inRegion: 'CA',
      inPostalCode: '94103',
      inLocality: 'San Francisco',
      capabilities: { voice: true, sms: true },
      excludeAddressRequired: true,
      pageSize: 20,
    });
    expect(sent).toHaveLength(1);
    const request = sent[0];
    expect(request?.host).toBe('api');
    expect(request?.method).toBe('GET');
    expect(request?.path).toBe(
      `${BASE}/AvailablePhoneNumbers/US/Local.json?AreaCode=415&Contains=555%25&InRegion=CA&InPostalCode=94103&InLocality=San+Francisco&VoiceEnabled=true&SmsEnabled=true&ExcludeAllAddressRequired=true&PageSize=20`,
    );
    expect(request?.headers['authorization']).toBe(basic(KEY_SID, KEY_SECRET));
    expect(request?.body).toBeUndefined();
    expect(result).toEqual({
      outcome: 'ok',
      truncated: false,
      numbers: [
        {
          e164: '+14155550101',
          friendlyName: '(415) 555-0101',
          isoCountry: 'US',
          locality: 'San Francisco',
          region: 'CA',
          postalCode: '94103',
          addressRequirements: 'none',
          beta: false,
          capabilities: ['sms', 'mms', 'voice'],
        },
        {
          e164: '+14155550102',
          friendlyName: '(415) 555-0102',
          isoCountry: 'US',
          locality: null,
          region: null,
          postalCode: null,
          addressRequirements: 'local',
          beta: true,
          capabilities: ['voice'],
        },
      ],
    });
  });

  it('reports a toll-free page that has more results, and searches mobile on its own path', async () => {
    const tollFree = recording(ok(fixture('available-toll-free.json')));
    const result = await searchAvailableNumbers(tollFree.transport, withToken, {
      country: 'US',
      kind: 'toll_free',
    });
    expect(tollFree.sent[0]?.path).toBe(
      `${BASE}/AvailablePhoneNumbers/US/TollFree.json?PageSize=20`,
    );
    expect(tollFree.sent[0]?.headers['authorization']).toBe(basic(ACCOUNT, AUTH_TOKEN));
    expect(result).toMatchObject({ outcome: 'ok', truncated: true });

    const empty = { ...fixture('available-local.json'), available_phone_numbers: [] };
    const mobile = recording(ok(empty));
    expect(
      await searchAvailableNumbers(mobile.transport, withToken, {
        country: 'GB',
        kind: 'mobile',
        capabilities: { voice: false, sms: true, mms: false },
        pageSize: 5,
      }),
    ).toEqual({ outcome: 'ok', numbers: [], truncated: false });
    expect(mobile.sent[0]?.path).toBe(
      `${BASE}/AvailablePhoneNumbers/GB/Mobile.json?VoiceEnabled=false&SmsEnabled=true&MmsEnabled=false&PageSize=5`,
    );
  });

  it.each([
    ['a lowercase country', { country: 'us', kind: 'local' }],
    ['an unknown kind', { country: 'US', kind: 'national' }],
    ['an area code outside the US and Canada', { country: 'GB', kind: 'local', areaCode: 207 }],
    ['an area code that is not three digits', { country: 'US', kind: 'local', areaCode: 41 }],
    ['a region outside the US and Canada', { country: 'GB', kind: 'local', inRegion: 'LN' }],
    [
      'a postal code outside the US and Canada',
      { country: 'GB', kind: 'local', inPostalCode: 'SW1A' },
    ],
    ['a pattern with one real character', { country: 'US', kind: 'local', contains: '5**' }],
    ['a wildcard between real characters', { country: 'US', kind: 'local', contains: '55*01' }],
    ['an anchor next to a wildcard', { country: 'US', kind: 'local', contains: '+*555' }],
    ['a pattern with a forbidden character', { country: 'US', kind: 'local', contains: '55&01' }],
    ['a pattern that is too long', { country: 'US', kind: 'local', contains: '1'.repeat(17) }],
    ['a page larger than this boundary reads', { country: 'US', kind: 'local', pageSize: 101 }],
    ['an unexpected field', { country: 'US', kind: 'local', Page: 3 }],
    ['a locality with control characters', { country: 'US', kind: 'local', inLocality: 'a\nb' }],
  ])('refuses %s without a request', async (_name, query) => {
    const { transport, sent } = recording(ok(fixture('available-local.json')));
    // @ts-expect-error -- the runtime check, not the type, is what is under test.
    expect(await searchAvailableNumbers(transport, withToken, query)).toEqual(refusedInput);
    expect(sent).toHaveLength(0);
  });

  it('refuses credentials whose Account SID is malformed without a request', async () => {
    const { transport, sent } = recording(ok(fixture('available-local.json')));
    const bad = { accountSid: '../AC', authToken: AUTH_TOKEN };
    expect(await searchAvailableNumbers(transport, bad, { country: 'US', kind: 'local' })).toEqual(
      refusedInput,
    );
    expect(sent).toHaveLength(0);
  });

  const page = fixture('available-local.json');
  const first = firstOf(page['available_phone_numbers']);
  it.each([
    ['another country', { ...page, available_phone_numbers: [{ ...first, iso_country: 'CA' }] }],
    [
      'a number that is not E.164',
      { ...page, available_phone_numbers: [{ ...first, phone_number: '415' }] },
    ],
    [
      'an unknown address rule',
      { ...page, available_phone_numbers: [{ ...first, address_requirements: 'all' }] },
    ],
    ['no list', { ...page, available_phone_numbers: null }],
    [
      'more numbers than were asked for',
      { ...page, available_phone_numbers: Array.from({ length: 21 }, () => first) },
    ],
    ['a body that is not JSON', 'not json'],
  ])('treats a page with %s as unavailable', async (_name, body) => {
    const { transport } = recording(ok(body));
    expect(
      await searchAvailableNumbers(transport, withToken, { country: 'US', kind: 'local' }),
    ).toEqual({
      outcome: 'unavailable',
    });
  });

  it.each([
    [ok('', 401), { outcome: 'refused' }],
    [ok('', 403), { outcome: 'refused' }],
    [twilioError(400, 21_452), { outcome: 'rejected', httpStatus: 400, code: 21_452 }],
    [ok('{}', 404), { outcome: 'rejected', httpStatus: 404, code: null }],
    [ok('', 500), { outcome: 'unavailable' }],
    [ok('', 302), { outcome: 'unavailable' }],
    [new Error('socket hang up'), { outcome: 'unavailable' }],
  ])('sorts answer %# into %o', async (answer, expected) => {
    const { transport } = recording(answer);
    expect(
      await searchAvailableNumbers(transport, withToken, { country: 'US', kind: 'local' }),
    ).toEqual(expected);
  });
});

describe('fetchNumberPricing', () => {
  it('reads the country price list from the pricing host, prices kept as decimal strings', async () => {
    const { transport, sent } = recording(ok(fixture('pricing-us.json')));
    const result = await fetchNumberPricing(transport, withKey, 'US');
    expect(sent).toEqual([
      {
        host: 'pricing',
        method: 'GET',
        path: '/v1/PhoneNumbers/Countries/US',
        headers: { accept: 'application/json', authorization: basic(KEY_SID, KEY_SECRET) },
      },
    ]);
    expect(result).toEqual({
      outcome: 'ok',
      pricing: {
        isoCountry: 'US',
        country: 'United States',
        currency: 'USD',
        prices: [
          { numberType: 'local', basePrice: '9.25', currentPrice: '8.50' },
          { numberType: 'toll_free', basePrice: '9.75', currentPrice: '9.75' },
          { numberType: 'mobile', basePrice: '9.50', currentPrice: '9.50' },
          { numberType: 'national', basePrice: '9.00', currentPrice: '9.00' },
        ],
      },
    });
  });

  it('leaves out number types it does not know and reads a null list as no prices', async () => {
    const body = fixture('pricing-us.json');
    const extra = recording(
      ok({
        ...body,
        country: null,
        price_unit: 'usd',
        phone_number_prices: [
          { number_type: 'shared cost', base_price: '1.00', current_price: '1.00' },
          { number_type: 'local', base_price: '9.25', current_price: '9.25' },
        ],
      }),
    );
    expect(await fetchNumberPricing(extra.transport, withToken, 'US')).toEqual({
      outcome: 'ok',
      pricing: {
        isoCountry: 'US',
        country: '',
        currency: 'USD',
        prices: [{ numberType: 'local', basePrice: '9.25', currentPrice: '9.25' }],
      },
    });
    const none = recording(ok({ ...body, phone_number_prices: null }));
    expect(await fetchNumberPricing(none.transport, withToken, 'US')).toMatchObject({
      outcome: 'ok',
      pricing: { prices: [] },
    });
  });

  const body = fixture('pricing-us.json');
  const price = firstOf(body['phone_number_prices']);
  it.each([
    ['another country', { ...body, iso_country: 'CA' }],
    ['a numeric price', { ...body, phone_number_prices: [{ ...price, base_price: 9.25 }] }],
    ['a negative price', { ...body, phone_number_prices: [{ ...price, current_price: '-1.00' }] }],
    ['an exponent price', { ...body, phone_number_prices: [{ ...price, current_price: '1e3' }] }],
    ['no currency', { ...body, price_unit: null }],
    ['a currency that is not a code', { ...body, price_unit: 'US$' }],
    ['a body that is not JSON', '<html>'],
  ])('treats a price list with %s as unavailable', async (_name, answer) => {
    const { transport } = recording(ok(answer));
    expect(await fetchNumberPricing(transport, withToken, 'US')).toEqual({
      outcome: 'unavailable',
    });
  });

  it('refuses a malformed country without a request, and sorts failures', async () => {
    const { transport, sent } = recording(ok(body));
    expect(await fetchNumberPricing(transport, withToken, 'US/../../x')).toEqual(refusedInput);
    expect(sent).toHaveLength(0);
    expect(await fetchNumberPricing(recording(ok('', 401)).transport, withToken, 'US')).toEqual({
      outcome: 'refused',
    });
    expect(
      await fetchNumberPricing(recording(twilioError(404, 20_404)).transport, withToken, 'ZZ'),
    ).toEqual({ outcome: 'rejected', httpStatus: 404, code: 20_404 });
    expect(await fetchNumberPricing(recording(new Error('x')).transport, withToken, 'US')).toEqual({
      outcome: 'unavailable',
    });
  });
});

const owned = {
  sid: NUMBER_SID,
  e164: '+14155550101',
  friendlyName: 'Main line',
  capabilities: ['sms', 'mms', 'voice'],
  addressRequirements: 'none',
  addressSid: null,
  bundleSid: null,
};

describe('purchaseNumber', () => {
  const input = {
    e164: '+14155550101',
    friendlyName: 'Main line',
    voiceUrl: 'https://crm.example.test/webhooks/twilio/voice',
    smsUrl: 'https://crm.example.test/webhooks/twilio/sms',
    addressSid: `AD${'1'.repeat(32)}`,
    bundleSid: `BU${'2'.repeat(32)}`,
  };

  it('buys exactly the chosen number, once, with exactly these parameters', async () => {
    const { transport, sent } = recording(ok(fixture('incoming-number.json'), 201));
    const result = await purchaseNumber(transport, withKey, input);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.host).toBe('api');
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.path).toBe(`${BASE}/IncomingPhoneNumbers.json`);
    expect(sent[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect([...new URLSearchParams(sent[0]?.body)]).toEqual([
      ['PhoneNumber', '+14155550101'],
      ['FriendlyName', 'Main line'],
      ['VoiceUrl', input.voiceUrl],
      ['VoiceMethod', 'POST'],
      ['SmsUrl', input.smsUrl],
      ['SmsMethod', 'POST'],
      ['AddressSid', input.addressSid],
      ['BundleSid', input.bundleSid],
    ]);
    expect(result).toEqual({ outcome: 'accepted', number: owned });
  });

  it('sends only the number when nothing else is asked for', async () => {
    const { transport, sent } = recording(ok(fixture('incoming-number.json'), 201));
    await purchaseNumber(transport, withToken, { e164: '+14155550101' });
    expect(sent[0]?.body).toBe('PhoneNumber=%2B14155550101');
  });

  it.each([
    ['a number that is not E.164', { e164: '4155550101' }],
    ['an area code instead of a number', { e164: '+14155550101', areaCode: '415' }],
    ['a plain-http webhook', { e164: '+14155550101', voiceUrl: 'http://crm.example.test/v' }],
    [
      'a webhook with credentials',
      { e164: '+14155550101', smsUrl: 'https://u:p@crm.example.test/s' },
    ],
    ['a webhook with a fragment', { e164: '+14155550101', smsUrl: 'https://crm.example.test/s#x' }],
    ['a malformed address SID', { e164: '+14155550101', addressSid: 'AD1' }],
    ['a malformed bundle SID', { e164: '+14155550101', bundleSid: `AD${'2'.repeat(32)}` }],
    ['an empty name', { e164: '+14155550101', friendlyName: '' }],
    ['a name that is too long', { e164: '+14155550101', friendlyName: 'n'.repeat(65) }],
  ])('refuses %s without a request', async (_name, value) => {
    const { transport, sent } = recording(ok(fixture('incoming-number.json'), 201));
    expect(await purchaseNumber(transport, withToken, value)).toEqual(refusedInput);
    expect(sent).toHaveLength(0);
  });

  it.each([
    [twilioError(400, 21_422), { outcome: 'rejected', httpStatus: 400, code: 21_422 }],
    [ok('', 401), { outcome: 'rejected', httpStatus: 401, code: null }],
    // 429 is not processed, but buying again is the caller's decision, never automatic.
    [twilioError(429, 20_429), { outcome: 'rejected', httpStatus: 429, code: 20_429 }],
    [ok('', 500), { outcome: 'unknown', reason: 'server_error' }],
    [ok('', 302), { outcome: 'unknown', reason: 'unexpected_status' }],
    [new Error('timeout'), { outcome: 'unknown', reason: 'no_response' }],
    [ok('not json', 201), { outcome: 'unknown', reason: 'unreadable' }],
  ])('sorts answer %# into %o and never repeats it', async (answer, expected) => {
    const { transport, sent } = recording(answer);
    expect(await purchaseNumber(transport, withToken, { e164: '+14155550101' })).toEqual(expected);
    expect(sent).toHaveLength(1);
  });

  const bought = fixture('incoming-number.json');
  it.each([
    ['another account', { ...bought, account_sid: OTHER_ACCOUNT }],
    ['a different number', { ...bought, phone_number: '+14155550199' }],
    ['a malformed SID', { ...bought, sid: 'PN1' }],
    ['an unknown address rule', { ...bought, address_requirements: 'everywhere' }],
  ])('does not count a success naming %s as a purchase', async (_name, body) => {
    const { transport } = recording(ok(body, 201));
    expect(await purchaseNumber(transport, withToken, { e164: '+14155550101' })).toEqual({
      outcome: 'unknown',
      reason: 'unreadable',
    });
  });
});

describe('findOwnedNumber', () => {
  const list = (numbers: unknown[], next: string | null = null) =>
    ok({
      first_page_uri: `${BASE}/IncomingPhoneNumbers.json?PageSize=50&Page=0`,
      next_page_uri: next,
      page: 0,
      page_size: 50,
      incoming_phone_numbers: numbers,
    });
  const number = fixture('incoming-number.json');

  it('reconciles an unknown purchase by an exact match on the number', async () => {
    const near = { ...number, sid: `PN${'3'.repeat(32)}`, phone_number: '+141555501019' };
    const { transport, sent } = recording(list([near, number]));
    expect(await findOwnedNumber(transport, withToken, '+14155550101')).toEqual({
      outcome: 'found',
      number: owned,
    });
    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.path).toBe(
      `${BASE}/IncomingPhoneNumbers.json?PhoneNumber=%2B14155550101&PageSize=50`,
    );
  });

  it('reports absent only when the whole answer was read', async () => {
    expect(await findOwnedNumber(recording(list([])).transport, withToken, '+14155550101')).toEqual(
      {
        outcome: 'absent',
      },
    );
    const more = list([], `${BASE}/IncomingPhoneNumbers.json?PageSize=50&Page=1`);
    expect(await findOwnedNumber(recording(more).transport, withToken, '+14155550101')).toEqual({
      outcome: 'unavailable',
    });
  });

  it.each([
    ['another account', [{ ...number, account_sid: OTHER_ACCOUNT }]],
    ['two numbers that both match', [number, { ...number, sid: `PN${'4'.repeat(32)}` }]],
    ['a malformed number', [{ ...number, sid: null }]],
  ])('treats a list with %s as unavailable', async (_name, numbers) => {
    expect(
      await findOwnedNumber(recording(list(numbers)).transport, withToken, '+14155550101'),
    ).toEqual({
      outcome: 'unavailable',
    });
  });

  it('refuses a malformed number without a request, and sorts failures', async () => {
    const { transport, sent } = recording(list([]));
    expect(await findOwnedNumber(transport, withToken, '+1 415')).toEqual(refusedInput);
    expect(sent).toHaveLength(0);
    expect(
      await findOwnedNumber(recording(ok('', 403)).transport, withToken, '+14155550101'),
    ).toEqual({
      outcome: 'refused',
    });
    expect(
      await findOwnedNumber(recording(new Error('x')).transport, withToken, '+14155550101'),
    ).toEqual({
      outcome: 'unavailable',
    });
    expect(
      await findOwnedNumber(recording(ok('nope')).transport, withToken, '+14155550101'),
    ).toEqual({
      outcome: 'unavailable',
    });
  });
});

describe('fetchOwnedNumber', () => {
  it('reads one owned number bound to this account and SID', async () => {
    const { transport, sent } = recording(ok(fixture('incoming-number.json')));
    expect(await fetchOwnedNumber(transport, withToken, NUMBER_SID)).toEqual({
      outcome: 'ok',
      number: owned,
    });
    expect(sent[0]?.path).toBe(`${BASE}/IncomingPhoneNumbers/${NUMBER_SID}.json`);
    expect(sent[0]?.method).toBe('GET');
  });

  it('keeps the address and bundle the number is registered with', async () => {
    const body = {
      ...fixture('incoming-number.json'),
      address_requirements: 'local',
      address_sid: `AD${'1'.repeat(32)}`,
      bundle_sid: `BU${'2'.repeat(32)}`,
      friendly_name: null,
      capabilities: null,
    };
    expect(await fetchOwnedNumber(recording(ok(body)).transport, withToken, NUMBER_SID)).toEqual({
      outcome: 'ok',
      number: {
        ...owned,
        friendlyName: '',
        capabilities: [],
        addressRequirements: 'local',
        addressSid: `AD${'1'.repeat(32)}`,
        bundleSid: `BU${'2'.repeat(32)}`,
      },
    });
  });

  it.each([
    [ok('{}', 404), { outcome: 'not_found' }],
    [
      ok({ ...fixture('incoming-number.json'), sid: `PN${'5'.repeat(32)}` }),
      { outcome: 'unavailable' },
    ],
    [
      ok({ ...fixture('incoming-number.json'), account_sid: OTHER_ACCOUNT }),
      { outcome: 'unavailable' },
    ],
    [ok('', 401), { outcome: 'refused' }],
    [twilioError(400, 20_001), { outcome: 'rejected', httpStatus: 400, code: 20_001 }],
    [ok('', 503), { outcome: 'unavailable' }],
    [new Error('reset'), { outcome: 'unavailable' }],
  ])('sorts answer %# into %o', async (answer, expected) => {
    expect(await fetchOwnedNumber(recording(answer).transport, withToken, NUMBER_SID)).toEqual(
      expected,
    );
  });

  it('refuses a SID that is not an owned-number SID without a request', async () => {
    const { transport, sent } = recording(ok(fixture('incoming-number.json')));
    for (const sid of [`CA${'1'.repeat(32)}`, `${NUMBER_SID}.json/../x`, ''])
      expect(await fetchOwnedNumber(transport, withToken, sid)).toEqual(refusedInput);
    expect(sent).toHaveLength(0);
  });
});

describe('releaseNumber', () => {
  it('releases one owned number with a DELETE on its own instance', async () => {
    const { transport, sent } = recording(ok('', 204));
    expect(await releaseNumber(transport, withKey, NUMBER_SID)).toEqual({ outcome: 'released' });
    expect(sent).toEqual([
      {
        host: 'api',
        method: 'DELETE',
        path: `${BASE}/IncomingPhoneNumbers/${NUMBER_SID}.json`,
        headers: { accept: 'application/json', authorization: basic(KEY_SID, KEY_SECRET) },
      },
    ]);
  });

  it.each([
    [ok('{}', 404), { outcome: 'not_found' }],
    [twilioError(400, 21_000), { outcome: 'rejected', httpStatus: 400, code: 21_000 }],
    [ok('', 500), { outcome: 'unknown', reason: 'server_error' }],
    // Only the documented 204 counts as released.
    [ok('{}', 200), { outcome: 'unknown', reason: 'unexpected_status' }],
    [ok('', 301), { outcome: 'unknown', reason: 'unexpected_status' }],
    [new Error('reset'), { outcome: 'unknown', reason: 'no_response' }],
  ])('sorts answer %# into %o and never repeats it', async (answer, expected) => {
    const { transport, sent } = recording(answer);
    expect(await releaseNumber(transport, withToken, NUMBER_SID)).toEqual(expected);
    expect(sent).toHaveLength(1);
  });

  it('refuses anything but a well-formed owned-number SID without a request', async () => {
    const { transport, sent } = recording(ok('', 204));
    for (const sid of [`PN${'1'.repeat(31)}`, `AC${'1'.repeat(32)}`, `${NUMBER_SID}/..`])
      expect(await releaseNumber(transport, withToken, sid)).toEqual(refusedInput);
    expect(
      await releaseNumber(transport, { accountSid: 'AC1', authToken: AUTH_TOKEN }, NUMBER_SID),
    ).toEqual(refusedInput);
    expect(sent).toHaveLength(0);
  });
});

describe('configureNumberVoice', () => {
  const input = {
    voiceUrl: 'https://crm.example.test/webhooks/twilio/voice/token123/inbound',
    statusCallback: 'https://crm.example.test/webhooks/twilio/voice/token123/ended',
  };

  it('updates the number on Twilio with the exact path and the exact four form fields', async () => {
    const { transport, sent } = recording(ok('', 200));
    const result = await configureNumberVoice(transport, withKey, NUMBER_SID, input);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.host).toBe('api');
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.path).toBe(`${BASE}/IncomingPhoneNumbers/${NUMBER_SID}.json`);
    expect(sent[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect([...new URLSearchParams(sent[0]?.body)]).toEqual([
      ['VoiceUrl', input.voiceUrl],
      ['VoiceMethod', 'POST'],
      ['StatusCallback', input.statusCallback],
      ['StatusCallbackMethod', 'POST'],
    ]);
    expect(result).toEqual({ outcome: 'accepted' });
  });

  it('refuses a malformed SID without reaching the transport', async () => {
    const { transport, sent } = recording(ok('', 200));
    for (const sid of [`PN${'1'.repeat(31)}`, `AC${'1'.repeat(32)}`, `${NUMBER_SID}/..`, ''])
      expect(await configureNumberVoice(transport, withToken, sid, input)).toEqual(refusedInput);
    expect(
      await configureNumberVoice(
        transport,
        { accountSid: 'AC1', authToken: AUTH_TOKEN },
        NUMBER_SID,
        input,
      ),
    ).toEqual(refusedInput);
    expect(sent).toHaveLength(0);
  });

  it.each([
    ['a plain-http voice URL', { ...input, voiceUrl: 'http://crm.example.test/v' }],
    ['a plain-http status callback', { ...input, statusCallback: 'http://crm.example.test/s' }],
    ['a URL with credentials', { ...input, voiceUrl: 'https://u:p@crm.example.test/v' }],
    ['a URL with fragment', { ...input, statusCallback: 'https://crm.example.test/s#x' }],
  ])('refuses %s without a request', async (_name, badInput) => {
    const { transport, sent } = recording(ok('', 200));
    expect(await configureNumberVoice(transport, withToken, NUMBER_SID, badInput)).toEqual(
      refusedInput,
    );
    expect(sent).toHaveLength(0);
  });

  it.each([
    [twilioError(400, 21_422), { outcome: 'rejected', httpStatus: 400, code: 21_422 }],
    [twilioError(404, 20_404), { outcome: 'rejected', httpStatus: 404, code: 20_404 }],
    [ok('', 401), { outcome: 'rejected', httpStatus: 401, code: null }],
    [ok('', 500), { outcome: 'unknown', reason: 'server_error' }],
    [ok('', 302), { outcome: 'unknown', reason: 'unexpected_status' }],
    [new Error('timeout'), { outcome: 'unknown', reason: 'no_response' }],
  ])('sorts answer %# into %o', async (answer, expected) => {
    const { transport, sent } = recording(answer);
    expect(await configureNumberVoice(transport, withToken, NUMBER_SID, input)).toEqual(expected);
    expect(sent).toHaveLength(1);
  });
});

describe('listVerifiedCallerIds', () => {
  it('follows this account’s own pages and returns every verified caller ID', async () => {
    const { transport, sent } = recording(
      ok(fixture('outgoing-caller-ids-page-0.json')),
      ok(fixture('outgoing-caller-ids-page-1.json')),
    );
    expect(await listVerifiedCallerIds(transport, withToken)).toEqual({
      outcome: 'ok',
      truncated: false,
      callerIds: [
        {
          sid: 'PN00000000000000000000000000000201',
          e164: '+12025550123',
          friendlyName: 'Front desk',
        },
        { sid: 'PN00000000000000000000000000000202', e164: '+12025550124', friendlyName: '' },
      ],
    });
    expect(sent.map((each) => each.path)).toEqual([
      `${BASE}/OutgoingCallerIds.json?PageSize=1000`,
      `${BASE}/OutgoingCallerIds.json?PageSize=1000&Page=1&PageToken=PASynthetic`,
    ]);
  });

  it('stops at the page limit and says so', async () => {
    const { transport, sent } = recording(ok(fixture('outgoing-caller-ids-page-0.json')));
    expect(await listVerifiedCallerIds(transport, withToken)).toMatchObject({
      outcome: 'ok',
      truncated: true,
      callerIds: [{ sid: 'PN00000000000000000000000000000201' }],
    });
    expect(sent).toHaveLength(CALLER_ID_PAGE_LIMIT);
  });

  const page = fixture('outgoing-caller-ids-page-1.json');
  const entry = firstOf(page['outgoing_caller_ids']);
  it.each([
    [
      'a next page on another account',
      {
        ...page,
        next_page_uri: `/2010-04-01/Accounts/${OTHER_ACCOUNT}/OutgoingCallerIds.json?Page=1`,
      },
    ],
    [
      'a next page that is a full URL',
      { ...page, next_page_uri: `https://evil.example${BASE}/OutgoingCallerIds.json?Page=1` },
    ],
    [
      'a next page on another resource',
      { ...page, next_page_uri: `${BASE}/IncomingPhoneNumbers.json?Page=1` },
    ],
    [
      'an entry from another account',
      { ...page, outgoing_caller_ids: [{ ...entry, account_sid: OTHER_ACCOUNT }] },
    ],
    [
      'an entry that is not E.164',
      { ...page, outgoing_caller_ids: [{ ...entry, phone_number: 'n/a' }] },
    ],
    ['no list', { ...page, outgoing_caller_ids: undefined }],
  ])('treats a page with %s as unavailable', async (_name, body) => {
    expect(await listVerifiedCallerIds(recording(ok(body)).transport, withToken)).toEqual({
      outcome: 'unavailable',
    });
  });

  it('sorts failures and refuses malformed credentials without a request', async () => {
    expect(await listVerifiedCallerIds(recording(ok('', 401)).transport, withToken)).toEqual({
      outcome: 'refused',
    });
    expect(
      await listVerifiedCallerIds(recording(twilioError(400, 20_001)).transport, withToken),
    ).toEqual({
      outcome: 'rejected',
      httpStatus: 400,
      code: 20_001,
    });
    expect(await listVerifiedCallerIds(recording(new Error('x')).transport, withToken)).toEqual({
      outcome: 'unavailable',
    });
    const { transport, sent } = recording(ok(page));
    expect(
      await listVerifiedCallerIds(transport, { accountSid: 'x', authToken: AUTH_TOKEN }),
    ).toEqual(refusedInput);
    expect(sent).toHaveLength(0);
  });
});

describe('startCallerIdVerification', () => {
  const input = {
    e164: '+12025550125',
    friendlyName: 'Owner cell',
    callDelaySeconds: 5,
    extension: '1234',
    statusCallback: 'https://crm.example.test/webhooks/twilio/caller-id',
  };

  it('asks Twilio to place one verification call and returns the code to show', async () => {
    const { transport, sent } = recording(ok(fixture('validation-request.json')));
    const result = await startCallerIdVerification(transport, withToken, input);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.path).toBe(`${BASE}/OutgoingCallerIds.json`);
    expect([...new URLSearchParams(sent[0]?.body)]).toEqual([
      ['PhoneNumber', '+12025550125'],
      ['FriendlyName', 'Owner cell'],
      ['CallDelay', '5'],
      ['Extension', '1234'],
      ['StatusCallback', input.statusCallback],
      ['StatusCallbackMethod', 'POST'],
    ]);
    // Accepted means the call was requested; the caller ID is verified only by the callback.
    expect(result).toEqual({
      outcome: 'accepted',
      verification: {
        e164: '+12025550125',
        callSid: 'CA00000000000000000000000000000301',
        validationCode: '123456',
      },
    });
  });

  it('sends only the number when nothing else is asked for', async () => {
    const { transport, sent } = recording(ok(fixture('validation-request.json')));
    await startCallerIdVerification(transport, withToken, { e164: '+12025550125' });
    expect(sent[0]?.body).toBe('PhoneNumber=%2B12025550125');
  });

  it.each([
    ['a number that is not E.164', { e164: '2025550125' }],
    ['a delay over a minute', { e164: '+12025550125', callDelaySeconds: 61 }],
    ['a fractional delay', { e164: '+12025550125', callDelaySeconds: 1.5 }],
    ['an extension with letters', { e164: '+12025550125', extension: '12a' }],
    [
      'a plain-http callback',
      { e164: '+12025550125', statusCallback: 'http://crm.example.test/c' },
    ],
    [
      'a callback that is too long',
      { e164: '+12025550125', statusCallback: `https://crm.example.test/${'c'.repeat(1000)}` },
    ],
    ['a name that is too long', { e164: '+12025550125', friendlyName: 'n'.repeat(65) }],
  ])('refuses %s without a request', async (_name, value) => {
    const { transport, sent } = recording(ok(fixture('validation-request.json')));
    expect(await startCallerIdVerification(transport, withToken, value)).toEqual(refusedInput);
    expect(sent).toHaveLength(0);
  });

  const body = fixture('validation-request.json');
  it.each([
    [twilioError(400, 21_450), { outcome: 'rejected', httpStatus: 400, code: 21_450 }],
    [ok('', 500), { outcome: 'unknown', reason: 'server_error' }],
    [ok('', 307), { outcome: 'unknown', reason: 'unexpected_status' }],
    [new Error('timeout'), { outcome: 'unknown', reason: 'no_response' }],
    [ok({ ...body, account_sid: OTHER_ACCOUNT }), { outcome: 'unknown', reason: 'unreadable' }],
    [ok({ ...body, phone_number: '+12025550199' }), { outcome: 'unknown', reason: 'unreadable' }],
    [ok({ ...body, validation_code: '12345' }), { outcome: 'unknown', reason: 'unreadable' }],
    [ok({ ...body, call_sid: null }), { outcome: 'unknown', reason: 'unreadable' }],
  ])('sorts answer %# into %o and never places a second call', async (answer, expected) => {
    const { transport, sent } = recording(answer);
    expect(await startCallerIdVerification(transport, withToken, { e164: '+12025550125' })).toEqual(
      expected,
    );
    expect(sent).toHaveLength(1);
  });
});

describe('outputs', () => {
  it('never carry a credential', async () => {
    const results = await Promise.all([
      fetchOwnedNumber(
        recording(ok(fixture('incoming-number.json'))).transport,
        withKey,
        NUMBER_SID,
      ),
      fetchNumberPricing(recording(ok(fixture('pricing-us.json'))).transport, withKey, 'US'),
      listVerifiedCallerIds(
        recording(ok(fixture('outgoing-caller-ids-page-1.json'))).transport,
        withKey,
      ),
      startCallerIdVerification(
        recording(ok(fixture('validation-request.json'))).transport,
        withKey,
        { e164: '+12025550125' },
      ),
      configureNumberVoice(recording(ok('', 200)).transport, withKey, NUMBER_SID, {
        voiceUrl: 'https://crm.example.test/v',
        statusCallback: 'https://crm.example.test/s',
      }),
    ]);
    const text = JSON.stringify(results);
    expect(text).not.toContain(AUTH_TOKEN);
    expect(text).not.toContain(KEY_SECRET);
  });
});
