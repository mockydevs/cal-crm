// Proof that someone signed in asked to see a page's draft, made as a form's preview link
// is (packages/modules/forms/src/preview-token.ts): the link carries which page, until
// when, and a keyed digest of both. Nothing is stored, and the token cannot be made or
// changed without the server's key.
//
// It names the page by its own ids, because a draft cannot be found by the site's public
// key: that lookup serves published pages only. Whoever holds the link sees the page's
// newest saved version until it runs out. It is given to someone who may read the page
// anyway, lasts an hour, and opens nothing but that page.
//
// The token is one path segment, and the server reads no path segment longer than 100
// characters, so it is kept to 93: the time it runs out is in whole seconds, and the
// digest is the first 16 bytes of an HMAC-SHA-256.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Separates these digests from any other use of the same key. */
const LABEL = 'crm.sites.preview.v1';
/** 52 bytes of what is named, a dot, and 16 bytes of digest, each in base64url. */
const TOKEN = /^([A-Za-z0-9_-]{70})\.([A-Za-z0-9_-]{22})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAMED_BYTES = 52;
const DIGEST_BYTES = 16;

/** How long a preview link works. */
export const PREVIEW_MINUTES = 60;

/** The page a preview shows. */
export interface PreviewedPage {
  readonly agencyId: string;
  readonly businessId: string;
  readonly pageId: string;
}

const digest = (secret: string, named: Buffer): Buffer =>
  createHmac('sha256', secret)
    .update(LABEL)
    .update('\0')
    .update(named)
    .digest()
    .subarray(0, DIGEST_BYTES);

const bytesOf = (id: string): Buffer => {
  if (!UUID.test(id)) throw new Error('A preview names a page by its ids.');
  return Buffer.from(id.replaceAll('-', ''), 'hex');
};
const idOf = (bytes: Buffer): string => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * A token for this page's draft that works until `expiresAt`, in milliseconds. It runs out
 * on the whole second at or before that moment.
 */
export function issuePreviewToken(secret: string, page: PreviewedPage, expiresAt: number): string {
  const until = Buffer.alloc(4);
  until.writeUInt32BE(Math.floor(expiresAt / 1000));
  const named = Buffer.concat([
    bytesOf(page.agencyId),
    bytesOf(page.businessId),
    bytesOf(page.pageId),
    until,
  ]);
  return `${named.toString('base64url')}.${digest(secret, named).toString('base64url')}`;
}

/**
 * The page a token names, or undefined: not a token of this server, or one that has run
 * out. Both look the same from outside.
 */
export function readPreviewToken(
  secret: string,
  token: unknown,
  now: number,
): PreviewedPage | undefined {
  const [, body, signature] = (typeof token === 'string' ? TOKEN.exec(token) : null) ?? [];
  if (body === undefined || signature === undefined) return undefined;
  const named = Buffer.from(body, 'base64url');
  const given = Buffer.from(signature, 'base64url');
  const expected = digest(secret, named);
  // A digest of another length cannot be compared in constant time, and cannot be ours.
  if (named.length !== NAMED_BYTES || given.length !== expected.length) return undefined;
  if (!timingSafeEqual(given, expected)) return undefined;
  // One spelling per token: the last character of a digest has bits that decode to nothing,
  // so a changed link could otherwise still read as the one we gave out.
  if (expected.toString('base64url') !== signature) return undefined;
  if (now >= named.readUInt32BE(48) * 1000) return undefined;
  return {
    agencyId: idOf(named.subarray(0, 16)),
    businessId: idOf(named.subarray(16, 32)),
    pageId: idOf(named.subarray(32, 48)),
  };
}
