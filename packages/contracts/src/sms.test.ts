import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import * as publicContracts from './index.js';

import {
  connectSms,
  connectSmsInput,
  getSmsConnectionAttempt,
  listPhoneNumbers,
  listSmsConnections,
  listSmsProviderNumbers,
  phoneNumber,
  refreshSmsProviderNumbers,
  registerPhoneNumber,
  registerPhoneNumberInput,
  smsConnection,
  smsConnectionAttempt,
  smsConnectionList,
  smsConnectionStarted,
  smsProviderNumber,
} from './sms.js';

const UUID = '01890a5d-ac96-774b-bcce-b302099a8057';
it('exports SMS connection and number endpoints through the canonical contract package', () => {
  for (const endpoint of [
    connectSms,
    getSmsConnectionAttempt,
    listPhoneNumbers,
    listSmsConnections,
    listSmsProviderNumbers,
    refreshSmsProviderNumbers,
    registerPhoneNumber,
  ]) {
    expect(publicContracts).toHaveProperty(endpoint.operationId, endpoint);
  }
});
const ACCOUNT = `AC${'0'.repeat(31)}1`;
const NUMBER = `PN${'0'.repeat(31)}1`;
const input = {
  provider: 'twilio',
  label: 'Main account',
  accountSid: ACCOUNT,
  authToken: 'fixture-auth-token',
};
const attemptId = toPublicId('sms_attempt', UUID);
const connectionId = toPublicId('sms_connection', UUID);
const numberId = toPublicId('phone_number', UUID);
const at = '2026-10-09T01:00:00.000Z';

describe('connecting an SMS provider', () => {
  it('accepts an Account SID and Auth Token, with an optional API key', () => {
    expect(connectSmsInput.parse(input)).toEqual(input);
    const apiKey = { sid: `SK${'a'.repeat(32)}`, secret: 'fixture-key-secret' };
    expect(connectSmsInput.parse({ ...input, apiKey }).apiKey).toEqual(apiKey);
  });

  it.each([
    { ...input, provider: 'telnyx' },
    { ...input, accountSid: 'AC123' },
    { ...input, accountSid: `SK${'0'.repeat(32)}` },
    { ...input, accountSid: `${ACCOUNT}/../x` },
    { ...input, authToken: '' },
    { ...input, authToken: 'has space' },
    { ...input, authToken: 'line\nbreak' },
    { ...input, authToken: undefined },
    { ...input, label: '   ' },
    { ...input, apiKey: { sid: `SK${'a'.repeat(32)}` } },
    { ...input, apiKey: { sid: ACCOUNT, secret: 'x' } },
    // Nothing a request sends may choose where requests go or who owns the connection.
    { ...input, baseUrl: 'https://evil.example' },
    { ...input, host: 'evil.example' },
    { ...input, region: 'ie1' },
    { ...input, businessId: UUID },
    { ...input, webhookToken: 'chosen-by-the-caller' },
  ])('refuses invalid or request-controlled settings %#', (value) => {
    expect(connectSmsInput.safeParse(value).success).toBe(false);
  });

  it('marks both secrets write-only, and the Account SID not', () => {
    const text = JSON.stringify(z.toJSONSchema(connectSmsInput, { io: 'input' }));
    expect(text.match(/"writeOnly":true/g)?.length).toBe(2);
    const only = (field: 'accountSid' | 'authToken') =>
      JSON.stringify(z.toJSONSchema(connectSmsInput.shape[field], { io: 'input' }));
    expect(only('accountSid')).not.toContain('writeOnly');
    expect(only('authToken')).toContain('"writeOnly":true');
  });

  it("uses Twilio's own SID formats", () => {
    expect(JSON.stringify(z.toJSONSchema(connectSmsInput, { io: 'input' }))).toContain(
      '^AC[0-9a-fA-F]{32}$',
    );
    expect(JSON.stringify(z.toJSONSchema(smsProviderNumber))).toContain('^PN[0-9a-fA-F]{32}$');
  });
});

describe('connection attempts', () => {
  const pending = {
    id: attemptId,
    createdAt: at,
    status: 'pending',
    connectionId: null,
    result: null,
  };
  const result = {
    accountType: 'trial',
    accountStatus: 'active',
    subaccount: false,
    numbersFound: 2,
  };

  it('describes each state, and only that state', () => {
    expect(smsConnectionAttempt.safeParse(pending).success).toBe(true);
    expect(
      smsConnectionAttempt.safeParse({ ...pending, status: 'connected', connectionId, result })
        .success,
    ).toBe(true);
    expect(
      smsConnectionAttempt.safeParse({ ...pending, status: 'failed', failure: 'authentication' })
        .success,
    ).toBe(true);
    // A pending or failed attempt names no connection; a connected one must.
    expect(smsConnectionAttempt.safeParse({ ...pending, connectionId }).success).toBe(false);
    expect(
      smsConnectionAttempt.safeParse({
        ...pending,
        status: 'failed',
        failure: 'authentication',
        connectionId,
      }).success,
    ).toBe(false);
    expect(
      smsConnectionAttempt.safeParse({ ...pending, status: 'connected', result }).success,
    ).toBe(false);
    expect(
      smsConnectionAttempt.safeParse({ ...pending, status: 'failed', failure: 'because' }).success,
    ).toBe(false);
  });

  it('has no place for a secret', () => {
    for (const extra of [
      { authToken: 'x' },
      { secret: 'x' },
      { apiKey: {} },
      { webhookToken: 'x' },
    ])
      expect(smsConnectionAttempt.safeParse({ ...pending, ...extra }).success).toBe(false);
    expect(
      smsConnectionAttempt.safeParse({
        ...pending,
        status: 'connected',
        connectionId,
        result: { ...result, authToken: 'x' },
      }).success,
    ).toBe(false);
  });

  it('answers a new attempt with the inbound webhook address, or none', () => {
    expect(
      smsConnectionStarted.safeParse({
        attempt: pending,
        inboundWebhookUrl: 'https://crm.example.test/webhooks/twilio/token/inbound',
      }).success,
    ).toBe(true);
    expect(
      smsConnectionStarted.safeParse({ attempt: pending, inboundWebhookUrl: null }).success,
    ).toBe(true);
    expect(
      smsConnectionStarted.safeParse({ attempt: pending, inboundWebhookUrl: 'not a url' }).success,
    ).toBe(false);
  });
});

describe('connections and numbers', () => {
  const connection = {
    id: connectionId,
    provider: 'twilio',
    label: 'Main account',
    accountSid: ACCOUNT,
    status: 'connected',
    accountType: 'trial',
    accountStatus: 'active',
    warnings: ['trial_account'],
    lastCheckedAt: at,
    createdAt: at,
  };
  const number = {
    id: numberId,
    name: 'Front desk',
    e164: '+15017122661',
    connectionId,
    capabilities: ['sms', 'voice'],
    status: 'active',
    createdAt: at,
  };

  it('describe a connection without any credential', () => {
    expect(smsConnection.safeParse(connection).success).toBe(true);
    for (const extra of [{ authToken: 'x' }, { secretId: UUID }, { webhookDigest: 'x' }])
      expect(smsConnection.safeParse({ ...connection, ...extra }).success).toBe(false);
  });

  it('says with the list whether this install can send and receive text messages at all', () => {
    expect(smsConnectionList.parse({ data: [], unavailable: null })).toEqual({
      data: [],
      unavailable: null,
    });
    const unavailable = {
      code: 'public_address_unsuitable',
      message: 'Text messages need a secure public address.',
    };
    expect(smsConnectionList.parse({ data: [], unavailable })).toEqual({ data: [], unavailable });
    // Never left unsaid, and never a reason this version has no words for.
    expect(smsConnectionList.safeParse({ data: [] }).success).toBe(false);
    expect(
      smsConnectionList.safeParse({ data: [], unavailable: { ...unavailable, code: 'other' } })
        .success,
    ).toBe(false);
  });

  it('describe a listed provider number and a registered phone number', () => {
    const listed = {
      providerNumberRef: NUMBER,
      e164: '+15017122661',
      friendlyName: '(501) 712-2661',
      capabilities: ['sms'],
      registeredAs: null,
      seenAt: at,
    };
    expect(smsProviderNumber.safeParse(listed).success).toBe(true);
    expect(smsProviderNumber.safeParse({ ...listed, registeredAs: numberId }).success).toBe(true);
    expect(smsProviderNumber.safeParse({ ...listed, e164: '5017122661' }).success).toBe(false);
    expect(smsProviderNumber.safeParse({ ...listed, capabilities: ['fax'] }).success).toBe(false);
    expect(phoneNumber.safeParse(number).success).toBe(true);
    expect(phoneNumber.safeParse({ ...number, e164: '+0123' }).success).toBe(false);
  });

  it('registers a number by its provider reference, never by a typed number', () => {
    const register = { connectionId, providerNumberRef: NUMBER, name: 'Front desk' };
    expect(registerPhoneNumberInput.parse(register)).toEqual(register);
    for (const value of [
      { ...register, e164: '+15017122661' },
      { ...register, providerNumberRef: '+15017122661' },
      { ...register, connectionId: UUID },
      { ...register, connectionId: attemptId },
      { ...register, name: '' },
      { ...register, capabilities: ['sms'] },
    ])
      expect(registerPhoneNumberInput.safeParse(value).success).toBe(false);
  });
});

describe('endpoints', () => {
  const all = [
    connectSms,
    getSmsConnectionAttempt,
    listSmsConnections,
    listSmsProviderNumbers,
    refreshSmsProviderNumbers,
    registerPhoneNumber,
    listPhoneNumbers,
  ];

  it('registers SMS setup and number operations in the canonical API reference', () => {
    expect(
      publicContracts.endpoints
        .filter((endpoint) => endpoint.group === 'SMS')
        .map((endpoint) => endpoint.operationId)
        .sort(),
    ).toEqual(all.map((endpoint) => endpoint.operationId).sort());
  });

  it('have distinct operations and paths, in one group', () => {
    expect(new Set(all.map((each) => each.operationId)).size).toBe(all.length);
    expect(new Set(all.map((each) => `${each.method} ${each.path}`)).size).toBe(all.length);
    expect(new Set(all.map((each) => each.group))).toEqual(new Set(['SMS']));
  });

  it('offer no way to buy, release or reconfigure a number', () => {
    const methods: readonly string[] = all.map((each) => each.method);
    expect(methods.filter((each) => each !== 'get' && each !== 'post')).toEqual([]);
    expect(all.filter((each) => each.method === 'post').map((each) => each.operationId)).toEqual([
      'connectSms',
      'refreshSmsProviderNumbers',
      'registerPhoneNumber',
    ]);
  });
});
