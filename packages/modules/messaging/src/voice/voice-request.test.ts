import { describe, expect, it } from 'vitest';
import { expectedSignature, type SignedParams } from '../twilio-signature.js';
import { verifyVoiceRequest } from './voice-request.js';

const accountSid = `AC${'1'.repeat(32)}`;
const callSid = `CA${'2'.repeat(32)}`;
const webhookToken = 'a'.repeat(43);
const trusted = {
  accountSid,
  webhookToken,
  authToken: 'synthetic',
  publicUrl: 'https://crm.example.test',
};
const path = `/webhooks/twilio/voice/${webhookToken}/inbound`;
const fields = {
  AccountSid: accountSid,
  CallSid: callSid,
  From: 'anonymous',
  To: '+12025550101',
  CallStatus: 'ringing',
  Direction: 'inbound',
  Future: ' signed + value ',
};
const signed = (params: SignedParams = fields, signedPath = path) => {
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    for (const item of typeof value === 'string' ? [value] : value) form.append(name, item);
  }
  return {
    path: signedPath,
    body: Buffer.from(form.toString()),
    signature: expectedSignature(trusted.authToken, trusted.publicUrl + signedPath, params),
  };
};

describe('voice request authentication before tenant effects', () => {
  it('authenticates recording notices without requiring TwiML-only envelope fields', () => {
    const recordingPath = path.replace('/inbound', '/recording');
    const params = {
      AccountSid: accountSid,
      CallSid: callSid,
      RecordingSid: `RE${'3'.repeat(32)}`,
      RecordingStatus: 'completed',
    };
    expect(verifyVoiceRequest(signed(params, recordingPath), trusted)).toMatchObject({
      valid: true,
      call: { accountSid, callSid },
    });
    expect(
      verifyVoiceRequest(
        signed({ ...params, AccountSid: `AC${'9'.repeat(32)}` }, recordingPath),
        trusted,
      ),
    ).toMatchObject({ valid: false });
    expect(
      verifyVoiceRequest(
        signed({ ...params, CallSid: [callSid, callSid] }, recordingPath),
        trusted,
      ),
    ).toMatchObject({ valid: false });
  });
  it('verifies all exact fields including future values and anonymous caller identities', () => {
    expect(verifyVoiceRequest(signed(), trusted)).toMatchObject({
      valid: true,
      target: { kind: 'inbound' },
      call: {
        accountSid,
        callSid,
        from: 'anonymous',
        to: fields.To,
        status: 'ringing',
        direction: 'inbound',
      },
      params: { Future: fields.Future },
    });
  });
  it('binds signatures to the canonical public origin and sealed capability', () => {
    expect(
      verifyVoiceRequest(signed(), { ...trusted, publicUrl: 'https://evil.test' }),
    ).toMatchObject({ valid: false });
    expect(
      verifyVoiceRequest(signed(), { ...trusted, webhookToken: 'b'.repeat(43) }),
    ).toMatchObject({ valid: false });
    expect(
      verifyVoiceRequest(signed(), { ...trusted, publicUrl: 'http://crm.example.test' }),
    ).toMatchObject({ valid: false });
  });
  it.each([
    { AccountSid: `AC${'9'.repeat(32)}` },
    { CallSid: 'bad' },
    { CallSid: [callSid, callSid] },
    { To: [fields.To, fields.To] },
    { CallStatus: 'invented' },
    { Direction: 'invented' },
    { From: '' },
  ])('refuses malformed or foreign call identity even when signed: %j', (changes) => {
    expect(verifyVoiceRequest(signed({ ...fields, ...changes }), trusted)).toMatchObject({
      valid: false,
    });
  });
  it('refuses changed bytes, missing signatures, malformed forms and unknown routes', () => {
    expect(verifyVoiceRequest({ ...signed(), signature: undefined }, trusted)).toMatchObject({
      valid: false,
    });
    expect(
      verifyVoiceRequest({ ...signed(), body: Buffer.from('bad=%zz') }, trusted),
    ).toMatchObject({ valid: false });
    expect(
      verifyVoiceRequest({ ...signed(), body: Buffer.from('AccountSid=forged') }, trusted),
    ).toMatchObject({ valid: false });
    expect(verifyVoiceRequest(signed(fields, path + '?unknown=1'), trusted)).toMatchObject({
      valid: false,
    });
    expect(verifyVoiceRequest(signed(), { ...trusted, authToken: '' })).toMatchObject({
      valid: false,
    });
  });
  it('keeps a signed stored route step without decoding alternate spellings', () => {
    const stepId = '12345678-1234-1234-1234-123456789abc';
    const actionPath = path.replace('/inbound', `/dial-result?step=${stepId}`);
    expect(verifyVoiceRequest(signed(fields, actionPath), trusted)).toMatchObject({
      valid: true,
      target: { kind: 'dial-result', stepId },
    });
  });
});
