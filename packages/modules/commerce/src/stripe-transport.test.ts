import { describe, expect, it } from 'vitest';

import {
  createStripeTransport,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  isAllowedStripeRequest,
  STRIPE_API_VERSION,
} from './stripe-transport.js';

const KEY = `rk_test_${'a'.repeat(24)}`;

interface Seen {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(status: number, body: unknown, seen: Seen[] = []): typeof fetch {
  return ((url: URL | string, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

const endpoint = {
  id: 'we_1Mr5jULkdIwHu7ix1ibLTM0x',
  object: 'webhook_endpoint',
  livemode: false,
  status: 'enabled',
  secret: 'whsec_wRNftLajMZNeslQOP6vEPm4iVx5NlZ6z',
  url: 'https://crm.example.com/webhooks/stripe/token',
};

describe('the requests it allows', () => {
  it('allows creating and deleting webhook endpoints, and nothing else', () => {
    expect(isAllowedStripeRequest('POST', '/v1/webhook_endpoints')).toBe(true);
    expect(isAllowedStripeRequest('DELETE', `/v1/webhook_endpoints/${endpoint.id}`)).toBe(true);
    expect(isAllowedStripeRequest('GET', '/v1/webhook_endpoints')).toBe(false);
    expect(isAllowedStripeRequest('POST', '/v1/charges')).toBe(false);
    expect(isAllowedStripeRequest('DELETE', '/v1/webhook_endpoints/../customers')).toBe(false);
  });

  it('refuses a request outside the allowlist without calling Stripe', async () => {
    const seen: Seen[] = [];
    const transport = createStripeTransport({ fetcher: fakeFetch(200, {}, seen) });
    await expect(
      transport({ method: 'POST', path: '/v1/charges', key: KEY, form: new URLSearchParams() }),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

describe('creating a webhook endpoint', () => {
  it('sends the url, the three Checkout events, the API version and an idempotency key', async () => {
    const seen: Seen[] = [];
    const transport = createStripeTransport({ fetcher: fakeFetch(200, endpoint, seen) });
    const result = await createWebhookEndpoint(transport, KEY, {
      url: endpoint.url,
      idempotencyKey: 'cal-crm-webhook-abc',
    });
    expect(result).toEqual({
      outcome: 'accepted',
      endpoint: { id: endpoint.id, livemode: false, secret: endpoint.secret },
    });
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call?.url).toBe('https://api.stripe.com/v1/webhook_endpoints');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers.get('stripe-version')).toBe(STRIPE_API_VERSION);
    expect(headers.get('idempotency-key')).toBe('cal-crm-webhook-abc');
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call?.init.body as string);
    expect(form.get('url')).toBe(endpoint.url);
    expect(form.getAll('enabled_events[]')).toEqual([
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.async_payment_failed',
    ]);
    expect(form.get('api_version')).toBe(STRIPE_API_VERSION);
    expect(form.get('description')).toBe('Cal CRM invoice payments');
  });

  it('says a key Stripe refuses is rejected as unauthorized', async () => {
    const transport = createStripeTransport({
      fetcher: fakeFetch(401, {
        error: { type: 'invalid_request_error', message: 'Invalid API Key' },
      }),
    });
    expect(
      await createWebhookEndpoint(transport, KEY, { url: endpoint.url, idempotencyKey: 'k' }),
    ).toEqual({ outcome: 'rejected', reason: 'unauthorized', status: 401 });
  });

  it('says a key without the permission is rejected as forbidden', async () => {
    const transport = createStripeTransport({
      fetcher: fakeFetch(403, { error: { type: 'invalid_request_error' } }),
    });
    expect(
      await createWebhookEndpoint(transport, KEY, { url: endpoint.url, idempotencyKey: 'k' }),
    ).toEqual({ outcome: 'rejected', reason: 'forbidden', status: 403 });
  });

  it('treats rate limits and Stripe server errors as unknown, to be retried', async () => {
    for (const status of [429, 500, 503]) {
      const transport = createStripeTransport({ fetcher: fakeFetch(status, {}) });
      expect(
        await createWebhookEndpoint(transport, KEY, { url: endpoint.url, idempotencyKey: 'k' }),
      ).toEqual({ outcome: 'unknown' });
    }
  });

  it('treats a lost connection as unknown', async () => {
    const transport = createStripeTransport({
      fetcher: () => Promise.reject(new TypeError('network')),
    });
    expect(
      await createWebhookEndpoint(transport, KEY, { url: endpoint.url, idempotencyKey: 'k' }),
    ).toEqual({ outcome: 'unknown' });
  });

  it('refuses an answer without a signing secret', async () => {
    const transport = createStripeTransport({
      fetcher: fakeFetch(200, { ...endpoint, secret: undefined }),
    });
    expect(
      await createWebhookEndpoint(transport, KEY, { url: endpoint.url, idempotencyKey: 'k' }),
    ).toEqual({ outcome: 'unknown' });
  });

  it('never sends a malformed key or a non-https address', async () => {
    const seen: Seen[] = [];
    const transport = createStripeTransport({ fetcher: fakeFetch(200, endpoint, seen) });
    expect(
      await createWebhookEndpoint(transport, 'sk_test_abc', {
        url: endpoint.url,
        idempotencyKey: 'k',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'invalid', status: null });
    expect(
      await createWebhookEndpoint(transport, KEY, {
        url: 'http://insecure.test/x',
        idempotencyKey: 'k',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'invalid', status: null });
    expect(seen).toEqual([]);
  });
});

describe('deleting a webhook endpoint', () => {
  it('deletes it by id, and counts one Stripe no longer has as deleted', async () => {
    const seen: Seen[] = [];
    const deleted = createStripeTransport({
      fetcher: fakeFetch(200, { id: endpoint.id, deleted: true }, seen),
    });
    expect(await deleteWebhookEndpoint(deleted, KEY, endpoint.id)).toEqual({ outcome: 'deleted' });
    expect(seen[0]?.url).toBe(`https://api.stripe.com/v1/webhook_endpoints/${endpoint.id}`);
    expect(seen[0]?.init.method).toBe('DELETE');
    expect(new Headers(seen[0]?.init.headers).get('idempotency-key')).toBeNull();
    const gone = createStripeTransport({
      fetcher: fakeFetch(404, { error: { type: 'invalid_request_error' } }),
    });
    expect(await deleteWebhookEndpoint(gone, KEY, endpoint.id)).toEqual({ outcome: 'deleted' });
  });

  it('never calls Stripe for a malformed endpoint id', async () => {
    const seen: Seen[] = [];
    const transport = createStripeTransport({ fetcher: fakeFetch(200, {}, seen) });
    expect(await deleteWebhookEndpoint(transport, KEY, '../customers')).toEqual({
      outcome: 'rejected',
      reason: 'invalid',
      status: null,
    });
    expect(seen).toEqual([]);
  });
});
