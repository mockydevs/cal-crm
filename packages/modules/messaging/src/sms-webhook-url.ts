// The addresses Twilio calls back on. One place builds them, for sending (StatusCallback),
// for showing (the inbound URL the customer pastes into Twilio) and for verifying: the
// signature covers the URL exactly as Twilio was given it, so all three must agree.
//
// A URL names its connection by an unguessable token. The token is not the proof that a
// request is Twilio's (the signature is); it only decides which connection's Auth Token
// the worker checks the signature with. Only the token's SHA-256 is stored readable.
import { createHash, randomBytes } from 'node:crypto';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The origin Twilio can call, from PUBLIC_URL, or null when there is none: it must be
 * https, without credentials, and (Twilio's rule for StatusCallback) without an underscore
 * in the host name. Only the origin is used; the webhook routes sit at its root.
 */
export function smsWebhookOrigin(publicUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  if (url.hostname === '' || url.hostname.includes('_')) return null;
  return url.origin;
}

/**
 * Whether this install can send a text message at all. Every send names a status callback
 * (sms-send.ts refuses one without, as `status_callback_unavailable`), so an install whose
 * public address Twilio can't call has no text messages to offer: not in the composer, and
 * not as a connected channel.
 */
export function smsDeliveryAvailable(publicUrl: string | undefined): boolean {
  return publicUrl !== undefined && smsWebhookOrigin(publicUrl) !== null;
}

/** 32 random bytes, base64url: Node's randomBytes is a CSPRNG. */
export function newWebhookToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isWebhookToken(value: string): boolean {
  return TOKEN.test(value);
}

export function webhookDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type WebhookEndpoint =
  { readonly kind: 'inbound' } | { readonly kind: 'status'; readonly messageId: string };

/** How intake.webhooks.endpoint names a request: its kind and message, never the token. */
export function webhookEndpoint(endpoint: WebhookEndpoint): string {
  return endpoint.kind === 'inbound' ? 'inbound' : `status?m=${endpoint.messageId}`;
}

export function parseWebhookEndpoint(stored: string): WebhookEndpoint | null {
  if (stored === 'inbound') return { kind: 'inbound' };
  const messageId = stored.startsWith('status?m=') ? stored.slice('status?m='.length) : '';
  return UUID.test(messageId) ? { kind: 'status', messageId } : null;
}

/** The full URL of a webhook: what Twilio was given, and so what it signed. */
export function webhookUrlOf(origin: string, token: string, endpoint: WebhookEndpoint): string {
  if (!isWebhookToken(token)) throw new Error('Not a webhook token.');
  // A UUID and a base64url token need no escaping, so there is one spelling of each URL.
  if (endpoint.kind === 'status' && !UUID.test(endpoint.messageId))
    throw new Error('A status callback needs its message id.');
  return `${origin}/webhooks/twilio/${token}/${webhookEndpoint(endpoint)}`;
}

/** Our message id rides in the URL, so a callback can settle a send whose SID we never got. */
export function statusCallbackUrl(origin: string, token: string, messageId: string): string {
  return webhookUrlOf(origin, token, { kind: 'status', messageId });
}

export function inboundWebhookUrl(origin: string, token: string): string {
  return webhookUrlOf(origin, token, { kind: 'inbound' });
}
