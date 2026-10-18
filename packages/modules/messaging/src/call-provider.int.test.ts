import { randomBytes, randomUUID } from 'node:crypto';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { EndedCall, PlacedCall } from './call-ledger.js';
import { createTwilioCallProvider } from './call-provider.js';
import { SMS_CREDENTIALS } from './sms-connect.js';
import { newWebhookToken } from './sms-webhook-url.js';
import type { TwilioResponse } from './twilio-api.js';
import type { VoiceTransport } from './voice/twilio-voice.js';
import { voiceIdentity } from './voice/voice-identity.js';
import { VOICE_SIGNING_KEY } from './voice-setup.js';

type VoiceRequest = Parameters<VoiceTransport>[0];

let database: TestDatabase;
let db: Database;
let vault: Vault;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const hex = (length: number) => randomBytes(length / 2).toString('hex');
const publicUrl = 'https://crm.example.test';

function twilioCallResponse(accountSid: string, sid: string, status = 'queued') {
  return JSON.stringify({
    sid,
    account_sid: accountSid,
    parent_call_sid: null,
    status,
    from: '+12025550100',
    to: '+14155550199',
    duration: null,
  });
}

async function fixture(
  setupStatus: 'ready' | 'requested' | 'creating' | 'failed' | 'unknown' = 'ready',
  connectionStatus: 'connected' | 'disconnected' = 'connected',
) {
  const agency = await database.fixtures.agency();
  const tenant = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const accountSid = `AC${hex(32)}`;
  const key = { sid: `SK${hex(32)}`, secret: hex(32), type: 'standard' as const };
  const webhookToken = newWebhookToken();
  const authToken = hex(32);
  const fromNumber = '+12025550100';

  const { connectionId, keySecretId } = await withTenant(db, tenant.context, async (trx) => {
    const credentials = await vault.store(
      trx,
      { agencyId: agency.id, businessId: tenant.id, purpose: SMS_CREDENTIALS },
      JSON.stringify({ accountSid, authToken, webhookToken }),
    );
    const connection = await trx
      .insertInto('messaging.provider_connections')
      .values({
        agency_id: agency.id,
        business_id: tenant.id,
        provider: 'twilio',
        label: 'Front desk',
        account_ref: accountSid,
        secret_id: credentials,
        status: connectionStatus,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const keySecret = await vault.store(
      trx,
      { agencyId: agency.id, businessId: tenant.id, purpose: VOICE_SIGNING_KEY },
      JSON.stringify(key),
    );
    const isReady = setupStatus === 'ready';
    await trx
      .insertInto('messaging.voice_setups')
      .values({
        business_id: tenant.id,
        connection_id: connection.id,
        status: setupStatus,
        key_sid: isReady ? key.sid : null,
        secret_id: isReady ? keySecret : null,
        failure_code: setupStatus === 'failed' ? 'connection_unavailable' : null,
        finished_at: setupStatus === 'requested' || setupStatus === 'creating' ? null : new Date(),
      })
      .execute();
    return { connectionId: connection.id, keySecretId: keySecret };
  });

  const identity = voiceIdentity(tenant.id, user.id);
  const placedCall: PlacedCall = {
    callId: randomUUID(),
    legId: randomUUID(),
    remoteLegId: randomUUID(),
    connectionId,
    from: fromNumber,
    to: '+14155550199',
    userId: user.id,
    identity,
  };

  return {
    agency,
    tenant,
    user,
    accountSid,
    key,
    webhookToken,
    connectionId,
    keySecretId,
    placedCall,
  };
}

describe('call provider port', () => {
  it('places a call with expected Basic auth, callbacks, and TwiML dial instructions', async () => {
    const f = await fixture();
    const callSid = `CA${hex(32)}`;
    const requests: VoiceRequest[] = [];
    const transport: VoiceTransport = (req) => {
      requests.push(req);
      return Promise.resolve({
        status: 201,
        body: twilioCallResponse(f.accountSid, callSid, 'queued'),
      });
    };
    const provider = createTwilioCallProvider({ db, vault, transport, publicUrl });
    const result = await provider.place(f.placedCall, f.tenant.context);

    expect(result).toEqual({ outcome: 'accepted', providerCallId: callSid, status: 'queued' });
    expect(requests).toHaveLength(1);
    const [req] = requests;
    if (req === undefined) throw new Error('Missing request');
    expect(req.method).toBe('POST');
    expect(req.path).toBe(`/2010-04-01/Accounts/${f.accountSid}/Calls.json`);
    const expectedAuth = 'Basic ' + Buffer.from(`${f.key.sid}:${f.key.secret}`).toString('base64');
    expect(req.headers['authorization']).toBe(expectedAuth);

    const params = new URLSearchParams(req.body ?? '');
    expect(params.get('To')).toBe(`client:${f.placedCall.identity}`);
    expect(params.get('From')).toBe(f.placedCall.from);
    expect(params.get('Timeout')).toBe('30');
    expect(params.get('StatusCallback')).toBe(
      `https://crm.example.test/webhooks/twilio/voice/${f.webhookToken}/progress?step=${f.placedCall.legId}`,
    );
    expect(params.getAll('StatusCallbackEvent')).toEqual([
      'initiated',
      'ringing',
      'answered',
      'completed',
    ]);

    const twiml = params.get('Twiml') ?? '';
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain(
      `action="https://crm.example.test/webhooks/twilio/voice/${f.webhookToken}/dial-result?step=${f.placedCall.legId}"`,
    );
    expect(twiml).toContain('timeout="30"');
    expect(twiml).toContain('answerOnBridge="true"');
    expect(twiml).toContain('record="do-not-record"');
    expect(twiml).toContain(`callerId="${f.placedCall.from}"`);
    expect(twiml).toContain(
      `<Number statusCallback="https://crm.example.test/webhooks/twilio/voice/${f.webhookToken}/progress?step=${f.placedCall.remoteLegId}" statusCallbackMethod="POST" statusCallbackEvent="initiated ringing answered completed">${f.placedCall.to}</Number>`,
    );
  });

  it('translates provider errors into rejected with code or unknown outcomes', async () => {
    const f = await fixture();
    let currentResponse: TwilioResponse | 'throw';
    const transport: VoiceTransport = () => {
      if (currentResponse === 'throw')
        return Promise.reject(new Error('Transport network failure'));
      return Promise.resolve(currentResponse);
    };
    const provider = createTwilioCallProvider({ db, vault, transport, publicUrl });

    currentResponse = {
      status: 400,
      body: JSON.stringify({ code: 21215, message: 'Invalid number' }),
    };
    expect(await provider.place(f.placedCall, f.tenant.context)).toEqual({
      outcome: 'rejected',
      code: 21215,
    });

    currentResponse = 'throw';
    expect(await provider.place(f.placedCall, f.tenant.context)).toEqual({ outcome: 'unknown' });

    currentResponse = { status: 502, body: 'Bad Gateway' };
    expect(await provider.place(f.placedCall, f.tenant.context)).toEqual({ outcome: 'unknown' });
  });

  it('rejects without any request when connection or credentials are unready', async () => {
    const requests: VoiceRequest[] = [];
    const transport: VoiceTransport = (req) => {
      requests.push(req);
      return Promise.resolve({ status: 201, body: '{}' });
    };

    const notReady = await fixture('requested', 'connected');
    const p1 = createTwilioCallProvider({ db, vault, transport, publicUrl });
    expect(await p1.place(notReady.placedCall, notReady.tenant.context)).toEqual({
      outcome: 'rejected',
      code: null,
    });

    const disconnected = await fixture('ready', 'disconnected');
    expect(await p1.place(disconnected.placedCall, disconnected.tenant.context)).toEqual({
      outcome: 'rejected',
      code: null,
    });

    const brokenKey = await fixture('ready', 'connected');
    await withTenant(db, brokenKey.tenant.context, async (trx) => {
      await vault.replace(trx, brokenKey.keySecretId, '{"sid":"nope"}');
    });
    expect(await p1.place(brokenKey.placedCall, brokenKey.tenant.context)).toEqual({
      outcome: 'rejected',
      code: null,
    });

    const f = await fixture();
    const insecureProvider = createTwilioCallProvider({
      db,
      vault,
      transport,
      publicUrl: 'http://crm.example.test',
    });
    expect(await insecureProvider.place(f.placedCall, f.tenant.context)).toEqual({
      outcome: 'rejected',
      code: null,
    });

    expect(requests).toHaveLength(0);
  });

  it('ends a call by posting Status to the provider call resource', async () => {
    const f = await fixture();
    const callSid = `CA${hex(32)}`;
    const requests: VoiceRequest[] = [];
    const transport: VoiceTransport = (req) => {
      requests.push(req);
      return Promise.resolve({
        status: 200,
        body: twilioCallResponse(f.accountSid, callSid, 'completed'),
      });
    };
    const provider = createTwilioCallProvider({ db, vault, transport, publicUrl });
    const endedCall: EndedCall = {
      callId: f.placedCall.callId,
      connectionId: f.connectionId,
      providerCallId: callSid,
      status: 'completed',
    };

    const result = await provider.end(endedCall, f.tenant.context);
    expect(result).toEqual({ outcome: 'accepted', providerCallId: callSid, status: 'completed' });
    expect(requests).toHaveLength(1);
    const [req] = requests;
    if (req === undefined) throw new Error('Missing request');
    expect(req.method).toBe('POST');
    expect(req.path).toBe(`/2010-04-01/Accounts/${f.accountSid}/Calls/${callSid}.json`);
    expect(req.headers['authorization']).toBe(
      'Basic ' + Buffer.from(`${f.key.sid}:${f.key.secret}`).toString('base64'),
    );
    expect(new URLSearchParams(req.body ?? '').get('Status')).toBe('completed');
  });

  it('rejects without request when called with another business context', async () => {
    const f = await fixture();
    const otherTenant = await database.fixtures.business(f.agency.id);
    const requests: VoiceRequest[] = [];
    const transport: VoiceTransport = (req) => {
      requests.push(req);
      return Promise.resolve({ status: 201, body: '{}' });
    };
    const provider = createTwilioCallProvider({ db, vault, transport, publicUrl });
    const result = await provider.place(f.placedCall, otherTenant.context);

    expect(result).toEqual({ outcome: 'rejected', code: null });
    expect(requests).toHaveLength(0);
  });
});
