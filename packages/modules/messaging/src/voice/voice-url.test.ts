import { describe, expect, it } from 'vitest';

import { parseVoiceCallbackPath, voiceWebhookUrl, voiceWebhookKinds } from './voice-url.js';

const token = 'a'.repeat(43);
const step = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('canonical voice callback URLs', () => {
  it.each(voiceWebhookKinds)('round trips %s with a canonical root path', (kind) => {
    const url = voiceWebhookUrl('https://crm.example.test/b/business', token, { kind });
    expect(url).toBe(`https://crm.example.test/webhooks/twilio/voice/${token}/${kind}`);
    expect(parseVoiceCallbackPath(new URL(url ?? '').pathname)).toEqual({ token, kind });
  });

  it('signs route-step context as an exact query, not a fragment or forwarded host', () => {
    const url = voiceWebhookUrl('https://crm.example.test', token, {
      kind: 'dial-result',
      stepId: step,
    });
    expect(url).toBe(
      `https://crm.example.test/webhooks/twilio/voice/${token}/dial-result?step=${step}`,
    );
    expect(
      parseVoiceCallbackPath(`/webhooks/twilio/voice/${token}/dial-result?step=${step}`),
    ).toEqual({ token, kind: 'dial-result', stepId: step });
  });

  it.each([
    'http://crm.test',
    'https://user:password@crm.test',
    'https://bad_host.test',
    'not-a-url',
  ])('refuses an unsuitable public origin %s', (origin) => {
    expect(voiceWebhookUrl(origin, token, { kind: 'inbound' })).toBeNull();
  });

  it('refuses invalid capability and step identifiers', () => {
    expect(voiceWebhookUrl('https://crm.test', '../foreign', { kind: 'inbound' })).toBeNull();
    expect(
      voiceWebhookUrl('https://crm.test', token, { kind: 'accept', stepId: '../foreign' }),
    ).toBeNull();
  });

  it.each([
    `/webhooks/twilio/voice/${token}/purchase`,
    `/webhooks/twilio/voice/${token}/../inbound`,
    `/webhooks/twilio/voice/${token}/inbound#fragment`,
    `/webhooks/twilio/voice/${token}/inbound?extra=1`,
    `/webhooks/twilio/voice/${token}/accept?step=${step}&step=${step}`,
    `/webhooks/twilio/voice/${token}/accept?step=invalid`,
    `/webhooks/twilio/voice/short/inbound`,
    `https://evil.test/webhooks/twilio/voice/${token}/inbound`,
  ])('rejects malformed or ambiguous raw paths: %s', (path) => {
    expect(parseVoiceCallbackPath(path)).toBeNull();
  });
});
