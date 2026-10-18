import { describe, expect, it } from 'vitest';
import { updateBusinessProfileInput } from './business-profile.js';

const profile = {
  name: ' Harbor Lights ',
  timezone: 'Africa/Nairobi',
  locale: 'en-KE',
  currency: 'KES',
  address: {
    line1: '12 Market Road',
    line2: '',
    city: 'Nairobi',
    region: '',
    postalCode: '00100',
    country: 'KE',
  },
  logoFileId: null,
};

describe('business profile input', () => {
  it('trims a name and accepts international business settings', () => {
    expect(updateBusinessProfileInput.parse(profile).name).toBe('Harbor Lights');
    expect(updateBusinessProfileInput.parse({ ...profile, address: null })).toMatchObject({
      address: null,
    });
  });
  it.each([
    ['timezone', 'Moon/Base'],
    ['currency', 'ZZZ'],
    ['locale', 'not a locale'],
    ['name', ' '],
    ['name', 'x'.repeat(201)],
    ['logoFileId', 'not-a-file'],
    ['address', { ...profile.address, country: 'Kenya' }],
    ['address', { ...profile.address, line1: 'x'.repeat(201) }],
  ])('rejects invalid %s at its field', (field, value) => {
    const result = updateBusinessProfileInput.safeParse({ ...profile, [field]: value });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path[0]).toBe(field);
  });
  it('rejects changing the slug, status or business id through the profile', () => {
    for (const field of ['slug', 'status', 'id']) {
      expect(updateBusinessProfileInput.safeParse({ ...profile, [field]: 'other' }).success).toBe(
        false,
      );
    }
  });
});
