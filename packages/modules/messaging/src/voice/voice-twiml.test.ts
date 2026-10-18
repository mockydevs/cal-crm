import twilio from 'twilio';
import { describe, expect, it } from 'vitest';

import { renderCallConnect, renderDial, renderVoicemail, renderHangup } from './voice-twiml.js';

const action = 'https://crm.example.test/voice/next?call=test&step=1';
const progress = 'https://crm.example.test/voice/progress';
const recording = 'https://crm.example.test/voice/recording';
const dial = {
  destinations: [{ kind: 'number' as const, address: '+12025550101' }],
  actionUrl: action,
  progressUrl: progress,
  timeoutSeconds: 20,
  recording: { enabled: false as const },
};

describe('voice TwiML against the installed official SDK', () => {
  it('renders one callback-controlled Dial, matching SDK XML', () => {
    const expected = new twilio.twiml.VoiceResponse();
    const node = expected.dial({
      action,
      method: 'POST',
      timeout: 20,
      answerOnBridge: true,
      record: 'do-not-record',
    });
    node.number(
      {
        statusCallback: progress,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      },
      '+12025550101',
    );
    expect(renderDial(dial)).toBe(expected.toString());
  });

  it('rings multiple destinations together, and records only when explicitly enabled', () => {
    const result = renderDial({
      ...dial,
      destinations: [...dial.destinations, { kind: 'client', address: 'agent_test_1' }],
      recording: { enabled: true, statusCallback: recording },
      announcement: 'This call may be recorded.',
      callerId: '+12025550102',
    });
    expect(result).toContain('<Say>This call may be recorded.</Say>');
    expect(result).toContain('record="record-from-answer-dual"');
    expect(result).toContain(`recordingStatusCallback="${recording}"`);
    expect(result).toContain('recordingStatusCallbackEvent="completed absent"');
    expect(result).toContain('callerId="+12025550102"');
    expect(result).toContain('<Client ');
    expect(result).not.toContain('sequential="true"');
    expect(result.match(/<Dial /g)).toHaveLength(1);
  });

  it('puts optional call-connect instructions on the dialed leg only', () => {
    expect(
      renderDial({
        ...dial,
        destinations: [{ kind: 'number', address: '+12025550101', acceptUrl: action }],
      }),
    ).toContain('url="https://crm.example.test/voice/next?call=test&amp;step=1" method="POST"');
  });

  it("uses each destination's progressUrl override when set", () => {
    const customProgress = 'https://crm.example.test/voice/progress/custom';
    const xml = renderDial({
      ...dial,
      destinations: [
        { kind: 'number', address: '+12025550101', progressUrl: customProgress },
        { kind: 'client', address: 'agent_test_1' },
      ],
    });
    expect(xml).toContain(`statusCallback="${customProgress}"`);
    expect(xml).toContain(`statusCallback="${progress}"`);
  });

  it('escapes text and attribute data rather than interpreting markup', () => {
    const result = renderDial({ ...dial, announcement: 'Hello <Hangup/> & "goodbye"' });
    expect(result).toContain('&lt;Hangup/&gt; &amp; &quot;goodbye&quot;');
    expect(result).not.toContain('<Hangup/>');
  });

  it.each(['\u0000', '\u0001', '\ud800', '\ufffe'])(
    'rejects text that XML cannot represent: %j',
    (character) => {
      expect(() => renderDial({ ...dial, announcement: `Hello${character}friend` })).toThrow();
    },
  );

  it('preserves line breaks and valid international text', () => {
    expect(renderDial({ ...dial, announcement: 'Hello\n\t友達 🙂' })).toContain(
      '<Say>Hello\n\t友達 🙂</Say>',
    );
  });

  it.each([
    { ...dial, destinations: [] },
    { ...dial, timeoutSeconds: 4 },
    { ...dial, timeoutSeconds: 121 },
    { ...dial, destinations: [{ kind: 'number', address: 'not-a-number' }] },
    { ...dial, destinations: [{ kind: 'client', address: '<Hangup/>' }] },
    { ...dial, actionUrl: 'http://crm.example.test/next' },
    { ...dial, progressUrl: 'https://user:pass@crm.example.test/progress' },
    { ...dial, recording: { enabled: true } },
  ])('refuses invalid dial configuration %j', (invalid) => {
    expect(() => renderDial(invalid)).toThrow();
  });

  it('takes voicemail with its own completion/recording callbacks', () => {
    const xml = renderVoicemail({
      greeting: 'Please leave a message.',
      actionUrl: action,
      recordingUrl: recording,
      maxSeconds: 120,
    });
    expect(xml).toContain('<Say>Please leave a message.</Say>');
    expect(xml).toContain('<Record ');
    expect(xml).toContain('maxLength="120"');
    expect(xml).toContain('recordingStatusCallbackEvent="completed absent"');
    expect(xml).not.toContain('transcribe="true"');
  });

  it('plays a saved greeting through a protected media URL', () => {
    const xml = renderVoicemail({
      greeting: null,
      greetingAudioUrl: action,
      actionUrl: action,
      recordingUrl: recording,
      maxSeconds: 60,
    });
    expect(xml).toContain('<Play>https://crm.example.test/voice/next?call=test&amp;step=1</Play>');
    expect(xml).not.toContain('<Say>');
  });

  it('asks for acceptance and hangs up on silence rather than connecting voicemail', () => {
    const xml = renderCallConnect({
      prompt: 'Press 1 to accept.',
      actionUrl: action,
      requireConfirmation: true,
    });
    expect(xml).toContain('<Gather ');
    expect(xml).toContain('numDigits="1"');
    expect(xml).toContain('</Gather><Hangup/>');
    expect(
      renderCallConnect({
        prompt: 'Call from reception.',
        actionUrl: action,
        requireConfirmation: false,
      }),
    ).not.toContain('<Gather');
  });

  it('hangs up with the same output as the SDK', () => {
    const expected = new twilio.twiml.VoiceResponse();
    expected.hangup();
    expect(renderHangup()).toBe(expected.toString());
  });
});
