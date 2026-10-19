// A business's own Stripe account, for card payments on its invoices. The business pastes a
// restricted key (rk_live_… or rk_test_…) made in its Stripe Dashboard with two permissions,
// Checkout Sessions: Write and Webhook Endpoints: Write
// (https://docs.stripe.com/keys/restricted-api-keys.md). The key never comes back out.
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { timestamp } from './timestamps.js';

export const STRIPE_KEY = /^rk_(live|test)_[A-Za-z0-9]{16,247}$/;

const KEY_WORDS =
  'Use a restricted key with Checkout Sessions: Write and Webhook Endpoints: Write.';

export const connectStripeInput = z.strictObject({
  key: z.string().superRefine((key, context) => {
    if (!STRIPE_KEY.test(key)) context.addIssue({ code: 'custom', message: KEY_WORDS });
  }),
});
export type ConnectStripeInput = z.output<typeof connectStripeInput>;

export const stripeConnectionStatuses = [
  'not_connected',
  'connecting',
  'connected',
  'failed',
] as const;
export const stripeConnectionFailures = [
  'key_rejected',
  'missing_permission',
  'no_public_address',
  'provider_error',
] as const;

export const stripeConnection = z.object({
  status: z.enum(stripeConnectionStatuses),
  /** Test or live, from the key; null with no account connected. */
  livemode: z.boolean().nullable(),
  connectedAt: timestamp.nullable(),
  failure: z.enum(stripeConnectionFailures).nullable(),
});
export type StripeConnection = z.output<typeof stripeConnection>;

const group = 'Payment settings';

export const getStripeConnection = defineEndpoint({
  operationId: 'getStripeConnection',
  method: 'get',
  path: '/payments/stripe',
  summary: "Read whether the business's own Stripe account is connected for card payments",
  group,
  response: { status: 200, description: 'The connection.', schema: stripeConnection },
});
export const connectStripe = defineEndpoint({
  operationId: 'connectStripe',
  method: 'put',
  path: '/payments/stripe',
  summary: 'Connect the business’s own Stripe account with a restricted key, replacing any other',
  group,
  body: connectStripeInput,
  response: {
    status: 200,
    description: 'The connection, connecting while the webhook endpoint is made.',
    schema: stripeConnection,
  },
});
export const disconnectStripe = defineEndpoint({
  operationId: 'disconnectStripe',
  method: 'delete',
  path: '/payments/stripe',
  summary: 'Disconnect the Stripe account; its webhook endpoint is then deleted at Stripe',
  group,
  response: {
    status: 200,
    description: 'The connection: not connected.',
    schema: stripeConnection,
  },
});

export const stripeEndpoints = [getStripeConnection, connectStripe, disconnectStripe];
