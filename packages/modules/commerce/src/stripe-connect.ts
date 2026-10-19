// A business's own Stripe account for card payments on its invoices. The business pastes a
// restricted key; the worker makes the webhook endpoint on that account and keeps its signing
// secret. The key, the capability token in this install's webhook address and the signing secret
// are sealed in the vault; only the token's digest is kept, to route what Stripe sends back.
//
// Disconnecting, or connecting another account, takes the old connection away at once and leaves
// its endpoint and key in commerce.stripe_endpoint_removals for the worker, which deletes the
// endpoint at Stripe with that key, then the key. A connection still being set up can't be changed
// until it has finished, so no setup can make an endpoint for a key that was already replaced.
import { createHash, randomBytes } from 'node:crypto';

import {
  defineCommand,
  requireBusiness,
  defineTask,
  type Command,
  type CommandContext,
  type Task,
  type TaskReference,
} from '@repo/commands';
import { connectStripeInput, type StripeConnection } from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ConflictError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';

import { heldBusiness, MANAGE, type CommerceOptions } from './shared.js';
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  type StripeTransport,
} from './stripe-transport.js';

/** The vault, as Stripe's connection uses it: the worker alone opens what is sealed. */
export interface StripeVault {
  store(
    trx: DatabaseTransaction,
    owner: {
      readonly agencyId: string;
      readonly businessId: string | null;
      readonly purpose: string;
    },
    plaintext: string,
  ): Promise<string>;
  read(trx: DatabaseTransaction, secretId: string, purpose: string): Promise<string>;
  remove(trx: DatabaseTransaction, secretId: string): Promise<void>;
}

/** How long a setup may run before the connection can be changed anyway. */
const STUCK_SETUP_MS = 10 * 60 * 1000;

/** What the API's commands need: they seal and remove, never open. */
export type StripeSealing = Pick<StripeVault, 'store' | 'remove'>;

export const STRIPE_KEY_PURPOSE = 'commerce.stripe.key';
export const STRIPE_WEBHOOK_TOKEN_PURPOSE = 'commerce.stripe.webhook_token';
export const STRIPE_WEBHOOK_SECRET_PURPOSE = 'commerce.stripe.webhook_secret';

/** Where Stripe posts this connection's events on this install. */
export const stripeWebhookPath = (token: string): string => `/webhooks/stripe/${token}`;
export const stripeWebhookDigest = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const setUpStripeReference = {
  name: 'commerce.set_up_stripe',
  data: z.strictObject({ digest: z.string().regex(/^[0-9a-f]{64}$/) }),
} satisfies TaskReference<z.ZodType>;
export const removeStripeEndpointsReference = {
  name: 'commerce.remove_stripe_endpoints',
  data: z.strictObject({}),
} satisfies TaskReference<z.ZodType>;

interface ConnectionRow {
  readonly status: string;
  readonly livemode: boolean;
  readonly key_secret_id: string;
  readonly webhook_token_secret_id: string;
  readonly webhook_digest: string;
  readonly webhook_endpoint_id: string | null;
  readonly webhook_secret_id: string | null;
  readonly failure: string | null;
  readonly connected_at: Date | null;
  readonly created_at: Date;
}

const notConnected: StripeConnection = {
  status: 'not_connected',
  livemode: null,
  connectedAt: null,
  failure: null,
};

function present(row: ConnectionRow | undefined): StripeConnection {
  if (row === undefined) return notConnected;
  const status = row.status === 'connected' || row.status === 'failed' ? row.status : 'connecting';
  const failure =
    row.failure === 'key_rejected' ||
    row.failure === 'missing_permission' ||
    row.failure === 'no_public_address' ||
    row.failure === 'provider_error'
      ? row.failure
      : null;
  return {
    status,
    livemode: row.livemode,
    connectedAt: row.connected_at?.toISOString() ?? null,
    failure,
  };
}

async function lockedConnection(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<ConnectionRow | undefined> {
  return trx
    .selectFrom('commerce.stripe_connections')
    .selectAll()
    .where('business_id', '=', businessId)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Takes a connection away: its endpoint and key wait for the worker to delete them at Stripe,
 * and the secrets only this install used go now. A connection with no endpoint yet (it failed
 * before Stripe made one) leaves nothing at Stripe, so its key goes now too.
 */
async function retire(
  trx: DatabaseTransaction,
  command: CommandContext,
  vault: StripeSealing,
  businessId: string,
  row: ConnectionRow,
): Promise<void> {
  // A setup that never finished (its job gave up) doesn't hold the connection for ever. If
  // Stripe made an endpoint whose answer was lost, it is left there, pointing at an address this
  // install no longer answers.
  if (row.status === 'connecting' && Date.now() - row.created_at.getTime() < STUCK_SETUP_MS)
    throw new ConflictError(
      'The Stripe account is still being connected. Try again in a minute, once it has finished.',
    );
  await trx
    .deleteFrom('commerce.stripe_connections')
    .where('business_id', '=', businessId)
    .execute();
  if (row.webhook_endpoint_id !== null) {
    await trx
      .insertInto('commerce.stripe_endpoint_removals')
      .values({
        business_id: businessId,
        webhook_endpoint_id: row.webhook_endpoint_id,
        key_secret_id: row.key_secret_id,
      })
      .execute();
    command.enqueue(removeStripeEndpointsReference, {});
  } else await vault.remove(trx, row.key_secret_id);
  await vault.remove(trx, row.webhook_token_secret_id);
  if (row.webhook_secret_id !== null) await vault.remove(trx, row.webhook_secret_id);
}

export function readStripeConnection(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<StripeConnection> {
  return trx
    .selectFrom('commerce.stripe_connections')
    .selectAll()
    .where('business_id', '=', businessId)
    .executeTakeFirst()
    .then(present);
}

export function createConnectStripeCommand(
  options: CommerceOptions,
  vault: StripeSealing,
): Command<typeof connectStripeInput, StripeConnection> {
  return defineCommand({
    name: 'commerce.connect_stripe',
    permission: MANAGE,
    input: connectStripeInput,
    // The key is never audited.
    audit: () => ({}),
    async handle(trx, input, command): Promise<StripeConnection> {
      const businessId = await heldBusiness(options, trx, command);
      const current = await lockedConnection(trx, businessId);
      if (current !== undefined) await retire(trx, command, vault, businessId, current);
      const owner = (purpose: string) => ({
        agencyId: command.context.agencyId,
        businessId,
        purpose,
      });
      const token = randomBytes(32).toString('base64url');
      const keySecretId = await vault.store(trx, owner(STRIPE_KEY_PURPOSE), input.key);
      const tokenSecretId = await vault.store(trx, owner(STRIPE_WEBHOOK_TOKEN_PURPOSE), token);
      const digest = stripeWebhookDigest(token);
      const row = await trx
        .insertInto('commerce.stripe_connections')
        .values({
          business_id: businessId,
          status: 'connecting',
          livemode: input.key.startsWith('rk_live_'),
          key_secret_id: keySecretId,
          webhook_token_secret_id: tokenSecretId,
          webhook_digest: digest,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      command.enqueue(setUpStripeReference, { digest });
      return present(row);
    },
  });
}

export function createDisconnectStripeCommand(
  options: CommerceOptions,
  vault: StripeSealing,
): Command<z.ZodObject<Record<string, never>>, StripeConnection> {
  return defineCommand({
    name: 'commerce.disconnect_stripe',
    permission: MANAGE,
    input: z.strictObject({}),
    async handle(trx, _input, command): Promise<StripeConnection> {
      const businessId = await heldBusiness(options, trx, command);
      const current = await lockedConnection(trx, businessId);
      if (current !== undefined) await retire(trx, command, vault, businessId, current);
      return notConnected;
    },
  });
}

type SetUpFailure = 'key_rejected' | 'missing_permission' | 'no_public_address' | 'provider_error';

async function failSetUp(
  trx: DatabaseTransaction,
  businessId: string,
  digest: string,
  failure: SetUpFailure,
): Promise<void> {
  await trx
    .updateTable('commerce.stripe_connections')
    .set({ status: 'failed', failure })
    .where('business_id', '=', businessId)
    .where('webhook_digest', '=', digest)
    .where('status', '=', 'connecting')
    .execute();
}

const httpsOrigin = (publicUrl: string): string | null => {
  try {
    const url = new URL(publicUrl);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

/**
 * Makes the webhook endpoint on the business's Stripe account. The endpoint is asked for with an
 * idempotency key made from this connection's digest, so a run whose answer was lost asks again
 * and gets the same endpoint back, never a second one (https://docs.stripe.com/api/idempotent_requests.md).
 */
export function createSetUpStripeTask(
  vault: StripeVault,
  transport: StripeTransport,
  publicUrl: string,
): Task<typeof setUpStripeReference.data> {
  return defineTask({
    ...setUpStripeReference,
    async run({ digest }, { invocation, services }) {
      const businessId = requireBusiness(invocation.context);
      const opened = await withTenant(services.db, invocation.context, async (trx) => {
        const row = await lockedConnection(trx, businessId);
        if (row?.status !== 'connecting' || row.webhook_digest !== digest) return null;
        const origin = httpsOrigin(publicUrl);
        if (origin === null) {
          await failSetUp(trx, businessId, digest, 'no_public_address');
          return null;
        }
        const key = await vault.read(trx, row.key_secret_id, STRIPE_KEY_PURPOSE);
        const token = await vault.read(
          trx,
          row.webhook_token_secret_id,
          STRIPE_WEBHOOK_TOKEN_PURPOSE,
        );
        return { key, url: `${origin}${stripeWebhookPath(token)}` };
      });
      if (opened === null) return;

      const result = await createWebhookEndpoint(transport, opened.key, {
        url: opened.url,
        idempotencyKey: `cal-crm-stripe-webhook-${digest}`,
      });
      // A lost answer is asked again by the job's retry, with the same idempotency key.
      if (result.outcome === 'unknown')
        throw new Error('Stripe’s answer was lost; the webhook endpoint is asked for again.');

      await withTenant(services.db, invocation.context, async (trx) => {
        const row = await lockedConnection(trx, businessId);
        if (row?.status !== 'connecting' || row.webhook_digest !== digest) return;
        if (result.outcome === 'rejected') {
          const failure: SetUpFailure =
            result.reason === 'unauthorized'
              ? 'key_rejected'
              : result.reason === 'forbidden'
                ? 'missing_permission'
                : 'provider_error';
          await failSetUp(trx, businessId, digest, failure);
          return;
        }
        const secretId = await vault.store(
          trx,
          {
            agencyId: invocation.context.agencyId,
            businessId,
            purpose: STRIPE_WEBHOOK_SECRET_PURPOSE,
          },
          result.endpoint.secret,
        );
        await trx
          .updateTable('commerce.stripe_connections')
          .set({
            status: 'connected',
            failure: null,
            webhook_endpoint_id: result.endpoint.id,
            webhook_secret_id: secretId,
            connected_at: sql<Date>`now()`,
          })
          .where('business_id', '=', businessId)
          .execute();
      });
    },
  });
}

/**
 * Deletes the endpoints of replaced and removed connections at Stripe, oldest first, with the key
 * each was made with, then the key. One Stripe no longer has counts as deleted. A key Stripe now
 * refuses can't delete its endpoint, which is then left at Stripe (it points at an address this
 * install no longer answers) and forgotten here; any other failure is tried again.
 */
export function createRemoveStripeEndpointsTask(
  vault: StripeVault,
  transport: StripeTransport,
): Task<typeof removeStripeEndpointsReference.data> {
  return defineTask({
    ...removeStripeEndpointsReference,
    async run(_data, { invocation, services }) {
      const pending = await withTenant(services.db, invocation.context, (trx) =>
        trx
          .selectFrom('commerce.stripe_endpoint_removals')
          .select(['id', 'webhook_endpoint_id', 'key_secret_id'])
          .orderBy('created_at')
          .limit(50)
          .execute(),
      );
      let retry = false;
      for (const removal of pending) {
        const key = await withTenant(services.db, invocation.context, (trx) =>
          vault.read(trx, removal.key_secret_id, STRIPE_KEY_PURPOSE),
        );
        const result = await deleteWebhookEndpoint(transport, key, removal.webhook_endpoint_id);
        if (result.outcome === 'unknown') {
          retry = true;
          continue;
        }
        await withTenant(services.db, invocation.context, async (trx) => {
          await trx
            .deleteFrom('commerce.stripe_endpoint_removals')
            .where('id', '=', removal.id)
            .execute();
          await vault.remove(trx, removal.key_secret_id);
        });
      }
      if (retry) throw new Error('Some Stripe endpoints could not be deleted yet; trying again.');
    },
  });
}
