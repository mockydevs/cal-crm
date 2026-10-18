// A provider the install can connect on Settings → Integrations: what its card says, how a
// business connects it, how the worker reads the account and checks it, and how what it
// sends is signed. A provider is code, registered by the install's composition; the
// operator's part is its OAuth app, given through the environment, as Google Calendar's is.
// An install with none registered lists only the connections that live on their own pages.
import type { IntegrationCategory } from '@repo/contracts';

import type { OAuthEndpoints } from './oauth.js';
import type { WebhookSignature } from './rules.js';

/** Where the account a credential belongs to is read, and which fields name it. */
export interface IdentityRead {
  /** A GET with the token or key as a bearer token. */
  readonly url: string;
  /** Dotted paths in the answer: the account's lasting id, and its name for people. */
  readonly id: string;
  readonly label: string;
}

interface ProviderBase {
  /** The catalogue's key: the address, the vault purpose, the dashboard's words. */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: IntegrationCategory;
  /** Whether a business may connect more than one account. */
  readonly multipleAccounts: boolean;
  /** Where the operator reads how to set it up, in the project's docs. */
  readonly operatorGuide: string | null;
  readonly identity: IdentityRead;
}

/** Connected with the provider's own sign-in, through the operator's OAuth app. */
export interface OAuthProvider extends ProviderBase {
  readonly auth: 'oauth2';
  readonly endpoints: OAuthEndpoints;
  /** The operator's app: undefined until its id and secret are set, and the card is grey. */
  readonly client: { readonly clientId: string; readonly clientSecret: string } | undefined;
  /** Every scope asked for, and needed: consent to fewer is not kept. */
  readonly scopes: readonly string[];
  /** Whether the provider takes RFC 7636's S256 challenge. */
  readonly pkce: boolean;
  /** Its webhooks, signed with the operator app's client secret, where it sends any. */
  readonly webhook?: WebhookSignature | undefined;
}

/** Connected with a key or token the business pastes. Needs nothing of the operator. */
export interface ApiKeyProvider extends ProviderBase {
  readonly auth: 'api_key';
}

export type IntegrationProvider = OAuthProvider | ApiKeyProvider;

/** Whether the install can connect it: an OAuth provider needs the operator's app. */
export const providerReady = (provider: IntegrationProvider): boolean =>
  provider.auth === 'api_key' || provider.client !== undefined;
