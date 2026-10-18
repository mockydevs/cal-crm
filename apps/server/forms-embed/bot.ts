// The browser's half of a form's bot protection: ALTCHA's own solver, from the same library
// the CRM checks with (altcha-lib, MIT), with WebCrypto's PBKDF2. It runs only for a form
// that asks for it, while the visitor fills the form in, and shows no puzzle. WebCrypto
// works only on secure (https) pages: elsewhere this finds nothing, and the form says the
// check did not finish.
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/web/pbkdf2';

import type { BotProof, EmbedChallenge } from '../src/forms-embed/api.js';

export type Solve = (challenge: EmbedChallenge) => Promise<BotProof | undefined>;

/** How long a browser may work on one challenge before the form says the check did not finish. */
const SOLVE_MS = 60_000;

export const solveAltcha: Solve = async (challenge) => {
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
};
