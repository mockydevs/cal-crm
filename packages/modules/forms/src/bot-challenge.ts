// Bot protection for public forms and booking pages. A form or a calendar may ask the
// visitor's browser for a proof of work before it takes a submission or a booking. It is
// one more check on top of the quotas, the render token and the hidden field, never instead
// of them.
//
// The proof is ALTCHA's, self-hosted: altcha-lib (MIT, github.com/altcha-org/altcha-lib)
// makes and checks its v2 challenges here, and the browser solves them with the same
// library's solver. Nothing is sent to anyone else, and there is no puzzle to see or hear.
//
// A challenge is bound to one showing of the page: its signed data names the render token's
// mark. The mark is spent with the submission or booking it was sent with (forms.submissions
// and calendar.appointments.render_mark), and a second use of it is refused before the
// proof is even read. So a solved challenge is good for one lead at the most, and the mark
// that is stored is the one store of used challenges this needs (ALTCHA's docs/store.md
// asks for one, keyed by the challenge; here every challenge has its own showing).
import { createHmac } from 'node:crypto';

import type { AltchaChallenge, BotChallengeView, BotProof } from '@repo/contracts';
import { createChallenge, randomInt, verifySolution, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';

/** What a page's bot protection does, whichever kind it is. */
export interface BotChallenge {
  /** A challenge for the showing of a page whose render token has this mark. */
  readonly issue: (render: string) => Promise<BotChallengeView>;
  /** Whether the proof solves a challenge this install issued for that showing, in time. */
  readonly verify: (render: string, proof: BotProof | undefined) => Promise<boolean>;
}

/**
 * How much work a challenge asks for. ALTCHA's documented starting point is PBKDF2/SHA-256
 * with a cost of 5,000 and a counter from 5,000 to 10,000, solved by several workers at
 * once. The embed is one script with nothing to load after it, so it solves on one thread
 * (WebCrypto is asynchronous: the page stays responsive): a fifth of the cost per try keeps
 * a desktop browser to one or two seconds, a phone to a few, while the visitor types.
 */
export const ALTCHA_POLICY = {
  algorithm: 'PBKDF2/SHA-256',
  cost: 1000,
  counter: { min: 4000, max: 8000 },
  /** A challenge is solved once, as the page loads; an hour covers a slow visitor. */
  ttlSeconds: 3600,
} as const;

/** Separates these keys from every other use of the install's public intake secret. */
const SIGNATURE_LABEL = 'crm.bot.altcha.signature.v1';
const KEY_LABEL = 'crm.bot.altcha.key.v1';

/** A challenge as the contract reads it, as altcha-lib types it: optional parts absent. */
export function toAltchaChallenge(challenge: AltchaChallenge): Challenge {
  const { keySignature, expiresAt, data, ...parameters } = challenge.parameters;
  return {
    parameters: {
      ...parameters,
      ...(keySignature === undefined ? {} : { keySignature }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(data === undefined ? {} : { data }),
    },
    signature: challenge.signature,
  };
}

const derived = (secret: string, label: string): string =>
  createHmac('sha256', secret).update(label).digest('hex');

export interface AltchaOptions {
  /** The clock, in milliseconds, for the expiry of a challenge. Tests pass their own. */
  readonly now?: () => number;
  /** Less work, for tests only: the policy's own cost and counter otherwise. */
  readonly cost?: number;
  readonly counter?: { readonly min: number; readonly max: number };
}

/**
 * ALTCHA's proof of work, keyed by the install's public intake secret (PUBLIC_INTAKE_SECRET),
 * from which two keys are derived: one signs a challenge, one signs the key a solution
 * must find (ALTCHA's deterministic mode, so a check is two HMACs and no key derivation).
 */
export function createAltchaBotChallenge(
  secret: string,
  options: AltchaOptions = {},
): BotChallenge {
  const now = options.now ?? (() => Date.now());
  const hmacSignatureSecret = derived(secret, SIGNATURE_LABEL);
  const hmacKeySignatureSecret = derived(secret, KEY_LABEL);
  const cost = options.cost ?? ALTCHA_POLICY.cost;
  const counter = options.counter ?? ALTCHA_POLICY.counter;
  return {
    async issue(render) {
      const challenge = await createChallenge({
        algorithm: ALTCHA_POLICY.algorithm,
        cost,
        counter: randomInt(counter.max, counter.min),
        deriveKey,
        data: { render },
        expiresAt: Math.floor(now() / 1000) + ALTCHA_POLICY.ttlSeconds,
        hmacSignatureSecret,
        hmacKeySignatureSecret,
      });
      // altcha-lib's own parameters, with the optional ones it leaves out absent.
      const { parameters, signature } = challenge;
      if (signature === undefined) throw new Error('ALTCHA returned an unsigned challenge.');
      return {
        kind: 'altcha',
        challenge: {
          parameters: {
            algorithm: parameters.algorithm,
            nonce: parameters.nonce,
            salt: parameters.salt,
            cost: parameters.cost,
            keyLength: parameters.keyLength,
            keyPrefix: parameters.keyPrefix,
            ...(parameters.keySignature === undefined
              ? {}
              : { keySignature: parameters.keySignature }),
            ...(parameters.expiresAt === undefined ? {} : { expiresAt: parameters.expiresAt }),
            data: { render },
          },
          signature,
        },
      };
    },
    async verify(render, proof) {
      if (proof?.kind !== 'altcha') return false;
      // The signature covers the data, so a challenge of another showing cannot be renamed.
      if (proof.challenge.parameters.data?.render !== render) return false;
      try {
        const result = await verifySolution({
          challenge: toAltchaChallenge(proof.challenge),
          solution: { counter: proof.solution.counter, derivedKey: proof.solution.derivedKey },
          deriveKey,
          hmacSignatureSecret,
          hmacKeySignatureSecret,
        });
        return result.verified;
      } catch {
        // A parameter altcha-lib cannot work with (an algorithm it does not know) is not
        // one this install signed.
        return false;
      }
    },
  };
}
