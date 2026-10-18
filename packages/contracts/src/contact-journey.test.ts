import { expect, it } from 'vitest';
import { getContactJourney } from './contact-journey.js';

it('accepts bounded native cursors and refuses a reversed time range', () => {
  expect(
    getContactJourney.query.safeParse({ from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' })
      .success,
  ).toBe(true);
  expect(
    getContactJourney.query.safeParse({ from: '2026-10-10T00:00:00Z', to: '2026-10-01T00:00:00Z' })
      .success,
  ).toBe(false);
  expect(getContactJourney.query.safeParse({ limit: 1000000 }).success).toBe(false);
});
