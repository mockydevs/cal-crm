// Keys and tokens of the web chat widget. A widget key is public and names one widget. A
// session token is a visitor's only proof that a chat is theirs: the server issues it,
// shows it once, and keeps a digest it cannot be worked back from.
import { createHash, randomBytes } from 'node:crypto';

/** Exactly what newSessionToken makes: 32 bytes in canonical unpadded base64url. */
const SESSION_TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Separates these digests from any other SHA-256 of the same text. */
const DIGEST_LABEL = 'crm.webchat.session.v1';

/** A new widget key: 24 bytes from the system's random source, 32 characters. */
export function newWidgetKey(): string {
  return randomBytes(24).toString('base64url');
}

/** A new session token: 32 bytes from the system's random source, 43 characters. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What is stored for a token: SHA-256 over a label, the widget's id and the token. A token
 * has 256 random bits, so a plain hash cannot be searched. The widget's id is part of it,
 * so a token issued for one widget has no digest that any other widget stores. Undefined
 * for anything that is not a well-formed token and widget id: nothing else is ever hashed.
 */
export function sessionDigest(widgetId: string, token: unknown): string | undefined {
  if (typeof token !== 'string' || !SESSION_TOKEN.test(token) || !UUID.test(widgetId))
    return undefined;
  return createHash('sha256')
    .update(DIGEST_LABEL)
    .update('\0')
    .update(widgetId)
    .update('\0')
    .update(token)
    .digest('hex');
}

/**
 * The token in an `Authorization: Bearer` header, or undefined. Exactly one header, the
 * scheme as written, one space and a well-formed token. A token never comes from a path, a
 * query or a cookie, so it is not in logs, history or a Referer.
 */
export function bearerSessionToken(header: unknown): string | undefined {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length);
  return SESSION_TOKEN.test(token) ? token : undefined;
}
