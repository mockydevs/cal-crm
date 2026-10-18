// Proof a page was shown, and when: what the tracking script's page view is answered with,
// and what a form sent from that page must hand back. As a form's render token
// (render-token.ts): a moment and a keyed digest of the moment, the business and the source
// that loaded the page (visitor-source.ts), so a token cannot be fetched once and handed
// round, and a program that posts the moment it loads a page is told to wait.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Separates these digests from any other use of the same key. */
const LABEL = 'crm.tracking.view.v1';
const TOKEN = /^([0-9]{13})\.([A-Za-z0-9_-]{43})$/;
/** How far ahead of this server's clock another instance may have issued a token. */
const SKEW_MS = 30_000;

export const VIEW_LIMITS = {
  /** Seconds a page must have been shown before a form from it is taken. */
  minSeconds: 2,
  /** How long a shown page's forms are taken for. */
  hours: 24,
} as const;

export interface ShownPage {
  readonly businessId: string;
  /** visitorSource().key of whoever loaded the page. */
  readonly visitor: string;
}

function digest(secret: string, page: ShownPage, issuedAt: number): Buffer {
  return createHmac('sha256', secret)
    .update(LABEL)
    .update('\0')
    .update(page.businessId)
    .update('\0')
    .update(page.visitor)
    .update('\0')
    .update(String(issuedAt))
    .digest();
}

export function issueViewToken(secret: string, page: ShownPage, now: number): string {
  const issuedAt = Math.trunc(now);
  return `${String(issuedAt).padStart(13, '0')}.${digest(secret, page, issuedAt).toString('base64url')}`;
}

export type ViewDecision =
  /** `mark` is the token's digest: the same for the same token. */
  | { readonly accepted: true; readonly mark: string }
  | { readonly accepted: false; readonly reason: 'too_fast'; readonly retryAfterSeconds: number }
  /** Not this server's token for this business and source, or too old. */
  | { readonly accepted: false; readonly reason: 'stale' };

const STALE: ViewDecision = { accepted: false, reason: 'stale' };

export function checkViewToken(
  secret: string,
  page: ShownPage,
  token: string,
  now: number,
): ViewDecision {
  const [, moment, signature] = TOKEN.exec(token) ?? [];
  if (moment === undefined || signature === undefined) return STALE;
  const issuedAt = Number(moment);
  const given = Buffer.from(signature, 'base64url');
  const expected = digest(secret, page, issuedAt);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return STALE;
  // One spelling per token: a digest's last character has bits that decode to nothing.
  if (expected.toString('base64url') !== signature) return STALE;
  const age = now - issuedAt;
  if (age < -SKEW_MS || age > VIEW_LIMITS.hours * 3_600_000) return STALE;
  const wait = VIEW_LIMITS.minSeconds * 1000 - age;
  if (wait > 0)
    return { accepted: false, reason: 'too_fast', retryAfterSeconds: Math.ceil(wait / 1000) };
  return { accepted: true, mark: signature };
}
