// OAuth for installed apps, as a business consents. The consent page reads an
// app's authorization request and the person decides; Allow installs the app if it isn't
// installed and issues a code for the app's redirect address. A client or redirect address
// that isn't registered is never redirected to (RFC 6749 section 4.1.2.1); anything else
// wrong with the request goes back to the app as an OAuth error. The agency generates the
// app's client secret here too. Trading codes for tokens is the auth module's.
import { createHash, randomBytes } from 'node:crypto';

import { defineCommand, type Command, type Grants } from '@repo/commands';
import {
  generateMarketplaceClientSecret,
  OAUTH_CLIENT_SECRET_PREFIX_LENGTH,
  OAUTH_LIFETIMES,
  oauthAuthorizationRequest,
  S256_CHALLENGE,
  type MarketplaceClientSecret,
  type OAuthAuthorizationError,
  type OAuthAuthorizationGrant,
  type OAuthAuthorizationRequest,
  type OAuthAuthorizationView,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ForbiddenError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import { sql, type NotNull } from 'kysely';

import {
  installApp,
  mayInstall,
  missingFrom,
  requireInstaller,
  requirePublisher,
  visibleApp,
  type InstalledAppRow,
} from './marketplace.js';

const hashOf = (value: string) => createHash('sha256').update(value).digest();

/** The redirect address with these parameters added; its own query stays (RFC 6749 3.1.2). */
function withParams(
  redirectUri: string,
  params: Readonly<Record<string, string | undefined>>,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(name, value);
  return url.toString();
}

/** A request worth asking the person about, or one to send back to the app. */
type Checked =
  | {
      readonly kind: 'consent';
      readonly app: InstalledAppRow;
      readonly redirectUri: string;
      /** What the app gets here: the install's grant, or what installing would grant. */
      readonly scopes: readonly string[];
      /** What it reads here, the same way. */
      readonly readGroups: readonly string[];
      readonly challenge: string;
    }
  | {
      readonly kind: 'refused';
      readonly error: OAuthAuthorizationError;
      readonly description: string;
      readonly redirectUrl: string;
    };

const notFromThisApp = (path: string, message: string) =>
  new ValidationError([{ path, code: 'not_registered', message }]);

/**
 * Checks an authorization request in the business. Throws when it can't be answered to the
 * app at all; otherwise says what to ask the person, or what to tell the app.
 */
async function check(
  trx: DatabaseTransaction,
  context: TenantContext,
  request: OAuthAuthorizationRequest,
  issuer: string,
  lock: boolean,
): Promise<Checked> {
  const { clientId } = request;
  if (clientId === undefined || parsePublicId('marketplace_app', clientId) === undefined)
    throw notFromThisApp('/clientId', 'This link doesn’t name an app.');
  // Unknown, a draft, another agency's, or delisted and not installed here: not found.
  const app = await visibleApp(trx, context, clientId, lock);
  const client = await trx
    .selectFrom('tenancy.marketplace_apps')
    .select(['redirect_uris', 'client_secret_hash'])
    .where('agency_id', '=', context.agencyId)
    .where('id', '=', app.id)
    .executeTakeFirstOrThrow();
  const { redirectUri, state } = request;
  if (redirectUri === undefined || !client.redirect_uris.includes(redirectUri))
    throw notFromThisApp(
      '/redirectUri',
      `${app.name} asked to send you back to an address its developer hasn’t registered, so it can’t be connected from this link.`,
    );
  const refused = (error: OAuthAuthorizationError, description: string): Checked => ({
    kind: 'refused',
    error,
    description,
    redirectUrl: withParams(redirectUri, {
      error,
      error_description: description,
      state,
      iss: issuer,
    }),
  });
  if (request.responseType !== 'code')
    return refused('unsupported_response_type', 'Only response_type=code is supported.');
  if (client.client_secret_hash === null)
    return refused('unauthorized_client', 'The app has no client secret yet.');
  if (request.codeChallengeMethod !== 'S256')
    return refused('invalid_request', 'PKCE is required, with code_challenge_method=S256.');
  const challenge = request.codeChallenge;
  if (challenge === undefined || !S256_CHALLENGE.test(challenge))
    return refused('invalid_request', 'code_challenge must be an S256 challenge.');
  const scopes = app.granted_scopes ?? app.scopes;
  const asked = (request.scope ?? '').split(' ').filter((each) => each !== '');
  const beyond = asked.filter((each) => !scopes.includes(each));
  if (beyond.length > 0)
    return refused('invalid_scope', `The app may not ask for ${beyond.join(', ')} here.`);
  const readGroups = app.granted_read_groups ?? app.read_groups;
  return { kind: 'consent', app, redirectUri, scopes, readGroups, challenge };
}

/** What the consent page shows the person, in the business they chose. */
export async function readAuthorization(
  trx: DatabaseTransaction,
  context: TenantContext,
  grants: Grants,
  request: OAuthAuthorizationRequest,
  issuer: string,
): Promise<OAuthAuthorizationView> {
  const checked = await check(trx, context, request, issuer, false);
  if (checked.kind === 'refused') return checked;
  const { app, redirectUri, scopes, readGroups } = checked;
  return {
    kind: 'consent',
    app: {
      id: toPublicId('marketplace_app', app.id),
      name: app.name,
      developer: app.developer,
      iconUrl: app.icon_url,
      websiteUrl: app.website_url,
    },
    scopes: [...scopes],
    readGroups: [...readGroups],
    webhookEvents: app.webhook_events,
    missingScopes: missingFrom(grants, scopes),
    canInstall: mayInstall(grants),
    installed: app.install_id !== null,
    denyUrl: withParams(redirectUri, {
      error: 'access_denied',
      state: request.state,
      iss: issuer,
    }),
  };
}

/**
 * Allow: installs the app in the business if it isn't installed, by the marketplace's own
 * rules, then issues a code for the app's redirect address, good once for ten minutes.
 */
export function grantAuthorizationCommand(
  issuer: string,
): Command<typeof oauthAuthorizationRequest, OAuthAuthorizationGrant> {
  return defineCommand({
    name: 'marketplace_app.authorize',
    permission: 'apps.manage',
    input: oauthAuthorizationRequest,
    async handle(trx, input, command) {
      const { businessId, userId } = requireInstaller(command.context);
      const checked = await check(trx, command.context, input, issuer, true);
      if (checked.kind === 'refused')
        throw new ValidationError([
          { path: '', code: checked.error, message: checked.description },
        ]);
      const { app, redirectUri, scopes, challenge } = checked;
      let installId = app.install_id;
      if (installId === null) {
        installId = (await installApp(trx, command, app)).id;
      } else {
        const missing = missingFrom(command.permissions, scopes);
        const [first] = missing;
        if (first !== undefined)
          throw new ForbiddenError(
            `You can connect an app only with permissions you have, and you don't have ${missing.join(', ')}.`,
            first,
          );
      }
      const code = `crm_ac_${randomBytes(32).toString('hex')}`;
      await trx
        .insertInto('tenancy.marketplace_oauth_codes')
        .values({
          business_id: businessId,
          agency_id: command.context.agencyId,
          install_id: installId,
          code_hash: hashOf(code),
          redirect_uri: redirectUri,
          code_challenge: challenge,
          issued_by: userId,
          expires_at: sql<Date>`now() + make_interval(secs => ${OAUTH_LIFETIMES.code})`,
        })
        .execute();
      await command.emit({
        type: 'marketplace_app.authorized',
        subject: { kind: 'marketplace_app', id: app.id },
        payload: { installId, name: app.name, redirectUri },
      });
      return { redirectUrl: withParams(redirectUri, { code, state: input.state, iss: issuer }) };
    },
  });
}

/** Generates the app's client secret, shown once; the one it had stops working at once. */
export const generateClientSecretCommand: Command<
  typeof generateMarketplaceClientSecret.params,
  MarketplaceClientSecret
> = defineCommand({
  name: 'marketplace_app.generate_secret',
  permission: 'apps.manage',
  input: generateMarketplaceClientSecret.params,
  async handle(trx, input, command) {
    const { agencyId } = requirePublisher(command.context);
    const appId = parsePublicId('marketplace_app', input.appId);
    if (appId === undefined) throw new NotFoundError('Marketplace app', input.appId);
    const secret = `crm_cs_${randomBytes(32).toString('hex')}`;
    const prefix = secret.slice(0, OAUTH_CLIENT_SECRET_PREFIX_LENGTH);
    const row = await trx
      .updateTable('tenancy.marketplace_apps')
      .set({
        client_secret_hash: hashOf(secret),
        client_secret_prefix: prefix,
        client_secret_set_at: sql<Date>`now()`,
      })
      .where('agency_id', '=', agencyId)
      .where('id', '=', appId)
      .returning(['id', 'name', 'client_secret_set_at'])
      .$narrowType<{ client_secret_set_at: NotNull }>()
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('Marketplace app', input.appId);
    await command.emit({
      type: 'marketplace_app.secret_generated',
      subject: { kind: 'marketplace_app', id: row.id },
      payload: { name: row.name, prefix },
    });
    return {
      clientId: toPublicId('marketplace_app', row.id),
      clientSecret: secret,
      clientSecretPrefix: prefix,
      clientSecretSetAt: row.client_secret_set_at.toISOString(),
    };
  },
});
