// OAuth tokens for installed apps, as crm_auth: before any tenant context, as the
// API key lookup is. The token endpoint trades a code for a token pair and a refresh token
// for the next pair; the revocation endpoint stops a family; and a request's access token
// becomes the install's app key, which a request then acts as, exactly as with a key.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  apiKeyReadGroups,
  apiKeyScopes,
  CODE_VERIFIER,
  OAUTH_LIFETIMES,
  oauthAccessTokenFormat,
  oauthCodeFormat,
  oauthRefreshTokenFormat,
  SLUG,
  type OAuthTokenError,
  type ApiKeyReadGroup,
  type OAuthTokenResponse,
  type Permission,
} from '@repo/contracts';
import type { Database, DatabaseTransaction } from '@repo/db';
import { parsePublicId } from '@repo/kernel';
import { sql, type NotNull } from 'kysely';

import type { ApiKeyAccess, ApiKeyTarget } from './api-keys.js';

const hashOf = (value: string) => createHash('sha256').update(value).digest();

/** What a token request sent, by RFC 6749's names; the client's credentials either way. */
export interface OAuthTokenRequest {
  readonly grantType?: string;
  readonly code?: string;
  readonly redirectUri?: string;
  readonly codeVerifier?: string;
  readonly refreshToken?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
}

/** A token answer, or an RFC 6749 section 5.2 error with its status. */
export type OAuthTokenOutcome =
  | { readonly outcome: 'issued'; readonly tokens: OAuthTokenResponse }
  | {
      readonly outcome: 'refused';
      readonly status: 400 | 401;
      readonly error: OAuthTokenError;
      readonly description: string;
    };

/** A revocation request (RFC 7009 section 2.1). */
export interface OAuthRevokeRequest {
  readonly token?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
}

export type OAuthRevokeOutcome =
  | { readonly outcome: 'revoked' }
  | { readonly outcome: 'refused'; readonly status: 400 | 401; readonly error: OAuthTokenError };

const refused = (
  error: OAuthTokenError,
  description: string,
  status: 400 | 401 = 400,
): OAuthTokenOutcome => ({ outcome: 'refused', status, error, description });

const badGrant = (description: string) => refused('invalid_grant', description);

interface Client {
  readonly agencyId: string;
  readonly appId: string;
}

/** The app whose id and secret these are, or undefined (RFC 6749 section 2.3.1). */
async function clientOf(
  db: Database,
  clientId: string | undefined,
  clientSecret: string | undefined,
): Promise<Client | undefined> {
  const appId = clientId === undefined ? undefined : parsePublicId('marketplace_app', clientId);
  if (appId === undefined || clientSecret === undefined) return undefined;
  const app = await db
    .selectFrom('tenancy.marketplace_apps')
    .select(['agency_id', 'id', 'client_secret_hash'])
    .where('id', '=', appId)
    .where('client_secret_hash', 'is not', null)
    .$narrowType<{ client_secret_hash: NotNull }>()
    .executeTakeFirst();
  if (app === undefined) return undefined;
  const presented = hashOf(clientSecret);
  return timingSafeEqual(presented, app.client_secret_hash)
    ? { agencyId: app.agency_id, appId: app.id }
    : undefined;
}

/** The install's app key, while the install, the key and the business all still work. */
async function liveKey(
  trx: DatabaseTransaction,
  businessId: string,
  installId: string,
): Promise<{ readonly scopes: string[] } | undefined> {
  return trx
    .selectFrom('tenancy.api_keys as k')
    .innerJoin('tenancy.marketplace_installs as i', (join) =>
      join
        .onRef('i.business_id', '=', 'k.business_id')
        .onRef('i.id', '=', 'k.marketplace_install_id'),
    )
    .innerJoin('tenancy.businesses as b', (join) =>
      join.onRef('b.agency_id', '=', 'i.agency_id').onRef('b.id', '=', 'i.business_id'),
    )
    .select('k.scopes')
    .where('k.business_id', '=', businessId)
    .where('k.marketplace_install_id', '=', installId)
    .where('k.revoked_at', 'is', null)
    .where('i.uninstalled_at', 'is', null)
    .where('b.status', '=', 'active')
    .executeTakeFirst();
}

/** The scopes a key may hold, in the catalogue's order, as a token answer's `scope`. */
const scopeOf = (scopes: readonly string[]) =>
  apiKeyScopes.filter((each) => scopes.includes(each)).join(' ');

/** A new pair in the code's family, written and answered. */
async function issue(
  trx: DatabaseTransaction,
  family: { businessId: string; agencyId: string; installId: string; codeId: string },
  scopes: readonly string[],
): Promise<OAuthTokenOutcome> {
  const accessToken = `crm_at_${randomBytes(32).toString('hex')}`;
  const refreshToken = `crm_rt_${randomBytes(32).toString('hex')}`;
  await trx
    .insertInto('tenancy.marketplace_oauth_tokens')
    .values({
      business_id: family.businessId,
      agency_id: family.agencyId,
      install_id: family.installId,
      code_id: family.codeId,
      access_hash: hashOf(accessToken),
      access_expires_at: sql<Date>`now() + make_interval(secs => ${OAUTH_LIFETIMES.accessToken})`,
      refresh_hash: hashOf(refreshToken),
      refresh_expires_at: sql<Date>`now() + make_interval(secs => ${OAUTH_LIFETIMES.refreshToken})`,
    })
    .execute();
  return {
    outcome: 'issued',
    tokens: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: OAUTH_LIFETIMES.accessToken,
      refresh_token: refreshToken,
      scope: scopeOf(scopes),
    },
  };
}

/** Stops every pair from one code, for this reason, unless already stopped. */
async function revokeFamily(
  trx: DatabaseTransaction | Database,
  businessId: string,
  codeId: string,
  reason: 'revoked' | 'refresh_reused' | 'code_reused',
): Promise<void> {
  await trx
    .updateTable('tenancy.marketplace_oauth_tokens')
    .set({ revoked_at: sql<Date>`now()`, revoked_reason: reason })
    .where('business_id', '=', businessId)
    .where('code_id', '=', codeId)
    .where('revoked_at', 'is', null)
    .execute();
}

/** grant_type=authorization_code (RFC 6749 section 4.1.3, RFC 7636 section 4.6). */
async function tradeCode(
  db: Database,
  client: Client,
  request: OAuthTokenRequest,
): Promise<OAuthTokenOutcome> {
  const { code, redirectUri, codeVerifier } = request;
  if (code === undefined || redirectUri === undefined || codeVerifier === undefined)
    return refused('invalid_request', 'Send code, redirect_uri and code_verifier.');
  if (!oauthCodeFormat.test(code)) return badGrant('The code is not valid.');
  return db.transaction().execute(async (trx) => {
    const found = await trx
      .selectFrom('tenancy.marketplace_oauth_codes as c')
      .innerJoin('tenancy.marketplace_installs as i', (join) =>
        join.onRef('i.business_id', '=', 'c.business_id').onRef('i.id', '=', 'c.install_id'),
      )
      .select([
        'c.business_id',
        'c.agency_id',
        'c.id',
        'c.install_id',
        'c.redirect_uri',
        'c.code_challenge',
        'c.used_at',
        sql<boolean>`c.expires_at <= now()`.as('expired'),
      ])
      .where('c.code_hash', '=', hashOf(code))
      .where('i.agency_id', '=', client.agencyId)
      .where('i.app_id', '=', client.appId)
      .forUpdate('c')
      .executeTakeFirst();
    if (found === undefined) return badGrant('The code is not valid.');
    if (found.used_at !== null) {
      // A code used twice: whoever has it may not be the app (RFC 6749 section 4.1.2).
      await revokeFamily(trx, found.business_id, found.id, 'code_reused');
      return badGrant('The code was used already.');
    }
    if (found.expired) return badGrant('The code has expired.');
    if (found.redirect_uri !== redirectUri)
      return badGrant('redirect_uri is not the one the code was issued for.');
    const challenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    if (!CODE_VERIFIER.test(codeVerifier) || challenge !== found.code_challenge)
      return badGrant('code_verifier does not match the code_challenge.');
    await trx
      .updateTable('tenancy.marketplace_oauth_codes')
      .set({ used_at: sql<Date>`now()` })
      .where('business_id', '=', found.business_id)
      .where('id', '=', found.id)
      .execute();
    const key = await liveKey(trx, found.business_id, found.install_id);
    if (key === undefined) return badGrant('The app is no longer installed there.');
    return issue(
      trx,
      {
        businessId: found.business_id,
        agencyId: found.agency_id,
        installId: found.install_id,
        codeId: found.id,
      },
      key.scopes,
    );
  });
}

/** grant_type=refresh_token, rotating it (RFC 6749 section 6, RFC 9700 section 4.14.2). */
async function refresh(
  db: Database,
  client: Client,
  request: OAuthTokenRequest,
): Promise<OAuthTokenOutcome> {
  const { refreshToken } = request;
  if (refreshToken === undefined) return refused('invalid_request', 'Send refresh_token.');
  if (!oauthRefreshTokenFormat.test(refreshToken))
    return badGrant('The refresh token is not valid.');
  return db.transaction().execute(async (trx) => {
    const found = await trx
      .selectFrom('tenancy.marketplace_oauth_tokens as t')
      .innerJoin('tenancy.marketplace_installs as i', (join) =>
        join.onRef('i.business_id', '=', 't.business_id').onRef('i.id', '=', 't.install_id'),
      )
      .select([
        't.business_id',
        't.agency_id',
        't.id',
        't.install_id',
        't.code_id',
        't.rotated_at',
        't.revoked_at',
        sql<boolean>`t.refresh_expires_at <= now()`.as('expired'),
      ])
      .where('t.refresh_hash', '=', hashOf(refreshToken))
      .where('i.agency_id', '=', client.agencyId)
      .where('i.app_id', '=', client.appId)
      .forUpdate('t')
      .executeTakeFirst();
    if (found?.revoked_at !== null) return badGrant('The refresh token is not valid.');
    if (found.rotated_at !== null) {
      // Used before: one of its two holders isn't the app, so neither keeps the family.
      await revokeFamily(trx, found.business_id, found.code_id, 'refresh_reused');
      return badGrant('The refresh token was used already.');
    }
    if (found.expired) return badGrant('The refresh token has expired.');
    const key = await liveKey(trx, found.business_id, found.install_id);
    if (key === undefined) return badGrant('The app is no longer installed there.');
    await trx
      .updateTable('tenancy.marketplace_oauth_tokens')
      .set({ rotated_at: sql<Date>`now()` })
      .where('business_id', '=', found.business_id)
      .where('id', '=', found.id)
      .execute();
    return issue(
      trx,
      {
        businessId: found.business_id,
        agencyId: found.agency_id,
        installId: found.install_id,
        codeId: found.code_id,
      },
      key.scopes,
    );
  });
}

/** The token endpoint. */
export async function exchangeOAuthToken(
  db: Database,
  request: OAuthTokenRequest,
): Promise<OAuthTokenOutcome> {
  if (request.grantType === undefined) return refused('invalid_request', 'Send grant_type.');
  if (request.grantType !== 'authorization_code' && request.grantType !== 'refresh_token')
    return refused('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  const client = await clientOf(db, request.clientId, request.clientSecret);
  if (client === undefined)
    return refused('invalid_client', 'The client id or secret is not valid.', 401);
  return request.grantType === 'authorization_code'
    ? tradeCode(db, client, request)
    : refresh(db, client, request);
}

/**
 * The revocation endpoint (RFC 7009): either token of a pair stops its whole family. A
 * token that is unknown, or another app's, is answered the same as one revoked.
 */
export async function revokeOAuthToken(
  db: Database,
  request: OAuthRevokeRequest,
): Promise<OAuthRevokeOutcome> {
  if (request.token === undefined)
    return { outcome: 'refused', status: 400, error: 'invalid_request' };
  const client = await clientOf(db, request.clientId, request.clientSecret);
  if (client === undefined) return { outcome: 'refused', status: 401, error: 'invalid_client' };
  const { token } = request;
  const column = oauthAccessTokenFormat.test(token)
    ? 'access_hash'
    : oauthRefreshTokenFormat.test(token)
      ? 'refresh_hash'
      : undefined;
  if (column === undefined) return { outcome: 'revoked' };
  const found = await db
    .selectFrom('tenancy.marketplace_oauth_tokens as t')
    .innerJoin('tenancy.marketplace_installs as i', (join) =>
      join.onRef('i.business_id', '=', 't.business_id').onRef('i.id', '=', 't.install_id'),
    )
    .select(['t.business_id', 't.code_id'])
    .where(`t.${column}`, '=', hashOf(token))
    .where('i.agency_id', '=', client.agencyId)
    .where('i.app_id', '=', client.appId)
    .executeTakeFirst();
  if (found !== undefined) await revokeFamily(db, found.business_id, found.code_id, 'revoked');
  return { outcome: 'revoked' };
}

/**
 * What a request with an access token may do: the install's app key, in the install's
 * business, or undefined for a token that doesn't work (unknown, expired, revoked; the app
 * uninstalled; the business not active), or a selector naming another business.
 */
export async function findAppToken(
  db: Database,
  token: string,
  target?: ApiKeyTarget,
): Promise<ApiKeyAccess | undefined> {
  if (
    !oauthAccessTokenFormat.test(token) ||
    (target?.businessId !== undefined && target.businessSlug !== undefined) ||
    (target?.businessSlug !== undefined && !SLUG.test(target.businessSlug))
  )
    return undefined;
  const row = await db
    .selectFrom('tenancy.marketplace_oauth_tokens as t')
    .innerJoin('tenancy.marketplace_installs as i', (join) =>
      join.onRef('i.business_id', '=', 't.business_id').onRef('i.id', '=', 't.install_id'),
    )
    .innerJoin('tenancy.api_keys as k', (join) =>
      join
        .onRef('k.business_id', '=', 't.business_id')
        .onRef('k.marketplace_install_id', '=', 't.install_id'),
    )
    .innerJoin('tenancy.businesses as b', (join) =>
      join.onRef('b.agency_id', '=', 't.agency_id').onRef('b.id', '=', 't.business_id'),
    )
    .select(['k.id', 'k.agency_id', 't.business_id', 'k.scopes', 'k.read_groups', 'b.slug'])
    .where('t.access_hash', '=', hashOf(token))
    .where('t.revoked_at', 'is', null)
    .where('t.access_expires_at', '>', sql<Date>`now()`)
    .where('i.uninstalled_at', 'is', null)
    .where('k.revoked_at', 'is', null)
    .where('b.status', '=', 'active')
    .executeTakeFirst();
  if (row === undefined) return undefined;
  // A token works in its own business only.
  if (target?.businessId !== undefined && target.businessId !== row.business_id) return undefined;
  if (target?.businessSlug !== undefined && target.businessSlug !== row.slug) return undefined;
  await db
    .updateTable('tenancy.api_keys')
    .set({ last_used_at: sql<Date>`now()` })
    .where('id', '=', row.id)
    .where((eb) =>
      eb.or([
        eb('last_used_at', 'is', null),
        eb('last_used_at', '<', sql<Date>`now() - interval '1 minute'`),
      ]),
    )
    .execute();
  return {
    keyId: row.id,
    agencyId: row.agency_id,
    businessId: row.business_id,
    // Always a list: an app reads only the groups its install granted.
    readGroups: (row.read_groups ?? []).filter((group): group is ApiKeyReadGroup =>
      (apiKeyReadGroups as readonly string[]).includes(group),
    ),
    permissions: new Set(
      row.scopes.filter((scope): scope is Permission =>
        (apiKeyScopes as readonly string[]).includes(scope),
      ),
    ),
  };
}
