import { describe, expect, it } from 'vitest';

import { connectStripeInput, stripeConnection, stripeEndpoints } from './stripe.js';

const KEY = `rk_live_${'A1b2'.repeat(6)}`;

describe('connecting a Stripe account', () => {
  it('takes a live or test restricted key', () => {
    expect(connectStripeInput.parse({ key: KEY }).key).toBe(KEY);
    expect(connectStripeInput.parse({ key: KEY.replace('rk_live_', 'rk_test_') }).key).toMatch(
      /^rk_test_/,
    );
  });

  it('refuses a secret key, saying which key to make instead', () => {
    const result = connectStripeInput.safeParse({ key: `sk_live_${'a'.repeat(24)}` });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'Use a restricted key with Checkout Sessions: Write and Webhook Endpoints: Write.',
    );
  });

  it('refuses a publishable key, a short key and anything else', () => {
    for (const key of [
      `pk_live_${'a'.repeat(24)}`,
      'rk_live_short',
      ' ',
      `rk_live_${'a'.repeat(24)} `,
    ])
      expect(connectStripeInput.safeParse({ key }).success).toBe(false);
  });

  it('takes nothing but the key', () => {
    expect(connectStripeInput.safeParse({ key: KEY, livemode: true }).success).toBe(false);
  });
});

describe('what the connection says', () => {
  it('never carries a key or a secret', () => {
    expect(Object.keys(stripeConnection.shape).sort()).toEqual([
      'connectedAt',
      'failure',
      'livemode',
      'status',
    ]);
  });

  it('says when no account is connected', () => {
    expect(
      stripeConnection.parse({
        status: 'not_connected',
        livemode: null,
        connectedAt: null,
        failure: null,
      }).status,
    ).toBe('not_connected');
  });
});

describe('the endpoints', () => {
  it('read, connect and disconnect at one address', () => {
    expect(stripeEndpoints.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'get /payments/stripe',
      'put /payments/stripe',
      'delete /payments/stripe',
    ]);
  });
});
