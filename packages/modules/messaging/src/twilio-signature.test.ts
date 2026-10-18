// Twilio webhook signatures. The anchor is Twilio's own worked example; the port and
// query-string cases are adapted from the official SDK's tests (twilio-node 6.1.2,
// spec/unit/webhooks/webhooks.spec.js; MIT, Copyright (C) 2023, Twilio, Inc.: the full
// notice is at the top of twilio-signature.ts).
import crypto from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  expectedBodyHash,
  expectedSignature,
  validateBody,
  validateSignature,
  validateSignatureWithBody,
} from './twilio-signature.js';

// https://www.twilio.com/docs/usage/security#validating-requests, "Explore the algorithm
// yourself": the token, URL, parameters and signature are all published there.
const DOCUMENTED = {
  authToken: '12345',
  url: 'https://example.com/myapp.php?foo=1&bar=2',
  params: {
    Digits: '1234',
    To: '+18005551212',
    From: '+14158675310',
    Caller: '+14158675310',
    CallSid: 'CA1234567890ABCDE',
  },
  signature: 'L/OH5YylLD5NRKLltdqwSvS0BnU=',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Twilio's documented example", () => {
  it('gives the published signature', () => {
    expect(expectedSignature(DOCUMENTED.authToken, DOCUMENTED.url, DOCUMENTED.params)).toBe(
      DOCUMENTED.signature,
    );
    expect(
      validateSignature(
        DOCUMENTED.authToken,
        DOCUMENTED.signature,
        DOCUMENTED.url,
        DOCUMENTED.params,
      ),
    ).toBe(true);
  });

  it('does not depend on the order the parameters arrived in', () => {
    const reversed = Object.fromEntries(Object.entries(DOCUMENTED.params).reverse());
    expect(expectedSignature(DOCUMENTED.authToken, DOCUMENTED.url, reversed)).toBe(
      DOCUMENTED.signature,
    );
  });

  it.each([
    ['the URL', { url: 'https://example.com/myapp.php?foo=1&bar=3' }],
    ['a value', { params: { ...DOCUMENTED.params, Digits: '1235' } }],
    ['a name', { params: { ...DOCUMENTED.params, Digits: undefined, Digit: '1234' } }],
    ['the token', { authToken: '12346' }],
    ['the token case', { authToken: 'ABCDE' }],
    ['an added parameter', { params: { ...DOCUMENTED.params, Extra: '1' } }],
    ['a removed parameter', { params: { ...DOCUMENTED.params, Caller: undefined } }],
    ['a trimmed value', { params: { ...DOCUMENTED.params, Digits: ' 1234' } }],
  ])('refuses a change to %s', (_what, change) => {
    const merged = { ...DOCUMENTED, ...change };
    const params = Object.fromEntries(
      Object.entries(merged.params).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, value]],
      ),
    );
    expect(validateSignature(merged.authToken, DOCUMENTED.signature, merged.url, params)).toBe(
      false,
    );
  });
});

describe('what is signed', () => {
  const token = 's3cr3t';
  const url = 'https://example.com/hook';

  it('appends each name and value to the URL with no delimiters, as UTF-8', () => {
    const params = { b: 'ü', a: '1' };
    const manual = crypto
      .createHmac('sha1', token)
      .update(Buffer.from(`${url}a1bü`, 'utf8'))
      .digest('base64');
    expect(expectedSignature(token, url, params)).toBe(manual);
  });

  it('sorts names by code unit, so upper case comes before lower case', () => {
    const manual = crypto.createHmac('sha1', token).update(`${url}To1from2`).digest('base64');
    expect(expectedSignature(token, url, { from: '2', To: '1' })).toBe(manual);
  });

  it('signs a repeated parameter once per distinct value, values sorted', () => {
    const manual = crypto.createHmac('sha1', token).update(`${url}xaxb`).digest('base64');
    expect(expectedSignature(token, url, { x: ['b', 'a', 'b'] })).toBe(manual);
    expect(expectedSignature(token, url, { x: ['a', 'b'] })).toBe(manual);
  });

  it('keeps leading and trailing spaces, plus signs and emoji in values', () => {
    const params = { Body: '  STOP \u{1F600} + %2B ' };
    const signature = expectedSignature(token, url, params);
    expect(validateSignature(token, signature, url, params)).toBe(true);
    expect(validateSignature(token, signature, url, { Body: params.Body.trim() })).toBe(false);
  });
});

// twilio-node spec/unit/webhooks/webhooks.spec.js, "validateRequest()".
describe("the SDK's URL cases", () => {
  const token = 's3cr3t';
  const signed = (url: string) => expectedSignature(token, url, {});

  it('refuses a signature made for another URL', () => {
    expect(
      validateSignature(
        token,
        signed('https://example.com/path?test=param'),
        'https://example.com/path?test=param2',
        {},
      ),
    ).toBe(false);
  });

  it.each([
    ['https://example.com:443/path?test=param', 'https://example.com:443/path?test=param'],
    ['https://example.com:443/path?test=param', 'https://example.com/path?test=param'],
    ['https://example.com/path?test=param', 'https://example.com/path?test=param'],
    ['https://example.com/path?test=param', 'https://example.com:443/path?test=param'],
    ['http://example.com:80/path', 'http://example.com/path'],
    ['https://example.com:8443/path', 'https://example.com:8443/path'],
    [
      "https://example.com/path?test=param'WithQuote",
      "https://example.com/path?test=param'WithQuote",
    ],
    [
      "https://example.com/path?test=param'WithQuote",
      'https://example.com/path?test=param%27WithQuote',
    ],
    [
      'https://example.com/path?test=param%27WithQuote',
      "https://example.com/path?test=param'WithQuote",
    ],
    [
      'https://example.com/path?test=param%27WithQuote',
      'https://example.com/path?test=param%27WithQuote',
    ],
  ])('accepts a signature made for %s when checking %s', (signedUrl, checkedUrl) => {
    expect(validateSignature(token, signed(signedUrl), checkedUrl, {})).toBe(true);
  });

  it('refuses a non-standard port that was not signed', () => {
    expect(
      validateSignature(
        token,
        signed('https://example.com:8443/path'),
        'https://example.com/path',
        {},
      ),
    ).toBe(false);
  });
});

describe('comparison', () => {
  const token = 's3cr3t';
  const url = 'https://example.com/path?test=param';
  const good = expectedSignature(token, url, {});

  it('refuses a signature that differs only in its last character', () => {
    const tampered = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    expect(validateSignature(token, tampered, url, {})).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['shorter', good.slice(0, -1)],
    ['longer', `${good}=`],
    ['not base64', '!!!!not-base64!!!!'],
  ])('refuses a signature that is %s, without throwing', (_what, signature) => {
    expect(validateSignature(token, signature, url, {})).toBe(false);
  });

  it('compares in constant time, and only values of equal length', () => {
    const compare = vi.spyOn(crypto, 'timingSafeEqual');
    expect(validateSignature(token, good, url, {})).toBe(true);
    expect(compare).toHaveBeenCalledTimes(1);
    compare.mockClear();
    // No variant of the URL matches: each of the four is compared, each in constant time.
    const wrong = `${good.slice(0, -2)}${good.endsWith('A=') ? 'B=' : 'A='}`;
    expect(validateSignature(token, wrong, url, {})).toBe(false);
    expect(compare).toHaveBeenCalledTimes(4);
    compare.mockClear();
    expect(validateSignature(token, good.slice(1), url, {})).toBe(false);
    expect(compare).not.toHaveBeenCalled();
  });

  it('throws on a URL that cannot be parsed, as the SDK does', () => {
    expect(() => validateSignature(token, good, 'not a url', {})).toThrow(TypeError);
  });
});

// https://www.twilio.com/docs/usage/webhooks/webhooks-security#json-request-bodies
describe('JSON bodies (bodySHA256)', () => {
  const token = 's3cr3t';
  const body = '{"CallSid":"CA1234567890ABCDE","Caller":"+12349013030"}';
  const hash = '5ccde7145dfb8f56479710896586cb9d5911809d83afbe34627818790db0aec9';
  const url = `https://example.com/myapp?bodySHA256=${hash}`;

  it("reproduces the documented example's body hash", () => {
    expect(expectedBodyHash(body)).toBe(hash);
    expect(validateBody(body, hash)).toBe(true);
    expect(validateBody(`${body} `, hash)).toBe(false);
    expect(validateBody(body, '')).toBe(false);
  });

  it('needs both the URL signature, over no parameters, and the body hash', () => {
    const signature = expectedSignature(token, url, {});
    expect(validateSignatureWithBody(token, signature, url, body)).toBe(true);
    expect(validateSignatureWithBody(token, signature, url, `${body} `)).toBe(false);
    expect(validateSignatureWithBody(token, `x${signature.slice(1)}`, url, body)).toBe(false);
    const unhashed = 'https://example.com/myapp';
    expect(
      validateSignatureWithBody(token, expectedSignature(token, unhashed, {}), unhashed, body),
    ).toBe(false);
  });
});
