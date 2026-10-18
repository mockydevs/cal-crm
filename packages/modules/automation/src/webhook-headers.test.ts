// A webhook.call step's own headers: sent with the request, never over the engine's own,
// refused when a value could end the header, and never in a result. Nothing here reaches a
// network: DNS and HTTPS are fakes.
import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';

import { describe, expect, it } from 'vitest';

import {
  callWebhook,
  redactWebhookUrl,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookHeaderValue,
  type WebhookRequester,
} from './webhook.js';
import { webhookHeaderValues } from './webhook-task.js';

// Made at run time, so no secret-looking literal sits in the source.
const KEY = ['fixture', 'header', 'value', '42'].join('-');

class FakeResponse extends EventEmitter {
  readonly statusCode = 200;
  readonly headers = {};
  destroy(): void {
    /* nothing to close */
  }
}

class FakeRequest extends EventEmitter {
  end(): void {
    setImmediate(() => {
      const response = new FakeResponse();
      this.emit('response', response);
      response.emit('end');
    });
  }
  destroy(): void {
    /* nothing to close */
  }
}

const send = async (headers: readonly WebhookHeaderValue[]) => {
  const calls: RequestOptions[] = [];
  const requester: WebhookRequester = (options) => {
    calls.push(options);
    return new FakeRequest();
  };
  const result = await callWebhook(
    { url: 'https://hooks.example.com/crm', method: 'POST' },
    { event: 'automation.webhook' },
    {
      secret: 'whsec_signing',
      headers,
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      requester,
    },
  );
  return { result, calls };
};

describe("a webhook step's headers", () => {
  it('are sent with the request, beside the engine’s own', async () => {
    const { result, calls } = await send([
      { name: 'Authorization', value: `Bearer ${KEY}` },
      { name: 'X-Customer', value: 'ada@example.com' },
    ]);
    expect(result.ok).toBe(true);
    expect(calls[0]?.headers).toMatchObject({
      Authorization: `Bearer ${KEY}`,
      'X-Customer': 'ada@example.com',
      'Content-Type': 'application/json',
    });
    expect(Object.keys(calls[0]?.headers ?? {})).toContain(WEBHOOK_SIGNATURE_HEADER);
    // The result says nothing of what was sent.
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it.each([
    ['a value with a line break', [{ name: 'X-Key', value: 'a\r\nX-Evil: 1' }]],
    ['a value outside Latin-1', [{ name: 'X-Key', value: 'snow ☃' }]],
    ['a header the engine sets', [{ name: 'content-type', value: 'text/plain' }]],
    ['the signature', [{ name: 'X-CRM-Signature', value: 'v1=0' }]],
    ['a name that is not a token', [{ name: 'X Key', value: 'x' }]],
    [
      'a header named twice',
      [
        { name: 'X-Key', value: 'a' },
        { name: 'x-key', value: 'b' },
      ],
    ],
  ])('refuse %s, without sending and without quoting the value', async (_case, headers) => {
    const { result, calls } = await send(headers);
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, code: 'invalid_header', retryable: false });
    expect(JSON.stringify(result)).not.toContain('X-Evil');
    expect(JSON.stringify(result)).not.toContain('☃');
  });
});

describe("a step's written header values", () => {
  const values = { 'contact.email': 'ada@example.com' };

  it('are filled in as the body is, and leave stored secrets out', () => {
    expect(
      webhookHeaderValues(
        [
          { name: 'Authorization', secret: 'crm_key' },
          { name: 'X-Customer', value: 'For {{contact.email}}' },
        ],
        values,
      ),
    ).toEqual({ ok: true, headers: [{ name: 'X-Customer', value: 'For ada@example.com' }] });
  });

  it('refuse the step when a merge field has no value', () => {
    expect(
      webhookHeaderValues([{ name: 'X-Customer', value: '{{contact.phone}}' }], values),
    ).toMatchObject({ ok: false, code: 'missing_values' });
  });

  it('are none when the step has no headers', () => {
    expect(webhookHeaderValues(undefined, values)).toEqual({ ok: true, headers: [] });
  });
});

describe("what a run's history shows of a webhook's address", () => {
  it('hides every query value and keeps the names', () => {
    expect(redactWebhookUrl('https://hooks.example.com/in?api_key=sk_live_1&list=a')).toBe(
      'https://hooks.example.com/in?api_key=redacted&list=redacted',
    );
  });

  it('leaves an address without a query string as written', () => {
    expect(redactWebhookUrl('https://hooks.example.com/in')).toBe('https://hooks.example.com/in');
  });
});
