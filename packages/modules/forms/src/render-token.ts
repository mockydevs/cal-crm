// Proof of when a form was shown. The public form answer carries a token; a submission must
// hand it back. It lets the server, and not the visitor's browser, say how long the form
// was on the page: a program that posts the moment it loads is refused, and so is a form
// that was left open across a change of its questions.
//
// The token is a moment and a keyed digest of that moment, the form, the version of the
// form that was shown and the source it was shown to (visitor-source.ts): a token fetched by
// one source is refused from another, so tokens cannot be fetched once and handed round. The
// source itself is not in the token, only in its digest. The digest is kept with the
// submission it was sent with, and a second submission with the same token is refused
// (public.ts): each showing of a form is good for one lead.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Separates these digests from any other use of the same key. */
const LABEL = 'crm.forms.render.v1';
const TOKEN = /^([0-9]{13})\.([A-Za-z0-9_-]{43})$/;
/** How far ahead of this server's clock another instance may have issued a token. */
const SKEW_MS = 30_000;

export interface RenderLimits {
  /** Seconds a form must have been on the page before it is accepted. */
  readonly minFillSeconds: number;
  /** How long a shown form may wait before it is sent. */
  readonly renderHours: number;
}

/**
 * What the token is bound to: the form, the moment its served definition was published,
 * and the visitor's source (visitorSource().key).
 */
export interface RenderedForm {
  readonly formId: string;
  readonly publishedAt: Date;
  readonly visitor: string;
}

function digest(secret: string, form: RenderedForm, issuedAt: number): Buffer {
  return createHmac('sha256', secret)
    .update(LABEL)
    .update('\0')
    .update(form.formId)
    .update('\0')
    .update(String(form.publishedAt.getTime()))
    .update('\0')
    .update(form.visitor)
    .update('\0')
    .update(String(issuedAt))
    .digest();
}

/** A token for a form shown now. */
export function issueRenderToken(secret: string, form: RenderedForm, now: number): string {
  const issuedAt = Math.trunc(now);
  return `${String(issuedAt).padStart(13, '0')}.${digest(secret, form, issuedAt).toString('base64url')}`;
}

export type RenderDecision =
  /**
   * `shownAt` is the moment the form was shown, in milliseconds, as this server signed it.
   * `mark` is the token's digest: the same for the same token, and kept with the submission
   * it was spent on.
   */
  | { readonly accepted: true; readonly shownAt: number; readonly mark: string }
  /** Sent sooner after it was shown than a person fills in a form. Wait this long. */
  | { readonly accepted: false; readonly reason: 'too_fast'; readonly retryAfterSeconds: number }
  /**
   * Not a token of this server for this version of this form, or one shown too long ago.
   * The embed shows the form again; both cases look the same from outside.
   */
  | { readonly accepted: false; readonly reason: 'stale' };

/** The token's moment and mark when it is this server's for this form and not too old. */
function readToken(
  secret: string,
  form: RenderedForm,
  token: unknown,
  now: number,
  renderHours: number,
): { readonly issuedAt: number; readonly mark: string } | undefined {
  const parts = typeof token === 'string' ? TOKEN.exec(token) : null;
  const [, moment, signature] = parts ?? [];
  if (moment === undefined || signature === undefined) return undefined;
  const issuedAt = Number(moment);
  const given = Buffer.from(signature, 'base64url');
  const expected = digest(secret, form, issuedAt);
  // A digest of another length cannot be compared in constant time, and cannot be ours.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  // One spelling per token: a digest's last character has bits that decode to nothing.
  if (expected.toString('base64url') !== signature) return undefined;
  const age = now - issuedAt;
  if (age < -SKEW_MS || age > renderHours * 3_600_000) return undefined;
  return { issuedAt, mark: signature };
}

/**
 * The mark of a token of this form that is not too old, however soon after the showing it
 * is asked for: what a page's bot challenge is bound to (bot-challenge.ts).
 */
export function renderMarkOf(
  secret: string,
  form: RenderedForm,
  token: unknown,
  now: number,
  renderHours: number,
): string | undefined {
  return readToken(secret, form, token, now, renderHours)?.mark;
}

/** Whether a submission's token says the form it answers was shown, and when. */
export function checkRenderToken(
  secret: string,
  form: RenderedForm,
  token: unknown,
  now: number,
  limits: RenderLimits,
): RenderDecision {
  const read = readToken(secret, form, token, now, limits.renderHours);
  if (read === undefined) return { accepted: false, reason: 'stale' };
  const { issuedAt, mark: signature } = read;
  const age = now - issuedAt;
  const wait = limits.minFillSeconds * 1000 - age;
  if (wait > 0)
    return {
      accepted: false,
      reason: 'too_fast',
      // Whole seconds, never under one: a retry time of zero invites a retry loop.
      retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)),
    };
  return { accepted: true, shownAt: issuedAt, mark: signature };
}
