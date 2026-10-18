// Where a provider sends the browser back after consent. The attempt named by the state is
// spent before the code is traded, so a state works once; one that is someone else's is not
// spent, since it may still be theirs to use. The person must still be in the business and
// still allowed to manage its integrations. Consent to fewer scopes than asked for is not
// kept: the token is revoked at once.
import { ForbiddenError } from '@repo/kernel';
import { runCommand, type Invocation, type Services } from '@repo/commands';
import type { IntegrationConnectOutcome } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { sql } from 'kysely';

import { completeIntegrationConnectCommand, type IntegrationOptions } from './connections.js';
import { exchangeCode, revokeToken, type Fetch, type OAuthClient } from './oauth.js';
import { codeVerifierOf, sha256 } from './rules.js';

/** What the provider's redirect brought back. */
export interface IntegrationCallback {
  readonly state: string | undefined;
  readonly code: string | undefined;
  readonly error: string | undefined;
}

/** The person signed in where the callback arrived, and what they may do in a business. */
export interface CallbackPerson {
  readonly userId: string;
  /** Their grants in the attempt's business, or undefined when they are not in it now. */
  readonly grantsIn: (businessId: string) => Promise<Invocation['permissions'] | undefined>;
}

export interface CallbackResult {
  readonly outcome: IntegrationConnectOutcome;
  /** Settings → Integrations of the attempt's business, when the attempt was the person's. */
  readonly path: string | undefined;
}

const failed = (path?: string): CallbackResult => ({ outcome: 'failed', path });

export async function completeIntegrationConnect(
  options: IntegrationOptions,
  services: Services,
  fetcher: Fetch,
  key: string,
  callback: IntegrationCallback,
  person: CallbackPerson,
  correlationId: string,
): Promise<CallbackResult> {
  const provider = options.providers.find((each) => each.key === key);
  if (provider?.auth !== 'oauth2' || provider.client === undefined || options.vault === undefined)
    return failed();
  const app = provider.client;
  if (callback.state === undefined || callback.state.length > 200)
    return { outcome: 'expired', path: undefined };
  const state = callback.state;
  const { rows } = await sql<{
    agency_id: string;
    business_id: string;
    user_id: string;
    attempt_id: string;
    provider: string;
  }>`select * from private.find_integration_connect_attempt(${sha256(state)})`.execute(services.db);
  const attempt = rows[0];
  if (attempt === undefined) return { outcome: 'expired', path: undefined };
  if (attempt.user_id !== person.userId || attempt.provider !== provider.key) return failed();
  const businessId = attempt.business_id;
  const grants = await person.grantsIn(businessId);
  if (grants === undefined || (grants !== 'all' && !grants.has('integrations.manage')))
    return failed();
  const invocation: Invocation = {
    context: {
      agencyId: attempt.agency_id,
      businessId,
      userId: person.userId,
      actorKind: 'user',
      actorId: person.userId,
      correlationId,
    },
    permissions: grants,
  };
  const spent = await withTenant(services.db, invocation.context, async (trx) => {
    const removed = await trx
      .deleteFrom('integrations.connect_attempts')
      .where('business_id', '=', businessId)
      .where('id', '=', attempt.attempt_id)
      .where('user_id', '=', person.userId)
      .returning('id')
      .executeTakeFirst();
    const business = await trx
      .selectFrom('tenancy.businesses')
      .select('slug')
      .where('id', '=', businessId)
      .executeTakeFirstOrThrow();
    return {
      removed: removed !== undefined,
      path: `/b/${encodeURIComponent(business.slug)}/settings/integrations`,
    };
  });
  const { path } = spent;
  if (!spent.removed) return { outcome: 'expired', path };
  if (callback.error !== undefined || callback.code === undefined)
    return { outcome: 'denied', path };
  const client: OAuthClient = { ...app, redirectUri: options.redirectUri(provider.key) };
  const exchanged = await exchangeCode(
    fetcher,
    provider.endpoints,
    client,
    callback.code,
    provider.pkce ? codeVerifierOf(app.clientSecret, state) : undefined,
  );
  if (!exchanged.ok) return failed(path);
  const { tokens } = exchanged;
  // An answer that names no scopes granted what was asked for (RFC 6749 section 5.1).
  const granted = tokens.scopes ?? provider.scopes;
  const revoke = () =>
    revokeToken(
      fetcher,
      provider.endpoints,
      client,
      tokens.refreshToken ?? tokens.accessToken,
      tokens.refreshToken === null ? 'access_token' : 'refresh_token',
    );
  if (!provider.scopes.every((scope) => granted.includes(scope))) {
    await revoke();
    return { outcome: 'scopes_missing', path };
  }
  try {
    await runCommand(
      services,
      completeIntegrationConnectCommand(options),
      {
        key: provider.key,
        attemptId: attempt.attempt_id,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: [...granted],
      },
      invocation,
    );
  } catch (error) {
    if (error instanceof ForbiddenError) {
      await revoke();
      return failed(path);
    }
    throw error;
  }
  return { outcome: 'connected', path };
}
