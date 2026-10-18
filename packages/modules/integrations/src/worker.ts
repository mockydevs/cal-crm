// What the worker does with a connection: reads the account its credentials belong to and
// checks it again each day, refreshes an expired access token, revokes the credentials at the
// provider once it is disconnected, and verifies what a provider sent before anything acts on
// it. Only the worker opens credentials. A refresh happens under a lock on the connection and
// its answer is sealed in the same transaction: a provider that rotates refresh tokens has
// already spent the old one.
import { randomUUID } from 'node:crypto';

import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type AnyTask,
  type Command,
  type Invocation,
  type Services,
} from '@repo/commands';
import type { IntegrationErrorCode } from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import { SecretUnreadableError, type Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';

import { CHECK_TASK, REVOKE_TASK } from './connections.js';
import { readIdentity, refreshTokens, revokeToken, type Fetch, type OAuthClient } from './oauth.js';
import { providerReady, type IntegrationProvider, type OAuthProvider } from './provider.js';
import {
  clipped,
  credentialsPurpose,
  failureDetail,
  fieldAt,
  nextCheckAt,
  RETRY_CHECK_MS,
  sealedCredentials,
  signatureValid,
  tokenFresh,
  type SealedCredentials,
} from './rules.js';

export const VERIFY_WEBHOOK_TASK = 'integrations.verify_webhook';

/** Those who manage the business's integrations are told one needs them. */
export type AttentionNotice = (
  trx: DatabaseTransaction,
  context: TenantContext,
  notice: {
    readonly connectionId: string;
    /** Who connected it, told as well; null when they are gone. */
    readonly connectedBy: string | null;
    readonly provider: string;
  },
) => Promise<void>;

export interface IntegrationWorkerOptions {
  readonly providers: readonly IntegrationProvider[];
  /** The worker's vault, which opens secrets. */
  readonly vault: Vault;
  /** Sends the requests to providers: fetch, or a test's stand-in. */
  readonly fetch: Fetch;
  readonly redirectUri: (key: string) => string;
  readonly notifyAttention: AttentionNotice;
  /** Random numbers for spreading checks: Math.random, or a test's fixed ones. */
  readonly random: () => number;
  readonly now?: () => Date;
}

type Failure = IntegrationErrorCode | 'gone' | 'unavailable';

interface Opened {
  readonly secretId: string;
  readonly credentials: SealedCredentials;
}

/** A live connection's credentials, or why there are none to use. */
async function open(
  trx: DatabaseTransaction,
  vault: Vault,
  businessId: string,
  connectionId: string,
  provider: string,
  lock: boolean,
): Promise<Opened | { readonly failure: Failure }> {
  const query = trx
    .selectFrom('integrations.connections')
    .select(['status', 'secret_id'])
    .where('business_id', '=', businessId)
    .where('id', '=', connectionId);
  const row = await (lock ? query.forUpdate() : query).executeTakeFirst();
  if (row === undefined || row.status === 'disconnected' || row.secret_id === null)
    return { failure: 'gone' };
  let plaintext: string;
  try {
    plaintext = await vault.read(trx, row.secret_id, credentialsPurpose(provider));
  } catch (error) {
    // Sealed under a key this worker no longer holds: the operator's to fix.
    if (error instanceof SecretUnreadableError) return { failure: 'config_missing' };
    throw error;
  }
  const credentials = credentialsIn(plaintext);
  if (credentials === undefined) return { failure: 'config_missing' };
  return { secretId: row.secret_id, credentials };
}

/** What a sealed secret holds, or undefined when it is not credentials this code wrote. */
function credentialsIn(plaintext: string): SealedCredentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return undefined;
  }
  const credentials = sealedCredentials.safeParse(parsed);
  return credentials.success ? credentials.data : undefined;
}

const tokenOf = (credentials: SealedCredentials): string =>
  credentials.kind === 'api_key' ? credentials.apiKey : credentials.accessToken;

const markInput = z.strictObject({
  connectionId: z.uuid(),
  errorCode: z.enum([
    'reauthorize',
    'missing_permission',
    'rate_limited',
    'provider_error',
    'plan_limit',
    'config_missing',
  ]),
});

/**
 * A connection that needs someone: its reason in plain words, the activity, the event the
 * audit log shows, and, when it was working until now, a notification for those who manage
 * integrations. Run by the worker, as the system.
 */
function markFailedCommand(
  options: IntegrationWorkerOptions,
  now: () => Date,
): Command<typeof markInput, undefined> {
  return defineCommand({
    name: 'integration.mark_failed',
    permission: 'integrations.manage',
    input: markInput,
    async handle(trx, input, command) {
      const businessId = requireBusiness(command.context);
      const row = await trx
        .selectFrom('integrations.connections')
        .select(['provider', 'status', 'connected_by'])
        .where('business_id', '=', businessId)
        .where('id', '=', input.connectionId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined || row.status === 'disconnected') return undefined;
      const name =
        options.providers.find((each) => each.key === row.provider)?.name ?? row.provider;
      const detail = failureDetail(input.errorCode, name);
      const at = now();
      await trx
        .updateTable('integrations.connections')
        .set({
          status: 'needs_attention',
          error_code: input.errorCode,
          error_detail: detail,
          last_error_at: at,
          next_check_at: new Date(at.getTime() + RETRY_CHECK_MS),
        })
        .where('business_id', '=', businessId)
        .where('id', '=', input.connectionId)
        .execute();
      await trx
        .insertInto('integrations.activity')
        .values({
          business_id: businessId,
          connection_id: input.connectionId,
          kind: 'check_failed',
          error_code: input.errorCode,
          detail,
        })
        .execute();
      await command.emit({
        type: 'integration.failed',
        subject: { kind: 'integration_connection', id: input.connectionId },
        payload: { provider: row.provider, errorCode: input.errorCode },
      });
      if (row.status !== 'needs_attention')
        await options.notifyAttention(trx, command.context, {
          connectionId: input.connectionId,
          connectedBy: row.connected_by,
          provider: name,
        });
      return undefined;
    },
  });
}

const connectionData = z.strictObject({ connectionId: z.uuid() });

export function createIntegrationWorker(options: IntegrationWorkerOptions): {
  readonly tasks: readonly AnyTask[];
} {
  const { vault } = options;
  const now = options.now ?? (() => new Date());
  const markFailed = markFailedCommand(options, now);
  const clientOf = (
    provider: OAuthProvider,
    client: NonNullable<OAuthProvider['client']>,
  ): OAuthClient => ({ ...client, redirectUri: options.redirectUri(provider.key) });

  const fail = (
    services: Services,
    invocation: Invocation,
    connectionId: string,
    errorCode: IntegrationErrorCode,
  ) => runCommand(services, markFailed, { connectionId, errorCode }, invocation);

  /** The provider did not answer: noted, and checked again within the hour. */
  async function notAnswered(
    services: Services,
    context: TenantContext,
    connectionId: string,
    errorCode: 'rate_limited' | 'provider_error',
    provider: IntegrationProvider,
  ): Promise<void> {
    const businessId = requireBusiness(context);
    const at = now();
    await withTenant(services.db, context, async (trx) => {
      await trx
        .updateTable('integrations.connections')
        .set({ last_error_at: at, next_check_at: new Date(at.getTime() + RETRY_CHECK_MS) })
        .where('business_id', '=', businessId)
        .where('id', '=', connectionId)
        .where('status', '<>', 'disconnected')
        .execute();
      await trx
        .insertInto('integrations.activity')
        .values({
          business_id: businessId,
          connection_id: connectionId,
          kind: 'check_failed',
          error_code: errorCode,
          detail: failureDetail(errorCode, provider.name),
        })
        .execute();
    });
  }

  /**
   * An access token to call with: the sealed one while it is fresh, otherwise a new one from
   * the refresh token, sealed before anything else under a lock on the connection.
   */
  async function accessFor(
    services: Services,
    context: TenantContext,
    connectionId: string,
    provider: IntegrationProvider,
  ): Promise<
    { readonly token: string; readonly secretId: string } | { readonly failure: Failure }
  > {
    const businessId = requireBusiness(context);
    const read = await withTenant(services.db, context, (trx) =>
      open(trx, vault, businessId, connectionId, provider.key, false),
    );
    if ('failure' in read) return read;
    if (tokenFresh(read.credentials, now()))
      return { token: tokenOf(read.credentials), secretId: read.secretId };
    return withTenant(services.db, context, async (trx) => {
      const locked = await open(trx, vault, businessId, connectionId, provider.key, true);
      if ('failure' in locked) return locked;
      const { credentials } = locked;
      // Another job refreshed it while this one waited for the lock.
      if (tokenFresh(credentials, now()))
        return { token: tokenOf(credentials), secretId: locked.secretId };
      // Only a token pair goes stale; a provider that gave no refresh token needs a sign-in.
      if (
        credentials.kind !== 'oauth2' ||
        provider.auth !== 'oauth2' ||
        provider.client === undefined ||
        credentials.refreshToken === null
      )
        return { failure: 'reauthorize' };
      const refreshed = await refreshTokens(
        options.fetch,
        provider.endpoints,
        clientOf(provider, provider.client),
        credentials.refreshToken,
        now,
      );
      if (!refreshed.ok)
        return {
          failure:
            refreshed.failure === 'invalid_grant'
              ? 'reauthorize'
              : refreshed.failure === 'refused'
                ? 'config_missing'
                : 'unavailable',
        };
      const { tokens } = refreshed;
      const next: SealedCredentials = {
        kind: 'oauth2',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? credentials.refreshToken,
        expiresAt: tokens.expiresAt,
      };
      await vault.replace(trx, locked.secretId, JSON.stringify(next));
      return { token: tokens.accessToken, secretId: locked.secretId };
    });
  }

  /**
   * The account read: the first reading names the connection's account, or finds the same
   * account already connected (a reconnection, which keeps the older row with the new
   * credentials). A provider of one account replaces another account connected before.
   */
  async function confirm(
    services: Services,
    context: TenantContext,
    connectionId: string,
    secretId: string,
    provider: IntegrationProvider,
    account: { readonly ref: string; readonly label: string },
  ): Promise<void> {
    const businessId = requireBusiness(context);
    const at = now();
    const next = nextCheckAt(at, options.random());
    await withTenant(services.db, context, async (trx) => {
      const row = await trx
        .selectFrom('integrations.connections')
        .select(['status', 'secret_id', 'scopes_granted', 'is_primary'])
        .where('business_id', '=', businessId)
        .where('id', '=', connectionId)
        .forUpdate()
        .executeTakeFirst();
      // Disconnected, or connected again with new credentials, while the provider was asked.
      if (row === undefined || row.status === 'disconnected' || row.secret_id !== secretId) return;
      if (row.status === 'connecting') {
        const same = await trx
          .selectFrom('integrations.connections')
          .select(['id', 'secret_id', 'revision'])
          .where('business_id', '=', businessId)
          .where('provider', '=', provider.key)
          .where('account_ref', '=', account.ref)
          .where('status', '<>', 'disconnected')
          .where('id', '<>', connectionId)
          .forUpdate()
          .executeTakeFirst();
        if (same !== undefined) {
          await trx
            .deleteFrom('integrations.connections')
            .where('business_id', '=', businessId)
            .where('id', '=', connectionId)
            .execute();
          await trx
            .updateTable('integrations.connections')
            .set({
              secret_id: secretId,
              scopes_granted: row.scopes_granted,
              status: 'connected',
              error_code: null,
              error_detail: null,
              account_label: account.label,
              last_ok_at: at,
              next_check_at: next,
              revision: same.revision + 1,
            })
            .where('business_id', '=', businessId)
            .where('id', '=', same.id)
            .execute();
          // A live connection always holds a secret (connections_live_has_secret).
          if (same.secret_id !== null) await vault.remove(trx, same.secret_id);
          await trx
            .insertInto('integrations.activity')
            .values({
              business_id: businessId,
              connection_id: same.id,
              kind: 'confirmed',
              detail: 'Reconnected: the account was signed into again.',
            })
            .execute();
          return;
        }
        if (!provider.multipleAccounts)
          await replaceOthers(trx, businessId, connectionId, provider);
      }
      await trx
        .updateTable('integrations.connections')
        .set({
          status: 'connected',
          account_ref: sql<string>`coalesce(account_ref, ${account.ref})`,
          account_label: account.label,
          error_code: null,
          error_detail: null,
          last_ok_at: at,
          next_check_at: next,
          is_primary: sql<boolean>`is_primary or not exists (
            select 1 from integrations.connections other
            where other.business_id = ${businessId} and other.provider = ${provider.key}
              and other.is_primary and other.id <> ${connectionId})`,
        })
        .where('business_id', '=', businessId)
        .where('id', '=', connectionId)
        .execute();
      await trx
        .insertInto('integrations.activity')
        .values({
          business_id: businessId,
          connection_id: connectionId,
          kind: row.status === 'connecting' ? 'confirmed' : 'check_ok',
          detail: row.status === 'needs_attention' ? 'Working again.' : null,
        })
        .execute();
    });
  }

  /** The business's other accounts of a one-account provider, disconnected for the new one. */
  async function replaceOthers(
    trx: DatabaseTransaction,
    businessId: string,
    connectionId: string,
    provider: IntegrationProvider,
  ): Promise<void> {
    const others = await trx
      .updateTable('integrations.connections')
      .set({
        status: 'disconnected',
        disconnected_reason: 'user',
        disconnected_at: sql<Date>`now()`,
        is_primary: false,
        error_code: null,
        error_detail: null,
      })
      .where('business_id', '=', businessId)
      .where('provider', '=', provider.key)
      .where('status', '<>', 'disconnected')
      .where('id', '<>', connectionId)
      .returning('id')
      .execute();
    for (const other of others) {
      await trx
        .insertInto('integrations.activity')
        .values({
          business_id: businessId,
          connection_id: other.id,
          kind: 'disconnected',
          detail: 'Replaced by another account.',
        })
        .execute();
      await sql`select private.enqueue_integration_job(${REVOKE_TASK}, ${JSON.stringify({ connectionId: other.id })}::jsonb, ${`integration-revoke:${other.id}`}, null)`.execute(
        trx,
      );
    }
  }

  const check = defineTask({
    name: CHECK_TASK,
    data: connectionData,
    async run({ connectionId }, job) {
      const { context } = job.invocation;
      const businessId = requireBusiness(context);
      const row = await withTenant(job.services.db, context, (trx) =>
        trx
          .selectFrom('integrations.connections')
          .select(['provider', 'status'])
          .where('business_id', '=', businessId)
          .where('id', '=', connectionId)
          .executeTakeFirst(),
      );
      if (row === undefined || row.status === 'disconnected') return;
      const provider = options.providers.find((each) => each.key === row.provider);
      if (provider === undefined || !providerReady(provider)) {
        await fail(job.services, job.invocation, connectionId, 'config_missing');
        return;
      }
      const access = await accessFor(job.services, context, connectionId, provider);
      if ('failure' in access) {
        if (access.failure === 'gone') return;
        if (access.failure === 'unavailable')
          await notAnswered(job.services, context, connectionId, 'provider_error', provider);
        else await fail(job.services, job.invocation, connectionId, access.failure);
        return;
      }
      const identity = await readIdentity(options.fetch, provider.identity.url, access.token);
      if (!identity.ok) {
        if (identity.failure === 'unauthorized')
          await fail(job.services, job.invocation, connectionId, 'reauthorize');
        else if (identity.failure === 'forbidden')
          await fail(job.services, job.invocation, connectionId, 'missing_permission');
        else
          await notAnswered(
            job.services,
            context,
            connectionId,
            identity.failure === 'rate_limited' ? 'rate_limited' : 'provider_error',
            provider,
          );
        return;
      }
      const ref = fieldAt(identity.body, provider.identity.id);
      if (ref === undefined) {
        await notAnswered(job.services, context, connectionId, 'provider_error', provider);
        return;
      }
      const label = fieldAt(identity.body, provider.identity.label) ?? ref;
      await confirm(job.services, context, connectionId, access.secretId, provider, {
        ref: clipped(ref, 255),
        label: clipped(label, 200),
      });
    },
  });

  const revoke = defineTask({
    name: REVOKE_TASK,
    data: connectionData,
    async run({ connectionId }, job) {
      const { context } = job.invocation;
      const businessId = requireBusiness(context);
      const row = await withTenant(job.services.db, context, (trx) =>
        trx
          .selectFrom('integrations.connections')
          .select(['provider', 'status', 'secret_id'])
          .where('business_id', '=', businessId)
          .where('id', '=', connectionId)
          .executeTakeFirst(),
      );
      if (row?.status !== 'disconnected' || row.secret_id === null) return;
      const secretId = row.secret_id;
      const provider = options.providers.find((each) => each.key === row.provider);
      let revokedAtProvider = false;
      if (provider?.auth === 'oauth2' && provider.client !== undefined) {
        const client = provider.client;
        const plaintext = await withTenant(job.services.db, context, (trx) =>
          vault.read(trx, secretId, credentialsPurpose(provider.key)).catch((error: unknown) => {
            if (error instanceof SecretUnreadableError) return undefined;
            throw error;
          }),
        );
        const credentials = plaintext === undefined ? undefined : credentialsIn(plaintext);
        if (credentials?.kind === 'oauth2') {
          const outcome = await revokeToken(
            options.fetch,
            provider.endpoints,
            clientOf(provider, client),
            credentials.refreshToken ?? credentials.accessToken,
            credentials.refreshToken === null ? 'access_token' : 'refresh_token',
          );
          // Not answering now: the queue tries again later, and the secret stays till then.
          if (outcome === 'unavailable')
            throw new Error(`${provider.name} did not answer the revocation; it is tried again.`);
          revokedAtProvider = outcome === 'revoked';
        }
      }
      await withTenant(job.services.db, context, async (trx) => {
        const current = await trx
          .selectFrom('integrations.connections')
          .select(['status', 'secret_id'])
          .where('business_id', '=', businessId)
          .where('id', '=', connectionId)
          .forUpdate()
          .executeTakeFirst();
        if (current?.status !== 'disconnected' || current.secret_id !== secretId) return;
        await trx
          .updateTable('integrations.connections')
          .set({ secret_id: null })
          .where('business_id', '=', businessId)
          .where('id', '=', connectionId)
          .execute();
        await vault.remove(trx, secretId);
        await trx
          .insertInto('integrations.activity')
          .values({
            business_id: businessId,
            connection_id: connectionId,
            kind: 'revoked',
            detail: revokedAtProvider
              ? 'Access revoked at the provider; the credentials were removed.'
              : 'The credentials were removed.',
          })
          .execute();
      });
    },
  });

  const verifyWebhook = defineTask({
    name: VERIFY_WEBHOOK_TASK,
    data: z.strictObject({ webhookId: z.uuid() }),
    async run({ webhookId }, job) {
      const { context } = job.invocation;
      const businessId = requireBusiness(context);
      await withTenant(job.services.db, context, async (trx) => {
        const stored = await trx
          .selectFrom('intake.webhooks')
          .select(['headers', 'body', 'integration_connection_id'])
          .where('id', '=', webhookId)
          .where('business_id', '=', businessId)
          .where('processed_at', 'is', null)
          .executeTakeFirst();
        const connectionId = stored?.integration_connection_id ?? null;
        if (stored === undefined || connectionId === null) return;
        const connection = await trx
          .selectFrom('integrations.connections')
          .select(['provider', 'status'])
          .where('business_id', '=', businessId)
          .where('id', '=', connectionId)
          .executeTakeFirst();
        const provider = options.providers.find((each) => each.key === connection?.provider);
        // Checked with the operator app's client secret, which signs the provider's webhooks.
        const valid =
          connection !== undefined &&
          connection.status !== 'disconnected' &&
          provider?.auth === 'oauth2' &&
          provider.webhook !== undefined &&
          provider.client !== undefined &&
          signatureValid(
            provider.webhook,
            provider.client.clientSecret,
            stored.headers as Record<string, unknown>,
            stored.body,
          );
        await trx
          .updateTable('intake.webhooks')
          .set({
            signature_valid: valid,
            processed_at: sql<Date>`now()`,
            error: valid ? null : 'signature_invalid',
          })
          .where('id', '=', webhookId)
          .execute();
        // A request that is not the provider's never changes the connection's health.
        if (valid)
          await trx
            .insertInto('integrations.activity')
            .values({
              business_id: businessId,
              connection_id: connectionId,
              kind: 'webhook_received',
            })
            .execute();
      });
    },
  });

  return { tasks: [check, revoke, verifyWebhook] };
}

/**
 * Queues a check of each connection whose time has come, across tenants, and puts its time a
 * quarter of an hour on so the next sweep does not queue it again before it has run. Gives
 * how many were queued.
 */
export async function scheduleIntegrationChecks(services: Services): Promise<number> {
  const { rows } = await sql<{
    agency_id: string;
    business_id: string;
    connection_id: string;
  }>`select * from private.due_integration_checks(500)`.execute(services.db);
  for (const row of rows) {
    const context: TenantContext = {
      agencyId: row.agency_id,
      businessId: row.business_id,
      actorKind: 'system',
      correlationId: randomUUID(),
    };
    await withTenant(services.db, context, async (trx) => {
      await trx
        .updateTable('integrations.connections')
        .set({ next_check_at: sql<Date>`now() + interval '15 minutes'` })
        .where('business_id', '=', row.business_id)
        .where('id', '=', row.connection_id)
        .execute();
      await sql`select private.enqueue_integration_job(${CHECK_TASK}, ${JSON.stringify({ connectionId: row.connection_id })}::jsonb, ${`integration-check:${row.connection_id}`}, null)`.execute(
        trx,
      );
    });
  }
  return rows.length;
}

/** Clears spent attempts, old activity, old webhooks and long-disconnected connections. */
export async function maintainIntegrations(services: Services): Promise<number> {
  const { rows } = await sql<{
    removed: number;
  }>`select private.maintain_integrations(1000) as removed`.execute(services.db);
  return rows[0]?.removed ?? 0;
}
