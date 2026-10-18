// Bot protection for public forms and booking pages. A form or a calendar may ask the
// visitor's browser for a proof of work before it takes a submission or a booking: "altcha"
// is ALTCHA's self-hosted proof of work (altcha-lib, MIT), with no puzzle to see or hear
// and nothing sent to anyone else. It comes on top of the render token, the hidden field
// and the quotas, never instead of them. Each kind is a variant of its own, so another
// provider can be added beside it.
import * as z from 'zod';

export const BOT_PROTECTIONS = ['off', 'altcha'] as const;
/** Off, or the kind of proof the page asks the browser for. */
export const botProtection = z.enum(BOT_PROTECTIONS);
export type BotProtection = z.output<typeof botProtection>;

const hex = (most: number) =>
  z
    .string()
    .max(most)
    .regex(/^(?:[0-9a-f]{2})+$/);

/**
 * ALTCHA's v2 challenge as altcha-lib's createChallenge makes it: its parameters, and the
 * server's HMAC of them. The parameters are only ever read back to be checked against that
 * HMAC; `data.render` ties the challenge to one showing of the page (its render token).
 */
export const altchaChallenge = z.strictObject({
  parameters: z.strictObject({
    algorithm: z.string().min(1).max(32),
    nonce: hex(128),
    salt: hex(128),
    cost: z.int().min(1).max(10_000_000),
    keyLength: z.int().min(1).max(64),
    keyPrefix: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[0-9a-f]+$/),
    keySignature: hex(128).optional(),
    expiresAt: z.int().min(1).optional(),
    data: z.strictObject({ render: z.string().min(1).max(64) }).optional(),
  }),
  signature: hex(128),
});
export type AltchaChallenge = z.output<typeof altchaChallenge>;

/** What the browser found: the counter and the key it derives (altcha-lib's Solution). */
export const altchaSolution = z.strictObject({
  counter: z.int().min(0).max(0xffff_ffff),
  derivedKey: hex(128),
  /** How long the browser took, in milliseconds. Not trusted, not kept. */
  time: z.number().min(0).max(86_400_000).optional(),
});

/** The challenge a page asks its visitor's browser to solve. */
export const botChallenge = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('altcha'), challenge: altchaChallenge }),
]);
export type BotChallengeView = z.output<typeof botChallenge>;

/** The solved challenge, sent with the submission or booking. */
export const botProof = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('altcha'),
    challenge: altchaChallenge,
    solution: altchaSolution,
  }),
]);
export type BotProof = z.output<typeof botProof>;

/** What a page sends to be given a challenge: the render token of the page it showed. */
export const botChallengeRequest = z.strictObject({
  renderToken: z.string().regex(/^[0-9]{13}\.[A-Za-z0-9_-]{43}$/),
});
