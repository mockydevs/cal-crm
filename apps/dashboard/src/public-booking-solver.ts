// The browser's half of a calendar's bot protection: ALTCHA's own solver, from the same
// library the server checks with (altcha-lib, MIT), with WebCrypto's PBKDF2. The page loads
// this file only for a calendar that asks for it (public-booking-bot.ts imports it lazily),
// so no other booking page carries it.
import type { AltchaChallenge, BotProof } from '@repo/contracts';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2';

/** How long a browser may work on one challenge before the page says the check did not finish. */
const SOLVE_MS = 60_000;

/** The proof for this challenge, or undefined when none was found in time. */
export async function solveAltcha(challenge: AltchaChallenge): Promise<BotProof | undefined> {
  const { algorithm, nonce, salt, cost, keyLength, keyPrefix } = challenge.parameters;
  try {
    const solution = await solveChallenge({
      challenge: { parameters: { algorithm, nonce, salt, cost, keyLength, keyPrefix } },
      deriveKey,
      timeout: SOLVE_MS,
    });
    return solution === null
      ? undefined
      : {
          kind: 'altcha',
          challenge,
          solution: { counter: solution.counter, derivedKey: solution.derivedKey },
        };
  } catch {
    return undefined;
  }
}
