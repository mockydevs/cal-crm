import { botChallenge, botProof, type BotProof } from '@repo/contracts';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { expect, it } from 'vitest';

import { ALTCHA_POLICY, createAltchaBotChallenge, toAltchaChallenge } from './bot-challenge.js';

const SECRET = 'a-public-intake-secret-of-32-characters-or-more';
const RENDER = 'A'.repeat(43);
// Cheap work for tests: the policy's own values are checked separately below.
const cheap = { cost: 1, counter: { min: 1, max: 20 } } as const;

async function solved(
  check: ReturnType<typeof createAltchaBotChallenge>,
  render = RENDER,
): Promise<BotProof> {
  const view = botChallenge.parse(await check.issue(render));
  const solution = await solveChallenge({
    challenge: toAltchaChallenge(view.challenge),
    deriveKey,
  });
  if (solution === null) throw new Error('Expected a solution');
  return botProof.parse({ kind: 'altcha', challenge: view.challenge, solution });
}

it('issues a signed ALTCHA v2 challenge bound to one showing, that expires', async () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const check = createAltchaBotChallenge(SECRET, { now: () => now });
  const view = await check.issue(RENDER);
  expect(view.kind).toBe('altcha');
  expect(view.challenge.parameters).toMatchObject({
    algorithm: ALTCHA_POLICY.algorithm,
    cost: ALTCHA_POLICY.cost,
    keyLength: 32,
    data: { render: RENDER },
    expiresAt: Math.floor(now / 1000) + ALTCHA_POLICY.ttlSeconds,
  });
  // Deterministic mode: the derived key is signed, so the server checks with one HMAC.
  expect(view.challenge.parameters.keySignature).toMatch(/^[0-9a-f]{64}$/);
  expect(view.challenge.signature).toMatch(/^[0-9a-f]{64}$/);
  // A fresh nonce each time.
  expect((await check.issue(RENDER)).challenge.parameters.nonce).not.toBe(
    view.challenge.parameters.nonce,
  );
});

it('keeps the work a browser does to a few seconds, as ALTCHA documents it', () => {
  expect(ALTCHA_POLICY).toEqual({
    algorithm: 'PBKDF2/SHA-256',
    cost: 1000,
    counter: { min: 4000, max: 8000 },
    ttlSeconds: 3600,
  });
});

it('accepts a solution of its own challenge for the same showing, and nothing else', async () => {
  const check = createAltchaBotChallenge(SECRET, cheap);
  const proof = await solved(check);
  expect(await check.verify(RENDER, proof)).toBe(true);
  // Missing, or for another showing of the page (another render token).
  expect(await check.verify(RENDER, undefined)).toBe(false);
  expect(await check.verify('B'.repeat(43), proof)).toBe(false);
  // Another install's key.
  expect(await createAltchaBotChallenge(`${SECRET}-other`, cheap).verify(RENDER, proof)).toBe(
    false,
  );
  // A wrong key. (In ALTCHA's deterministic mode the key is the proof: altcha-lib checks it
  // against the signed keySignature and does not re-derive it from the counter.)
  expect(
    await check.verify(RENDER, {
      ...proof,
      solution: { ...proof.solution, derivedKey: '00'.repeat(32) },
    }),
  ).toBe(false);
  // Parameters changed after signing: easier work, or another showing named inside.
  const { parameters } = proof.challenge;
  for (const changed of [
    { ...parameters, cost: 1, keyPrefix: '0' },
    { ...parameters, data: { render: 'B'.repeat(43) } },
    { ...parameters, keySignature: undefined },
  ])
    expect(
      await check.verify(RENDER, {
        ...proof,
        challenge: { ...proof.challenge, parameters: changed },
      }),
    ).toBe(false);
});

it('refuses a challenge past its expiry', async () => {
  const issuedLongAgo = createAltchaBotChallenge(SECRET, {
    ...cheap,
    now: () => Date.now() - (ALTCHA_POLICY.ttlSeconds + 60) * 1000,
  });
  const proof = await solved(issuedLongAgo);
  expect(await createAltchaBotChallenge(SECRET, cheap).verify(RENDER, proof)).toBe(false);
});

it('derives its keys from the install secret with labels of their own', async () => {
  // The raw secret is never the HMAC key: a challenge signed with it is refused.
  const check = createAltchaBotChallenge(SECRET, cheap);
  const view = await createAltchaBotChallenge(SECRET, cheap).issue(RENDER);
  const solution = await solveChallenge({
    challenge: toAltchaChallenge(view.challenge),
    deriveKey,
  });
  if (solution === null) throw new Error('Expected a solution');
  expect(await check.verify(RENDER, { kind: 'altcha', challenge: view.challenge, solution })).toBe(
    true,
  );
  const { verifySolution } = await import('altcha-lib');
  expect(
    (
      await verifySolution({
        challenge: toAltchaChallenge(view.challenge),
        solution,
        deriveKey,
        hmacSignatureSecret: SECRET,
      })
    ).verified,
  ).toBe(false);
});
