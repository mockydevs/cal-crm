import { describe, expect, it } from 'vitest';

import { expectedSignature, type SignedParams } from '../twilio-signature.js';
import { advanceVoiceProgress, verifyVoiceProgress, type VoiceProgress } from './voice-progress.js';

const accountSid = `AC${'1'.repeat(32)}`;
const callSid = `CA${'2'.repeat(32)}`;
const token = 'synthetic-webhook-auth-token';
const url = 'https://crm.example.test/webhooks/voice/status?call=synthetic';
const params = {
  AccountSid: accountSid,
  CallSid: callSid,
  CallStatus: 'ringing',
  From: '+12025550101',
  To: '+12025550102',
  Direction: 'outbound-api',
  CallbackSource: 'call-progress-events',
  SequenceNumber: '1',
};
const request = (values: Record<string, string> = params) => {
  const body = Buffer.from(new URLSearchParams(values).toString());
  return { body, signature: expectedSignature(token, url, values) };
};
const verify = (values: Record<string, string> = params) => {
  const sent = request(values);
  return verifyVoiceProgress(sent.body, sent.signature, { authToken: token, url, accountSid });
};

describe('verified voice progress callbacks', () => {
  it('uses the exact trusted URL, raw form and existing signature verifier', () => {
    expect(verify()).toEqual({
      valid: true,
      progress: {
        accountSid,
        callSid,
        parentSid: null,
        status: 'ringing',
        sequence: 1,
        from: params.From,
        to: params.To,
        direction: 'outbound-api',
        durationSeconds: null,
      },
    });
  });

  it('reads initiated separately from REST resource statuses and seconds separately from billing minutes', () => {
    expect(verify({ ...params, CallStatus: 'initiated', SequenceNumber: '0' })).toMatchObject({
      valid: true,
      progress: { status: 'initiated', sequence: 0 },
    });
    expect(
      verify({ ...params, CallStatus: 'completed', CallDuration: '125', Duration: '3' }),
    ).toMatchObject({ valid: true, progress: { status: 'completed', durationSeconds: 125 } });
  });

  it('preserves parent leg identity and accepts signed future fields', () => {
    const parentSid = `CA${'3'.repeat(32)}`;
    expect(
      verify({ ...params, ParentCallSid: parentSid, FutureField: 'signed & preserved' }),
    ).toMatchObject({ valid: true, progress: { parentSid } });
  });

  it('rejects a valid signature from another account', () => {
    expect(verify({ ...params, AccountSid: `AC${'9'.repeat(32)}` })).toEqual({
      valid: false,
      reason: 'malformed_progress',
    });
  });

  it('rejects missing, forged or wrong-URL signatures', () => {
    const sent = request();
    for (const signature of [
      undefined,
      'forged',
      expectedSignature(token, 'https://evil.test/status', params),
    ]) {
      expect(
        verifyVoiceProgress(sent.body, signature, { authToken: token, url, accountSid }),
      ).toEqual({ valid: false, reason: 'invalid_signature' });
    }
  });

  it('rejects tampered raw form values and malformed encoding', () => {
    const sent = request();
    expect(
      verifyVoiceProgress(Buffer.from(`${sent.body.toString()}&Injected=1`), sent.signature, {
        authToken: token,
        url,
        accountSid,
      }),
    ).toMatchObject({ valid: false });
    expect(
      verifyVoiceProgress(Buffer.from('CallSid=%ZZ'), sent.signature, {
        authToken: token,
        url,
        accountSid,
      }),
    ).toEqual({ valid: false, reason: 'malformed_body' });
  });

  it('refuses missing verifier credentials and malformed configured URLs without throwing', () => {
    const sent = request();
    for (const trusted of [
      { authToken: '', url, accountSid },
      { authToken: token, url: 'not-a-url', accountSid },
    ]) {
      expect(verifyVoiceProgress(sent.body, sent.signature, trusted)).toEqual({
        valid: false,
        reason: 'invalid_signature',
      });
    }
  });

  it('rejects signed duplicate critical fields', () => {
    const repeated: SignedParams = { ...params, CallStatus: ['ringing', 'completed'] };
    const body = Buffer.from(`${new URLSearchParams(params).toString()}&CallStatus=completed`);
    const signature = expectedSignature(token, url, repeated);
    expect(verifyVoiceProgress(body, signature, { authToken: token, url, accountSid })).toEqual({
      valid: false,
      reason: 'malformed_progress',
    });
  });

  it.each([
    { CallStatus: 'invented' },
    { SequenceNumber: '-1' },
    { SequenceNumber: '1.2' },
    { SequenceNumber: '999999999999999999999' },
    { CallSid: 'invalid' },
    { ParentCallSid: 'invalid' },
    { Direction: 'invented' },
    { CallDuration: '-1' },
    { From: '' },
    { To: '' },
    { CallbackSource: 'inbound' },
  ])('rejects signed malformed progress %j', (change) => {
    expect(verify({ ...params, ...change })).toEqual({
      valid: false,
      reason: 'malformed_progress',
    });
  });
});

const progress = (status: VoiceProgress['status'], sequence: number): VoiceProgress => ({
  accountSid,
  callSid,
  status,
  sequence,
  parentSid: null,
  from: params.From,
  to: params.To,
  direction: 'outbound-api',
  durationSeconds: null,
});

describe('call progress ordering', () => {
  it('advances from first observation, including a terminal event arriving first', () => {
    expect(advanceVoiceProgress(null, progress('completed', 3))).toBe('advance');
    expect(advanceVoiceProgress(progress('ringing', 1), progress('in-progress', 2))).toBe(
      'advance',
    );
  });

  it('ignores duplicate and stale callbacks without reopening a finished call', () => {
    expect(advanceVoiceProgress(progress('completed', 3), progress('ringing', 1))).toBe('ignore');
    expect(advanceVoiceProgress(progress('ringing', 1), progress('ringing', 1))).toBe('ignore');
    expect(advanceVoiceProgress(progress('completed', 3), progress('ringing', 4))).toBe('ignore');
  });

  it('flags conflicting terminal outcomes, equal sequences and foreign identities', () => {
    expect(advanceVoiceProgress(progress('completed', 3), progress('failed', 4))).toBe('conflict');
    expect(advanceVoiceProgress(progress('ringing', 1), progress('completed', 1))).toBe('conflict');
    expect(
      advanceVoiceProgress(progress('ringing', 1), {
        ...progress('completed', 2),
        callSid: `CA${'4'.repeat(32)}`,
      }),
    ).toBe('conflict');
    expect(
      advanceVoiceProgress(progress('ringing', 1), {
        ...progress('completed', 2),
        accountSid: `AC${'4'.repeat(32)}`,
      }),
    ).toBe('conflict');
  });

  it('never regresses nonterminal state and permits later terminal metadata reconciliation', () => {
    expect(advanceVoiceProgress(progress('in-progress', 2), progress('ringing', 3))).toBe('ignore');
    expect(advanceVoiceProgress(progress('completed', 3), progress('completed', 4))).toBe(
      'advance',
    );
  });
});
