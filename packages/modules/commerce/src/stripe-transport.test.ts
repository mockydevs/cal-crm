import { describe, expect, it } from 'vitest';

import {
  createCheckoutSession,
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
  it('allows webhook endpoints and Checkout Sessions, and nothing else', () => {
    expect(isAllowedStripeRequest('POST', '/v1/webhook_endpoints')).toBe(true);
    expect(isAllowedStripeRequest('POST', '/v1/checkout/sessions')).toBe(true);
    expect(isAllowedStripeRequest('POST', '/v1/checkout/sessions/cs_test_1/expire')).toBe(false);
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

const session = {
  id: 'cs_test_a11YYufWQzNY63zpQ6QSNRQhkUpVph4WRmzW0zWJO2znZKdVujZ0N0S22u',
  object: 'checkout.session',
  url: 'https://checkout.stripe.com/c/pay/cs_test_a11YYufWQzNY63zpQ6QSNRQhkUpVph4WRmzW0zWJO2znZKdVujZ0N0S22u#fid',
  expires_at: 1_679_686_615,
  livemode: false,
  amount_total: 1099,
  currency: 'usd',
  status: 'open',
  payment_status: 'unpaid',
};

const checkout = {
  currency: 'usd',
  unitAmount: '1099',
  name: 'Invoice INV-0042',
  reference: '0199a3f2-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
  successUrl: 'https://crm.example.com/d/token?paid=1',
  cancelUrl: 'https://crm.example.com/d/token',
  expiresAt: 1_679_686_615,
  integrationIdentifier: 'cal-crm-invoice-abcdefgh',
  idempotencyKey: 'cal-crm-checkout-0199a3f2',
};

describe('creating a Checkout Session', () => {
  it('sends one line for the balance, the return addresses and an idempotency key', async () => {
    const seen: Seen[] = [];
    const transport = createStripeTransport({ fetcher: fakeFetch(200, session, seen) });
    const result = await createCheckoutSession(transport, KEY, checkout);
    expect(result).toEqual({
      outcome: 'accepted',
      session: {
        id: session.id,
        url: session.url,
        expiresAt: new Date(1_679_686_615_000),
        livemode: false,
        amountTotal: 1099,
        currency: 'usd',
      },
    });
    const [call] = seen;
    expect(call?.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call?.init.method).toBe('POST');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('idempotency-key')).toBe(checkout.idempotencyKey);
    expect(headers.get('stripe-version')).toBe(STRIPE_API_VERSION);
    const form = new URLSearchParams(call?.init.body as string);
    expect([...form.entries()]).toEqual([
      ['mode', 'payment'],
      ['line_items[0][price_data][currency]', 'usd'],
      ['line_items[0][price_data][unit_amount]', '1099'],
      ['line_items[0][price_data][product_data][name]', 'Invoice INV-0042'],
      ['line_items[0][quantity]', '1'],
      ['client_reference_id', checkout.reference],
      ['metadata[checkout]', checkout.reference],
      ['success_url', checkout.successUrl],
      ['cancel_url', checkout.cancelUrl],
      ['expires_at', '1679686615'],
      ['integration_identifier', checkout.integrationIdentifier],
      ['submit_type', 'pay'],
    ]);
    expect(form.has('payment_method_types[]')).toBe(false);
  });

  it('refuses what Stripe could not charge, without calling it', async () => {
    const seen: Seen[] = [];
    const transport = createStripeTransport({ fetcher: fakeFetch(200, session, seen) });
    for (const changed of [
      { unitAmount: '0' },
      { unitAmount: '10.99' },
      { currency: 'USD' },
      { successUrl: 'http://crm.example.com/d/token' },
      { reference: 'x'.repeat(201) },
    ])
      expect(await createCheckoutSession(transport, KEY, { ...checkout, ...changed })).toEqual({
        outcome: 'rejected',
        reason: 'invalid',
        status: null,
      });
    expect(seen).toEqual([]);
  });

  it('maps a refused key and a missing permission, and treats a page elsewhere as unknown', async () => {
    const at = (status: number, body: unknown) =>
      createCheckoutSession(
        createStripeTransport({ fetcher: fakeFetch(status, body) }),
        KEY,
        checkout,
      );
    expect(await at(401, {})).toMatchObject({ outcome: 'rejected', reason: 'unauthorized' });
    expect(await at(403, {})).toMatchObject({ outcome: 'rejected', reason: 'forbidden' });
    expect(await at(400, {})).toMatchObject({ outcome: 'rejected', reason: 'refused' });
    expect(await at(500, {})).toEqual({ outcome: 'unknown' });
    expect(await at(200, { ...session, url: 'https://evil.example.com/pay' })).toEqual({
      outcome: 'unknown',
    });
  });
});
