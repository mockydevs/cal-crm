// OAuth for installed apps. The app is the OAuth client and its client id is its
// public id. A person consents on our page (`/oauth/authorize`), which reads and decides
// through the two endpoints here; the app then trades the code at `POST /oauth/token`,
// a form-encoded endpoint outside /api/v1 (RFC 6749 section 4.1.3), described by
// `GET /.well-known/oauth-authorization-server` (RFC 8414).
import * as z from 'zod';

import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** An authorization code: ten minutes, once. */
export const oauthCodeFormat = /^crm_ac_[0-9a-f]{64}$/;
/** An access token, sent as `Authorization: Bearer crm_at_…`. */
export const oauthAccessTokenFormat = /^crm_at_[0-9a-f]{64}$/;
/** A refresh token: one use, then the next one. */
export const oauthRefreshTokenFormat = /^crm_rt_[0-9a-f]{64}$/;
/** An app's client secret. */
export const oauthClientSecretFormat = /^crm_cs_[0-9a-f]{64}$/;
/** How much of a client secret the settings page shows: `crm_cs_` and 8 hex digits. */
export const OAUTH_CLIENT_SECRET_PREFIX_LENGTH = 15;

/** Lifetimes, in seconds. */
export const OAUTH_LIFETIMES = {
  code: 10 * 60,
  accessToken: 24 * 60 * 60,
  refreshToken: 365 * 24 * 60 * 60,
} as const;

/** Where the person consents, and where the app trades codes and revokes tokens. */
export const OAUTH_PATHS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  revoke: '/oauth/revoke',
  metadata: '/.well-known/oauth-authorization-server',
} as const;

/** BASE64URL(SHA-256(code_verifier)), without padding (RFC 7636 section 4.2). */
export const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** A code verifier: 43 to 128 unreserved characters (RFC 7636 section 4.1). */
export const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * The authorization request, as the consent page passes it on: the OAuth parameters in the
 * page's address, by these names. Each is only a bounded string here; what is wrong with a
 * request is the server's to say, in OAuth's terms, so the page can tell the app.
 */
export const oauthAuthorizationRequest = z
  .strictObject({
    clientId: z.string().max(200).optional(),
    redirectUri: z.string().max(2048).optional(),
    responseType: z.string().max(100).optional(),
    scope: z.string().max(10_000).optional(),
    state: z.string().max(2048).optional(),
    codeChallenge: z.string().max(200).optional(),
    codeChallengeMethod: z.string().max(100).optional(),
  })
  .meta({
    id: 'OAuthAuthorizationRequest',
    description:
      'The OAuth parameters of an authorization request (RFC 6749 section 4.1.1, RFC 7636 section 4.3), camel-cased.',
  });
export type OAuthAuthorizationRequest = z.output<typeof oauthAuthorizationRequest>;

/** RFC 6749 section 4.1.2.1's codes, as the consent page can send them back. */
export const oauthAuthorizationErrors = [
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
] as const;
export type OAuthAuthorizationError = (typeof oauthAuthorizationErrors)[number];

export const oauthConsent = z
  .looseObject({
    kind: z.literal('consent'),
    app: z.looseObject({
      id: publicId('marketplace_app'),
      name: z.string(),
      developer: z.string(),
      iconUrl: z.string().nullable(),
      websiteUrl: z.string().nullable(),
    }),
    scopes: z
      .array(z.string())
      .meta({ description: 'What the app may change in this business: permissions.' }),
    readGroups: z
      .array(z.string())
      .meta({ description: 'What the app may read in this business: API groups.' }),
    webhookEvents: z
      .array(z.string())
      .meta({ description: 'The events the app is told of here, by webhook.' }),
    missingScopes: z.array(z.string()).meta({
      description:
        "The app's permissions the caller doesn't hold here: while there are any, they can't allow it.",
    }),
    canInstall: z
      .boolean()
      .meta({ description: 'Whether the caller may install apps in this business.' }),
    installed: z.boolean().meta({ description: 'Whether the app is installed here already.' }),
    denyUrl: z
      .string()
      .meta({ description: 'Where Cancel sends the person: the app, with access_denied.' }),
  })
  .meta({ id: 'OAuthConsent' });

export const oauthAuthorizationRefusal = z
  .looseObject({
    kind: z.literal('refused'),
    error: z.enum(oauthAuthorizationErrors),
    description: z.string(),
    redirectUrl: z.string().meta({
      description: "The app's redirect address with the error, for the page to send the person to.",
    }),
  })
  .meta({ id: 'OAuthAuthorizationRefusal' });

export const oauthAuthorizationView = z
  .discriminatedUnion('kind', [oauthConsent, oauthAuthorizationRefusal])
  .meta({
    id: 'OAuthAuthorizationView',
    description:
      'What the consent page shows: the app and its permissions, or a refusal to send back to the app. A client or redirect address that is not registered is a problem, never a redirect.',
  });
export type OAuthAuthorizationView = z.output<typeof oauthAuthorizationView>;

export const oauthAuthorizationGrant = z
  .looseObject({
    redirectUrl: z
      .string()
      .meta({ description: "The app's redirect address with code, state and iss." }),
  })
  .meta({ id: 'OAuthAuthorizationGrant' });
export type OAuthAuthorizationGrant = z.output<typeof oauthAuthorizationGrant>;

export const marketplaceClientSecret = z
  .looseObject({
    clientId: publicId('marketplace_app'),
    clientSecret: z.string().meta({ description: 'Shown once. Only its hash is kept.' }),
    clientSecretPrefix: z.string(),
    clientSecretSetAt: timestamp,
  })
  .meta({ id: 'MarketplaceClientSecret' });
export type MarketplaceClientSecret = z.output<typeof marketplaceClientSecret>;

const group = 'App Marketplace';

export const readOAuthAuthorization = defineEndpoint({
  operationId: 'readOAuthAuthorization',
  method: 'get',
  path: '/oauth/authorize',
  group,
  summary: 'Read an app’s authorization request, for the consent page',
  query: oauthAuthorizationRequest,
  response: {
    status: 200,
    description: 'The app and what it asks for in this business, or a refusal for the app.',
    schema: oauthAuthorizationView,
  },
});
export const grantOAuthAuthorization = defineEndpoint({
  operationId: 'grantOAuthAuthorization',
  method: 'post',
  path: '/oauth/authorize',
  group,
  summary: 'Allow an app in this business: install it if needed, and issue a code',
  body: oauthAuthorizationRequest,
  response: {
    status: 201,
    description: 'Where to send the person: the app, with the code.',
    schema: oauthAuthorizationGrant,
  },
});
export const generateMarketplaceClientSecret = defineEndpoint({
  operationId: 'generateMarketplaceClientSecret',
  method: 'post',
  path: '/agency/marketplace/apps/{appId}/client-secret',
  group,
  summary: 'Generate the app’s client secret, replacing the one it had',
  params: z.strictObject({ appId: publicId('marketplace_app') }),
  response: {
    status: 201,
    description: 'The new secret, shown this once.',
    schema: marketplaceClientSecret,
  },
});

export const marketplaceOAuthEndpoints = [
  readOAuthAuthorization,
  grantOAuthAuthorization,
  generateMarketplaceClientSecret,
] as const;

/** A successful token answer (RFC 6749 section 5.1). */
export const oauthTokenResponse = z
  .looseObject({
    access_token: z.string().regex(oauthAccessTokenFormat),
    token_type: z.literal('Bearer'),
    expires_in: z.int().positive(),
    refresh_token: z.string().regex(oauthRefreshTokenFormat),
    scope: z.string(),
  })
  .meta({ id: 'OAuthTokenResponse' });
export type OAuthTokenResponse = z.output<typeof oauthTokenResponse>;

/** RFC 6749 section 5.2's error codes. */
export const oauthTokenErrors = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
] as const;
export type OAuthTokenError = (typeof oauthTokenErrors)[number];
