import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerVoiceWebhooks, type VoiceWebhookTransport } from './voice-webhooks.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const token = 'a'.repeat(43);
const headers = {
  'content-type': 'application/x-www-form-urlencoded',
  'x-twilio-signature': 'synthetic',
};
const payload = 'From=%2B12025550101&Custom=one&Custom=two';
const xml = '<Response><Hangup/></Response>';
const setup = async (handle: VoiceWebhookTransport['handle']) => {
  const app = Fastify();
  apps.push(app);
  app.post('/json', (request) => request.body);
  await registerVoiceWebhooks(app, { handle });
  return app;
};

describe('synchronous voice callback HTTP surface', () => {
  it.each(['inbound', 'progress', 'dial-result', 'accept', 'voicemail', 'recording'])(
    'passes exact bytes and canonical path for %s without trusting forwarded headers',
    async (kind) => {
      const handle = vi.fn<VoiceWebhookTransport['handle']>().mockResolvedValue({
        statusCode: 200,
        contentType: 'application/xml',
        body: xml,
      });
      const app = await setup(handle);
      const path = `/webhooks/twilio/voice/${token}/${kind}?step=12345678-1234-1234-1234-123456789abc`;
      const result = await app.inject({
        method: 'POST',
        url: path,
        headers: {
          ...headers,
          'x-forwarded-host': 'evil.test',
          authorization: 'private',
        },
        payload,
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe(xml);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.headers['referrer-policy']).toBe('no-referrer');
      expect(handle).toHaveBeenCalledExactlyOnceWith({
        path,
        body: Buffer.from(payload),
        signature: 'synthetic',
      });
    },
  );

  it('refuses unknown context and unsupported media before the handler', async () => {
    const handle = vi.fn<VoiceWebhookTransport['handle']>();
    const app = await setup(handle);
    const url = `/webhooks/twilio/voice/${token}/inbound`;
    expect(
      (await app.inject({ method: 'POST', url: `${url}?unknown=1`, headers, payload })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': 'application/json' },
          payload: '{}',
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (await app.inject({ method: 'POST', url, headers, payload: 'a'.repeat(65_537) })).statusCode,
    ).toBe(413);
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    expect(handle).not.toHaveBeenCalled();
  });

  it('does not change JSON parsing for unrelated API routes', async () => {
    const app = await setup(vi.fn());
    const result = await app.inject({ method: 'POST', url: '/json', payload: { value: 1 } });
    expect(result.json()).toEqual({ value: 1 });
  });

  it('refuses missing signatures and hides unexpected private failures', async () => {
    const handle = vi
      .fn<VoiceWebhookTransport['handle']>()
      .mockRejectedValue(new Error('private provider secret'));
    const app = await setup(handle);
    const url = `/webhooks/twilio/voice/${token}/inbound`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { 'content-type': headers['content-type'] },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(handle).not.toHaveBeenCalled();
    const result = await app.inject({ method: 'POST', url, headers, payload });
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain('private');
  });

  it('preserves an empty notification acknowledgement', async () => {
    const app = await setup(() =>
      Promise.resolve({ statusCode: 204, contentType: 'text/plain', body: '' }),
    );
    const result = await app.inject({
      method: 'POST',
      url: `/webhooks/twilio/voice/${token}/progress`,
      headers,
      payload,
    });
    expect(result.statusCode).toBe(204);
    expect(result.body).toBe('');
  });
});
