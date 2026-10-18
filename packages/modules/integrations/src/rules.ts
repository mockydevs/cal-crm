// The integrations module's pure rules: the PKCE verifier made from a state, digests of
// states and webhook capabilities, a webhook's signature, the credentials sealed for the
// worker, what a card says from its connections, when a connection is next checked, and the
// plain words kept with a failure.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { IntegrationErrorCode, IntegrationReading, IntegrationState } from '@repo/contracts';
import * as z from 'zod';

/** A SHA-256 digest, as the attempts table keeps a state's. */
export const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** A SHA-256 digest in hex, as a connection keeps its webhook capability's. */
export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/**
 * The PKCE verifier of an attempt, made from its state with the operator's client secret, so
 * nothing more is stored and nobody without the secret can finish the exchange. 43
 * characters of base64url, the shortest RFC 7636 allows.
 */
export function codeVerifierOf(clientSecret: string, state: string): string {
  return createHmac('sha256', clientSecret).update(`pkce:${state}`).digest('base64url');
}

/** RFC 7636's S256 challenge of a verifier. */
export const codeChallengeOf = (verifier: string): string =>
  createHash('sha256').update(verifier).digest('base64url');

/**
 * The capability in a connection's webhook address, made from its id with the install's
 * public-intake secret: the page can show the address at any time, and only its digest is
 * kept. 43 characters of base64url.
 */
export function webhookToken(secret: string, connectionId: string): string {
  return createHmac('sha256', secret)
    .update(`integration-webhook:${connectionId}`)
    .digest('base64url');
}

/** How a provider signs what it sends: an HMAC-SHA256 of the raw body, in one header. */
export interface WebhookSignature {
  readonly header: string;
  readonly encoding: 'hex' | 'base64';
  /** What comes before the digest in the header, such as "sha256=". */
  readonly prefix: string;
}

/**
 * Whether a stored request carries a signature made with the secret over its body. The
 * comparison takes the same time however much of it matches.
 */
export function signatureValid(
  signing: WebhookSignature,
  secret: string,
  headers: Readonly<Record<string, unknown>>,
  body: Uint8Array,
): boolean {
  const given = headers[signing.header.toLowerCase()];
  if (typeof given !== 'string' || !given.startsWith(signing.prefix)) return false;
  const expected = Buffer.from(
    `${signing.prefix}${createHmac('sha256', secret).update(body).digest(signing.encoding)}`,
  );
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** What is sealed for a connection (vault purpose integrations.<provider>.credentials). */
export const sealedCredentials = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('oauth2'),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).nullable(),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  }),
  z.strictObject({ kind: z.literal('api_key'), apiKey: z.string().min(1) }),
]);
export type SealedCredentials = z.output<typeof sealedCredentials>;

/** The vault purpose of a provider's credentials. */
export const credentialsPurpose = (provider: string): string =>
  `integrations.${provider}.credentials`;

/** An access token still good for a call that starts now: a minute is left for the call. */
export function tokenFresh(credentials: SealedCredentials, now: Date): boolean {
  if (credentials.kind === 'api_key' || credentials.expiresAt === null) return true;
  return Date.parse(credentials.expiresAt) - now.getTime() > 60_000;
}

/** What one connection is, for a card: its status alone counts. */
export interface ConnectionState {
  readonly status: string;
  readonly label: string | null;
}

/** What a card says of its integration, from its live connections. */
export function readingOf(connections: readonly ConnectionState[]): IntegrationReading {
  const connected = connections.filter((each) => each.status === 'connected');
  const attention = connections.filter((each) => each.status === 'needs_attention').length;
  const live = connections.filter((each) => each.status !== 'disconnected');
  return {
    connected: connected.length,
    attention,
    label: live.length === 1 ? (live[0]?.label ?? null) : null,
  };
}

/** The card's one word: attention first, then working, then waiting for its first check. */
export function stateOf(reading: IntegrationReading, connecting = false): IntegrationState {
  if (reading.attention > 0) return 'needs_attention';
  if (reading.connected > 0) return 'connected';
  return connecting ? 'connecting' : 'not_connected';
}

const DAY_MS = 86_400_000;

/** When a connection is checked next: about a day on, spread ±25% so checks don't bunch. */
export function nextCheckAt(now: Date, random: number): Date {
  return new Date(now.getTime() + DAY_MS * (0.75 + Math.min(Math.max(random, 0), 1) * 0.5));
}

/** After a check the provider did not answer: an hour on, before the daily round. */
export const RETRY_CHECK_MS = 3_600_000;

/** The plain words kept with a failure. The provider's own answer is never kept. */
export function failureDetail(code: IntegrationErrorCode, provider: string): string {
  switch (code) {
    case 'reauthorize':
      return `${provider} stopped accepting this connection. Reconnect to resume.`;
    case 'missing_permission':
      return `${provider} refused a request this connection needs. Reconnect and allow everything it asks for.`;
    case 'rate_limited':
      return `${provider} asked us to slow down. It is checked again within the hour.`;
    case 'provider_error':
      return `${provider} did not answer. It is checked again within the hour.`;
    case 'plan_limit':
      return `${provider} says your plan does not allow this connection.`;
    case 'config_missing':
      return `This install is no longer set up for ${provider}. Ask the person who runs it.`;
  }
}

/** A field of the provider's answer by a dotted path, as text, or undefined. */
export function fieldAt(body: unknown, path: string): string | undefined {
  let value: unknown = body;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** A provider's words, kept to what a column holds. */
export const clipped = (value: string, length: number): string =>
  value.length <= length ? value : `${value.slice(0, length - 1)}…`;
