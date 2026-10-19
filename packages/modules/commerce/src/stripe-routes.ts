// The API's routes for the business's own Stripe account. Reading whether it is connected takes
// payments.read; connecting and disconnecting are commands that take payments.manage. The routes
// are given the sealing vault, so the API seals the key and never opens it.
import { requireBusiness, runCommand, type ApiRoute, type Route } from '@repo/commands';
import { connectStripe, disconnectStripe, getStripeConnection } from '@repo/contracts';
import { withTenant } from '@repo/db';

import { requireRead, type CommerceOptions } from './shared.js';
import {
  createConnectStripeCommand,
  createDisconnectStripeCommand,
  readStripeConnection,
  type StripeSealing,
} from './stripe-connect.js';

export function createStripeRoutes(
  options: CommerceOptions,
  vault: StripeSealing,
): readonly ApiRoute[] {
  const connect = createConnectStripeCommand(options, vault);
  const disconnect = createDisconnectStripeCommand(options, vault);

  const read = {
    endpoint: getStripeConnection,
    async run({ invocation }, services) {
      await requireRead(services, invocation, 'stripe_connection.read');
      const businessId = requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, (trx) =>
        readStripeConnection(trx, businessId),
      );
    },
  } satisfies Route<typeof getStripeConnection>;

  const put = {
    endpoint: connectStripe,
    command: connect,
    run: ({ invocation, body }, services) => runCommand(services, connect, body, invocation),
  } satisfies Route<typeof connectStripe>;

  const remove = {
    endpoint: disconnectStripe,
    command: disconnect,
    run: ({ invocation }, services) => runCommand(services, disconnect, {}, invocation),
  } satisfies Route<typeof disconnectStripe>;

  return [read, put, remove];
}
