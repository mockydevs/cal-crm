import { expect, it } from 'vitest';

import { createBookingShownProof } from './booking-proof.js';
import { issueRenderToken } from './render-token.js';

const secret = 'booking-proof-fixture-key-with-at-least-32-bytes';
const calendar = '019a0000-0000-7000-8000-0000000000aa';

it('accepts the page shown to this visitor for this calendar, after a person’s pause', () => {
  let clock = Date.parse('2026-11-01T10:00:00.000Z');
  const proof = createBookingShownProof(secret, () => clock);
  const token = proof.issue(calendar, '203.0.113.5');
  expect(proof.check(calendar, '203.0.113.5', token)).toEqual({
    accepted: false,
    reason: 'too_fast',
    retryAfterSeconds: 2,
  });
  clock += 2500;
  const accepted = proof.check(calendar, '203.0.113.5', token);
  expect(accepted).toEqual({ accepted: true, mark: token.slice(14) });
  // Another visitor, another calendar, or another server's key: shown again.
  expect(proof.check(calendar, '203.0.113.6', token)).toEqual({ accepted: false, reason: 'stale' });
  expect(proof.check('019a0000-0000-7000-8000-0000000000bb', '203.0.113.5', token)).toEqual({
    accepted: false,
    reason: 'stale',
  });
  expect(
    createBookingShownProof(`${secret}!`, () => clock).check(calendar, '203.0.113.5', token),
  ).toEqual({ accepted: false, reason: 'stale' });
});

it('gives two showings at one moment two tokens, and is never a form’s token', () => {
  const clock = Date.parse('2026-11-01T10:00:00.000Z');
  const proof = createBookingShownProof(secret, () => clock);
  expect(proof.issue(calendar, '203.0.113.5')).not.toBe(proof.issue(calendar, '203.0.113.5'));
  const formToken = issueRenderToken(
    secret,
    { formId: calendar, publishedAt: new Date(0), visitor: '203.0.113.5' },
    clock - 10_000,
  );
  expect(
    createBookingShownProof(secret, () => clock).check(calendar, '203.0.113.5', formToken),
  ).toEqual({
    accepted: false,
    reason: 'stale',
  });
  // On the real clock by default.
  expect(createBookingShownProof(secret).issue(calendar, '::1')).toMatch(/^[0-9]{13}\./);
});

it('gives the mark of a fresh showing at once, for its bot challenge, and of nothing else', () => {
  const clock = Date.parse('2026-11-01T10:00:00.000Z');
  const proof = createBookingShownProof(secret, () => clock);
  const token = proof.issue(calendar, '203.0.113.5');
  expect(proof.mark(calendar, '203.0.113.5', token)).toBe(token.slice(14));
  expect(proof.mark(calendar, '203.0.113.6', token)).toBeUndefined();
  expect(proof.mark('019a0000-0000-7000-8000-0000000000bb', '203.0.113.5', token)).toBeUndefined();
});
