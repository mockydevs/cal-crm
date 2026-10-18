import { describe, expect, it } from 'vitest';

import { checkViewToken, issueViewToken, VIEW_LIMITS } from './view-token.js';

const SECRET = 'tracking-test-secret-of-at-least-32-bytes';
const page = { businessId: '0190f3a2-7c1d-7e4b-9a5f-1c2d3e4f5a6b', visitor: '203.0.113.7' };
const now = 1_760_000_000_000;

describe('a view token', () => {
  it('is a moment and a digest, accepted once the page has been shown a moment', () => {
    const token = issueViewToken(SECRET, page, now);
    expect(token).toMatch(/^[0-9]{13}\.[A-Za-z0-9_-]{43}$/);
    const decision = checkViewToken(SECRET, page, token, now + VIEW_LIMITS.minSeconds * 1000);
    expect(decision).toEqual({ accepted: true, mark: token.split('.')[1] });
  });

  it('is refused sent sooner than a person fills in a form, with the wait', () => {
    const token = issueViewToken(SECRET, page, now);
    expect(checkViewToken(SECRET, page, token, now + 500)).toEqual({
      accepted: false,
      reason: 'too_fast',
      retryAfterSeconds: 2,
    });
  });

  it('is refused for another business, another visitor, another key, or too old', () => {
    const token = issueViewToken(SECRET, page, now);
    const later = now + 5000;
    const stale = { accepted: false, reason: 'stale' };
    expect(checkViewToken(SECRET, { ...page, visitor: '203.0.113.8' }, token, later)).toEqual(
      stale,
    );
    expect(
      checkViewToken(
        SECRET,
        { ...page, businessId: '0190f3a2-7c1d-7e4b-9a5f-1c2d3e4f5a6c' },
        token,
        later,
      ),
    ).toEqual(stale);
    expect(checkViewToken(`${SECRET}x`, page, token, later)).toEqual(stale);
    expect(checkViewToken(SECRET, page, token, now + VIEW_LIMITS.hours * 3_600_000 + 1)).toEqual(
      stale,
    );
    expect(checkViewToken(SECRET, page, token, now - 60_000)).toEqual(stale);
    expect(checkViewToken(SECRET, page, 'nonsense', later)).toEqual(stale);
    expect(checkViewToken(SECRET, page, `${token.slice(0, 14)}${'A'.repeat(42)}`, later)).toEqual(
      stale,
    );
    expect(checkViewToken(SECRET, page, `${token.slice(0, 13)}.short`, later)).toEqual(stale);
  });
});
