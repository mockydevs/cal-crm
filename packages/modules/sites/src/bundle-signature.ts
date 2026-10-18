// The share bundle's envelope: the payload as JSON and a keyed digest of exactly those
// bytes, each in base64url, joined by a dot. The digest says this install wrote the bundle
// and nobody changed it since; it grants nothing by itself, and whoever imports a bundle
// still validates every document in it.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Separates these digests from any other use of the same key. */
const LABEL = 'crm.sites.bundle.v1';
const ENVELOPE = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;

const digest = (secret: string, body: string): Buffer =>
  createHmac('sha256', secret).update(LABEL).update('\0').update(body).digest();

/** The bundle for a payload. */
export function signBundle(secret: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${digest(secret, body).toString('base64url')}`;
}

/**
 * The payload of a bundle this install signed, as parsed JSON, or undefined for anything
 * else: another install's, an edited one, or text that is not a bundle at all.
 */
export function openBundle(secret: string, bundle: string): unknown {
  const parts = ENVELOPE.exec(bundle);
  if (parts === null) return undefined;
  const [, body = '', signature = ''] = parts;
  const given = Buffer.from(signature, 'base64url');
  const expected = digest(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return parsed;
  } catch {
    return undefined;
  }
}
