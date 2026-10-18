import { expect, it } from 'vitest';

import { checkRenderToken, issueRenderToken, renderMarkOf } from './render-token.js';

const secret = 'forms-render-fixture-key-with-at-least-32-bytes';
const form = {
  formId: '01a122e6-1d7b-7683-898b-c83ec14df1bf',
  publishedAt: new Date('2026-10-10T09:00:00.000Z'),
  visitor: '203.0.113.10',
};
const limits = { minFillSeconds: 2, renderHours: 24 };
const shown = Date.parse('2026-10-10T10:00:00.000Z');
const token = issueRenderToken(secret, form, shown);
const checkGiven = (after: number, given: unknown, to = form, key = secret) =>
  checkRenderToken(key, to, given, shown + after, limits);
const check = (after: number) => checkGiven(after, token);
const mark = token.slice(14);

it('is a moment and a digest, and carries nothing else', () => {
  expect(token).toMatch(/^[0-9]{13}\.[A-Za-z0-9_-]{43}$/);
  expect(token.startsWith(`${String(shown)}.`)).toBe(true);
  // The same form shown at the same moment is the same token: nothing random, nothing stored.
  expect(issueRenderToken(secret, form, shown)).toBe(token);
  expect(issueRenderToken(secret, form, shown + 0.4)).toBe(token);
  expect(issueRenderToken(secret, form, shown + 1)).not.toBe(token);
});

it('accepts a form that was on the page for at least two seconds and at most a day', () => {
  // With the moment it was shown, as this server signed it: how long the visitor took is
  // measured from there, never from anything the browser says.
  expect(check(2000)).toEqual({ accepted: true, shownAt: shown, mark });
  expect(check(60_000)).toEqual({ accepted: true, shownAt: shown, mark });
  expect(check(24 * 3_600_000)).toEqual({ accepted: true, shownAt: shown, mark });
  expect(check(24 * 3_600_000 + 1)).toEqual({ accepted: false, reason: 'stale' });
});

it('refuses a form sent sooner than a person fills one in, and says how long to wait', () => {
  expect(check(0)).toEqual({ accepted: false, reason: 'too_fast', retryAfterSeconds: 2 });
  expect(check(999)).toEqual({ accepted: false, reason: 'too_fast', retryAfterSeconds: 2 });
  expect(check(1000)).toEqual({ accepted: false, reason: 'too_fast', retryAfterSeconds: 1 });
  expect(check(1999)).toEqual({ accepted: false, reason: 'too_fast', retryAfterSeconds: 1 });
  // Another instance's clock may run a little ahead: that is a short wait, not a forgery.
  expect(check(-30_000)).toEqual({ accepted: false, reason: 'too_fast', retryAfterSeconds: 32 });
  expect(check(-30_001)).toEqual({ accepted: false, reason: 'stale' });
});

it('answers only to this server, this form and the version that was shown', () => {
  expect(checkGiven(5000, token, form, `${secret}!`)).toEqual({ accepted: false, reason: 'stale' });
  expect(
    checkGiven(5000, token, { ...form, formId: '01a122e6-1d7d-7768-9181-7f7be4fed4a5' }),
  ).toEqual({
    accepted: false,
    reason: 'stale',
  });
  // The form was published again since: its questions may have changed.
  expect(
    checkGiven(5000, token, { ...form, publishedAt: new Date(form.publishedAt.getTime() + 1) }),
  ).toEqual({ accepted: false, reason: 'stale' });
});

it('answers only to the visitor it was shown to', () => {
  // Fetched by one source and sent from another: a token handed round a crowd is no use.
  expect(checkGiven(5000, token, { ...form, visitor: '203.0.113.11' })).toEqual({
    accepted: false,
    reason: 'stale',
  });
  expect(checkGiven(5000, token, { ...form, visitor: '2001:db8::/64' })).toEqual({
    accepted: false,
    reason: 'stale',
  });
  // Each visitor shown the form at the same moment gets a token of their own.
  expect(issueRenderToken(secret, { ...form, visitor: '203.0.113.11' }, shown)).not.toBe(token);
});

it('waits as long as it is told: a busy form asks for longer', () => {
  const busy = { minFillSeconds: 10, renderHours: 24 };
  expect(checkRenderToken(secret, form, token, shown + 4000, busy)).toEqual({
    accepted: false,
    reason: 'too_fast',
    retryAfterSeconds: 6,
  });
  expect(checkRenderToken(secret, form, token, shown + 10_000, busy)).toEqual({
    accepted: true,
    shownAt: shown,
    mark,
  });
});

it('refuses a token whose moment or digest was changed, and anything that is not one', () => {
  const [moment = '', signature = ''] = token.split('.');
  const earlier = `${String(Number(moment) - 10_000)}.${signature}`;
  expect(checkGiven(0, earlier)).toEqual({ accepted: false, reason: 'stale' });
  const flipped = `${moment}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
  expect(checkGiven(5000, flipped)).toEqual({ accepted: false, reason: 'stale' });
  for (const given of [
    undefined,
    null,
    7,
    '',
    moment,
    `${moment}.`,
    `${moment}.${signature}x`,
    `${moment}.${signature.slice(1)}`,
    `${moment.slice(1)}.${signature}`,
    `${moment}.${'='.repeat(43)}`,
    ` ${token}`,
    [token],
  ])
    expect(checkGiven(5000, given)).toEqual({ accepted: false, reason: 'stale' });
});

it("gives a token's mark at once, for a bot challenge, but never a stale or foreign one's", () => {
  // Asked for the moment the form is shown: no pause is needed to be given a challenge.
  expect(renderMarkOf(secret, form, token, shown, 24)).toBe(mark);
  expect(renderMarkOf(secret, form, token, shown + 24 * 3_600_000, 24)).toBe(mark);
  expect(renderMarkOf(secret, form, token, shown + 24 * 3_600_000 + 1, 24)).toBeUndefined();
  expect(
    renderMarkOf(secret, { ...form, visitor: '198.51.100.7' }, token, shown, 24),
  ).toBeUndefined();
  expect(renderMarkOf(`${secret}-other`, form, token, shown, 24)).toBeUndefined();
  expect(renderMarkOf(secret, form, 'nope', shown, 24)).toBeUndefined();
});
