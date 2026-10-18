import type { BotProof } from '@repo/contracts';
import { expect, it } from 'vitest';
import { expiresSoon } from './public-booking-bot';

const proof = (expiresAt?: number): BotProof => ({
  kind: 'altcha',
  challenge: {
    parameters: {
      algorithm: 'PBKDF2/SHA-256',
      nonce: 'ab',
      salt: 'cd',
      cost: 1,
      keyLength: 32,
      keyPrefix: 'ef',
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
    signature: '01',
  },
  solution: { counter: 1, derivedKey: 'ef' },
});

it('solves again a proof within half a minute of its expiry, and never one without an expiry', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const seconds = now / 1000;
  expect(expiresSoon(proof(seconds + 31), now)).toBe(false);
  expect(expiresSoon(proof(seconds + 29), now)).toBe(true);
  expect(expiresSoon(proof(seconds - 1), now)).toBe(true);
  expect(expiresSoon(proof(), now)).toBe(false);
});
