// The IncomingPhoneNumber StatusCallback has no guaranteed SequenceNumber or
// CallbackSource. https://www.twilio.com/docs/voice/twiml#ending-the-call-callback-requests
import { describe, expect, it } from 'vitest';
import { parseVoiceTerminal } from './voice-terminal.js';

const accountSid = `AC${'1'.repeat(32)}`;
const params = {
  AccountSid: accountSid,
  CallSid: `CA${'2'.repeat(32)}`,
  From: 'anonymous',
  To: '+12025550101',
  Direction: 'inbound',
  CallStatus: 'completed',
  CallDuration: '12',
};
describe('signed inbound-number terminal parameters', () => {
  it.each(['completed', 'busy', 'failed', 'no-answer', 'canceled'])(
    'accepts terminal status %s without progress sequence fields',
    (status) => {
      expect(parseVoiceTerminal({ ...params, CallStatus: status }, accountSid)).toMatchObject({
        callSid: params.CallSid,
        status,
        durationSeconds: 12,
        from: 'anonymous',
        to: params.To,
      });
    },
  );
  it('preserves a missing duration without substituting billed minutes', () => {
    const { CallDuration: _duration, ...withoutDuration } = params;
    expect(parseVoiceTerminal({ ...withoutDuration, Duration: '99' }, accountSid)).toMatchObject({
      durationSeconds: null,
    });
  });
  it.each(['queued', 'initiated', 'ringing', 'in-progress', 'unknown'])(
    'refuses nonterminal status %s',
    (status) => {
      expect(parseVoiceTerminal({ ...params, CallStatus: status }, accountSid)).toBeNull();
    },
  );
  it('refuses another account, an outbound call, malformed ids and duplicate critical fields', () => {
    for (const patch of [
      { AccountSid: `AC${'3'.repeat(32)}` },
      { Direction: 'outbound-api' },
      { CallSid: 'invalid' },
      { CallStatus: ['completed', 'completed'] },
      { CallDuration: ['12', '12'] },
      { From: '' },
      { To: '' },
      { CallDuration: '-1' },
      { CallDuration: '1.5' },
      { CallDuration: '1000000000' },
    ]) {
      expect(parseVoiceTerminal({ ...params, ...patch }, accountSid)).toBeNull();
    }
  });
});
