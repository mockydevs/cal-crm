import { describe, expect, it } from 'vitest';

import { isTimeZone } from './index.js';

describe('isTimeZone', () => {
  it.each([
    'America/New_York',
    'Africa/Nairobi',
    // Current IANA names, which ICU still lists under their old names.
    'Asia/Kolkata',
    'Europe/Kyiv',
    'UTC',
    'Etc/UTC',
    'Etc/GMT+5',
    // A backward-compatible IANA alias.
    'US/Pacific',
  ])('accepts %s', (zone) => {
    expect(isTimeZone(zone)).toBe(true);
  });

  it('accepts every time zone Node lists', () => {
    const rejected = Intl.supportedValuesOf('timeZone').filter((zone) => !isTimeZone(zone));
    expect(rejected).toEqual([]);
  });

  it.each([
    ['a UTC offset, which has no daylight-saving rules', '+05:30'],
    ['an offset without a colon', '-0800'],
    ['a made-up zone', 'Mars/Phobos'],
    ['nothing', ''],
    ['spaces around a zone', ' UTC'],
    ['the military zone letter', 'Z'],
  ])('rejects %s: %j', (_case, zone) => {
    expect(isTimeZone(zone)).toBe(false);
  });
});
