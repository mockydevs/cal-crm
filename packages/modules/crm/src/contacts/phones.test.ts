import { describe, expect, it } from 'vitest';

import { isFictionalPhone, isMatchablePhone, normalizePhone } from './phones.js';

describe('normalizePhone and the North American Numbering Plan', () => {
  it.each([
    ['(212) 555-0142', '+12125550142'],
    ['212.555.0142', '+12125550142'],
    ['1-212-555-0142', '+12125550142'],
    ['+1 800 555 0199', '+18005550199'],
    // 555-01XX is fictional, but its format is the plan's: it is accepted as written.
    ['(415) 555-0100', '+14155550100'],
  ])('accepts %s as %s', (text, expected) => {
    expect(normalizePhone(text, 'US')).toBe(expected);
  });

  it.each([
    ['an area code that starts with 0', '(012) 555-0142'],
    ['an area code that starts with 1', '(123) 456-7890'],
    ['an exchange that starts with 0', '(212) 055-0142'],
    ['an exchange that starts with 1', '(212) 155-0142'],
    ['an N11 area code', '(911) 555-0100'],
    ['another N11 area code', '+1 411 555 0100'],
    ['ten zeros', '0000000000'],
    ['ten equal digits that pass NXX', '222 222 2222'],
    ['+1 with ten ones', '+1 111 111 1111'],
  ])('refuses %s', (_, text) => {
    expect(normalizePhone(text, 'US')).toMatchObject({ code: 'phone_invalid' });
  });

  it('leaves the plans of other countries to the length check', () => {
    expect(normalizePhone('0712 345678', 'KE')).toBe('+254712345678');
    expect(normalizePhone('+44 7700 900123', undefined)).toBe('+447700900123');
  });

  it('still asks for the country code when no country is known', () => {
    expect(normalizePhone('212 555 0142', undefined)).toMatchObject({
      code: 'phone_country_unknown',
    });
  });
});

describe('which numbers may find a contact', () => {
  it('knows the fictional range in any area code, and nothing beside it', () => {
    expect(isFictionalPhone('+12125550100')).toBe(true);
    expect(isFictionalPhone('+18005550199')).toBe(true);
    expect(isFictionalPhone('+12125550200')).toBe(false);
    expect(isFictionalPhone('+12125551212')).toBe(false);
    expect(isFictionalPhone('+442125550100')).toBe(false);
  });

  it("never matches on a fictional number or on one of the business's own", () => {
    const own = new Set(['+12125550142']);
    expect(isMatchablePhone('+12125550142', own)).toBe(false);
    expect(isMatchablePhone('+12125550150', own)).toBe(false);
    expect(isMatchablePhone('+12125550250', own)).toBe(true);
  });
});
