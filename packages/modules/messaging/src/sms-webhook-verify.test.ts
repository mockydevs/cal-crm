// "Callbacks with an invalid signature are rejected": the decision, on stored raw requests
// built from the documented parameter sets in fixtures/twilio and signed here with a test
// token. No request in this file came from Twilio.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { statusCallbackUrl, inboundWebhookUrl } from './sms-webhook-url.js';
import {
  inboundSmsOf,
  statusCallbackOf,
  verifySmsWebhook,
  type StoredSmsWebhook,
} from './sms-webhook-verify.js';
import { expectedSignature } from './twilio-signature.js';

const paramsOf = (name: string): Record<string, string> => {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL(`./fixtures/twilio/${name}`, import.meta.url), 'utf8'),
  );
  const params: unknown =
    typeof parsed === 'object' && parsed !== null && 'params' in parsed ? parsed.params : null;
  if (typeof params !== 'object' || params === null) throw new Error(`${name} has no params`);
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));
};

const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? { ...value } : {};

const ORIGIN = 'https://crm.example.test';
const MESSAGE = '0198a5d0-0000-7000-8000-000000000001';
const secrets = { authToken: 'fixture-auth-token', webhookToken: 'T'.repeat(43) };
const encode = (params: Record<string, string>) => new URLSearchParams(params).toString();

function statusRequest(
  params: Record<string, string> = paramsOf('status-callback.json'),
  signedWith = secrets,
  origin = ORIGIN,
): StoredSmsWebhook {
  const url = statusCallbackUrl(origin, signedWith.webhookToken, MESSAGE);
  return {
    endpoint: `status?m=${MESSAGE}`,
    headers: { 'x-twilio-signature': expectedSignature(signedWith.authToken, url, params) },
    body: Buffer.from(encode(params)),
  };
}

describe('verifying a stored webhook', () => {
  it('accepts a status callback signed with the connection’s Auth Token', () => {
    const verdict = verifySmsWebhook(statusRequest(), secrets, ORIGIN);
    expect(verdict).toMatchObject({
      valid: true,
      endpoint: { kind: 'status', messageId: MESSAGE },
    });
    expect(verdict.valid && statusCallbackOf(verdict.params)).toEqual({
      accountSid: `AC${'0'.repeat(31)}1`,
      messageSid: `SM${'0'.repeat(31)}1`,
      status: 'delivered',
      errorCode: null,
    });
  });

  it('accepts an inbound message signed for the inbound URL', () => {
    const params = paramsOf('inbound-message.json');
    const url = inboundWebhookUrl(ORIGIN, secrets.webhookToken);
    const verdict = verifySmsWebhook(
      {
        endpoint: 'inbound',
        headers: { 'x-twilio-signature': expectedSignature(secrets.authToken, url, params) },
        body: Buffer.from(encode(params)),
      },
      secrets,
      ORIGIN,
    );
    expect(verdict.valid && inboundSmsOf(verdict.params)).toEqual({
      accountSid: `AC${'0'.repeat(31)}1`,
      messageSid: `SM${'0'.repeat(31)}9`,
      from: '+15558675310',
      to: '+15017122661',
      body: 'STOP',
      optOutType: null,
    });
  });

  it('signs parameters it has never heard of, and accepts them', () => {
    const params = {
      ...paramsOf('status-callback.json'),
      BrandNewProperty: 'x y',
      RawDlrDoneDate: '2610091500',
    };
    expect(verifySmsWebhook(statusRequest(params), secrets, ORIGIN).valid).toBe(true);
  });

  const invalid = { valid: false, reason: 'invalid_signature' };

  it('refuses a request without a signature header', () => {
    const { headers: _headers, ...rest } = statusRequest();
    expect(verifySmsWebhook({ ...rest, headers: {} }, secrets, ORIGIN)).toEqual(invalid);
    expect(verifySmsWebhook({ ...rest, headers: null }, secrets, ORIGIN)).toEqual(invalid);
    expect(
      verifySmsWebhook({ ...rest, headers: { 'x-twilio-signature': ['a', 'b'] } }, secrets, ORIGIN),
    ).toEqual(invalid);
  });

  it('refuses a signature made with another token: another account, or a rotated one', () => {
    const other = { ...secrets, authToken: 'another-auth-token' };
    expect(verifySmsWebhook(statusRequest(undefined, other), secrets, ORIGIN)).toEqual(invalid);
  });

  it('refuses a body changed after signing: a status, an added or a removed parameter', () => {
    const signed = statusRequest();
    const params = paramsOf('status-callback.json');
    for (const changed of [
      { ...params, MessageStatus: 'failed' },
      { ...params, ErrorCode: '30003' },
      Object.fromEntries(Object.entries(params).filter(([name]) => name !== 'To')),
      { ...params, MessageSid: `SM${'0'.repeat(31)}2` },
    ])
      expect(
        verifySmsWebhook({ ...signed, body: Buffer.from(encode(changed)) }, secrets, ORIGIN),
      ).toEqual(invalid);
  });

  it('refuses a callback moved to another message or another connection', () => {
    const signed = statusRequest();
    expect(
      verifySmsWebhook(
        { ...signed, endpoint: 'status?m=0198a5d0-0000-7000-8000-000000000002' },
        secrets,
        ORIGIN,
      ),
    ).toEqual(invalid);
    expect(verifySmsWebhook({ ...signed, endpoint: 'inbound' }, secrets, ORIGIN)).toEqual(invalid);
    expect(verifySmsWebhook(signed, { ...secrets, webhookToken: 'U'.repeat(43) }, ORIGIN)).toEqual(
      invalid,
    );
  });

  it('checks against our own public address, whatever host the request claimed', () => {
    // Signed for another host: valid there, never here.
    const elsewhere = statusRequest(undefined, secrets, 'https://attacker.example');
    const claimed = {
      ...elsewhere,
      headers: {
        ...objectOf(elsewhere.headers),
        host: 'attacker.example',
        'x-forwarded-host': 'attacker.example',
      },
    };
    expect(verifySmsWebhook(claimed, secrets, ORIGIN)).toEqual(invalid);
    expect(verifySmsWebhook(claimed, secrets, 'https://attacker.example').valid).toBe(true);
  });

  it('refuses a body or an endpoint it cannot read exactly', () => {
    const signed = statusRequest();
    expect(verifySmsWebhook({ ...signed, body: Buffer.from('Body=%zz') }, secrets, ORIGIN)).toEqual(
      {
        valid: false,
        reason: 'malformed_body',
      },
    );
    expect(verifySmsWebhook({ ...signed, endpoint: 'status?m=x' }, secrets, ORIGIN)).toEqual({
      valid: false,
      reason: 'malformed_endpoint',
    });
  });

  it('keeps a value’s spaces: a trimmed body no longer verifies', () => {
    const params = { ...paramsOf('inbound-message.json'), Body: '  STOP  ' };
    const url = inboundWebhookUrl(ORIGIN, secrets.webhookToken);
    const headers = { 'x-twilio-signature': expectedSignature(secrets.authToken, url, params) };
    const stored = { endpoint: 'inbound', headers, body: Buffer.from(encode(params)) };
    const verdict = verifySmsWebhook(stored, secrets, ORIGIN);
    expect(verdict.valid && inboundSmsOf(verdict.params)?.body).toBe('  STOP  ');
    expect(
      verifySmsWebhook(
        { ...stored, body: Buffer.from(encode({ ...params, Body: 'STOP' })) },
        secrets,
        ORIGIN,
      ),
    ).toEqual(invalid);
  });
});

describe('reading a status callback', () => {
  const params = paramsOf('status-callback.json');

  it('reads the error code when there is one', () => {
    expect(
      statusCallbackOf({ ...params, MessageStatus: 'undelivered', ErrorCode: '30003' }),
    ).toMatchObject({ status: 'undelivered', errorCode: 30003 });
    expect(statusCallbackOf({ ...params, ErrorCode: 'abc' })?.errorCode).toBeNull();
    expect(statusCallbackOf({ ...params, ErrorCode: '0' })?.errorCode).toBeNull();
  });

  it('passes on a status it does not know, for the caller to ignore', () => {
    expect(statusCallbackOf({ ...params, MessageStatus: 'brand_new' })?.status).toBe('brand_new');
  });

  it.each([
    ['no account', { AccountSid: undefined }],
    ['a malformed account', { AccountSid: 'AC1' }],
    ['no message SID', { MessageSid: undefined }],
    ['a malformed message SID', { MessageSid: 'SM1' }],
    ['no status', { MessageStatus: undefined }],
    ['a repeated status', { MessageStatus: ['sent', 'delivered'] }],
  ])('reads nothing from a callback with %s', (_what, change) => {
    const changed = Object.fromEntries(
      Object.entries({ ...params, ...change }).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, value]],
      ),
    );
    expect(statusCallbackOf(changed)).toBeNull();
  });
});

describe('reading an inbound message', () => {
  const params = paramsOf('inbound-message.json');

  it('reads Twilio’s own opt-out verdict when it sent one', () => {
    expect(inboundSmsOf({ ...params, OptOutType: 'STOP' })?.optOutType).toBe('STOP');
  });

  it('reads a message without text as an empty body', () => {
    const { Body: _body, ...rest } = params;
    expect(inboundSmsOf(rest)?.body).toBe('');
  });

  it.each(['AccountSid', 'MessageSid', 'From', 'To'])('reads nothing without %s', (name) => {
    expect(
      inboundSmsOf(Object.fromEntries(Object.entries(params).filter(([key]) => key !== name))),
    ).toBeNull();
  });
});
