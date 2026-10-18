import { describe, expect, it } from 'vitest';

import { phoneCountryOf } from './country.js';

const place = {
  addressCountry: null,
  currency: 'USD',
  locale: 'en',
  timezone: 'UTC',
};

describe("a business's country for national phone numbers", () => {
  it('takes the address first, whatever else says', () => {
    expect(phoneCountryOf({ ...place, addressCountry: 'KE', locale: 'en-US' })).toBe('KE');
  });

  it('falls back from an address the library does not know', () => {
    expect(phoneCountryOf({ ...place, addressCountry: 'ZZ', currency: 'CAD' })).toBe('CA');
  });

  it('reads a country from a currency that belongs to one', () => {
    expect(phoneCountryOf({ ...place, currency: 'KES', locale: 'en-US' })).toBe('KE');
    expect(phoneCountryOf({ ...place, currency: 'GBP' })).toBe('GB');
  });

  it("reads the region the locale names, never a bare language's guess", () => {
    expect(phoneCountryOf({ ...place, currency: 'EUR', locale: 'de-DE' })).toBe('DE');
    expect(phoneCountryOf({ ...place, currency: 'EUR', locale: 'de' })).toBeUndefined();
    expect(phoneCountryOf({ ...place, currency: 'EUR', locale: 'not a locale!' })).toBeUndefined();
  });

  it('takes the US for US dollars in the Americas or in no zone at all (US market first)', () => {
    expect(phoneCountryOf(place)).toBe('US');
    expect(phoneCountryOf({ ...place, timezone: 'America/New_York' })).toBe('US');
    expect(phoneCountryOf({ ...place, timezone: 'US/Pacific' })).toBe('US');
    expect(phoneCountryOf({ ...place, timezone: 'Pacific/Honolulu' })).toBe('US');
    expect(phoneCountryOf({ ...place, timezone: 'Etc/UTC' })).toBe('US');
    expect(phoneCountryOf({ ...place, timezone: 'GMT' })).toBe('US');
  });

  it('keeps asking for the country code when nothing says where the business is', () => {
    expect(phoneCountryOf({ ...place, timezone: 'Africa/Nairobi' })).toBeUndefined();
    expect(
      phoneCountryOf({ ...place, currency: 'EUR', timezone: 'Europe/Berlin' }),
    ).toBeUndefined();
  });
});
