import { describe, expect, it } from 'vitest';

import { datesFiringIn, firingInstant, yearlyDays, type DateRule } from './date-triggers.js';

const NAIROBI = 'Africa/Nairobi';
const NEW_YORK = 'America/New_York';
const onTheDay: DateRule = { direction: 'before', time: '08:00' };
const before = (offset: string, time = '08:00'): DateRule => ({
  offset,
  direction: 'before',
  time,
});
const after = (offset: string, time = '08:00'): DateRule => ({ offset, direction: 'after', time });
const iso = (date: Date | undefined) => date?.toISOString();

describe('when a date fires', () => {
  it('fires at the time of day on the date, in the time zone', () => {
    expect(iso(firingInstant('2026-10-20', onTheDay, NAIROBI))).toBe('2026-10-20T05:00:00.000Z');
    expect(iso(firingInstant('2026-10-20', onTheDay, NEW_YORK))).toBe('2026-10-20T12:00:00.000Z');
  });

  it('moves by days, weeks and months before or after the date', () => {
    expect(iso(firingInstant('2026-10-20', before('P3D'), NAIROBI))).toBe(
      '2026-10-17T05:00:00.000Z',
    );
    expect(iso(firingInstant('2026-10-20', after('P1D'), NAIROBI))).toBe(
      '2026-10-21T05:00:00.000Z',
    );
    expect(iso(firingInstant('2026-10-20', before('P1W'), NAIROBI))).toBe(
      '2026-10-13T05:00:00.000Z',
    );
    expect(iso(firingInstant('2026-11-15', before('P1M'), NAIROBI))).toBe(
      '2026-10-15T05:00:00.000Z',
    );
  });

  it('moves by hours from the time of day', () => {
    expect(iso(firingInstant('2026-10-20', before('PT2H'), NAIROBI))).toBe(
      '2026-10-20T03:00:00.000Z',
    );
    expect(iso(firingInstant('2026-10-20', after('P1DT30M'), NAIROBI))).toBe(
      '2026-10-21T05:30:00.000Z',
    );
  });

  it('keeps the time of day when days are counted across a clock change', () => {
    // New York moved its clocks forward on 8 March 2026: 08:00 on the 7th is 13:00 UTC and
    // on the 9th 12:00 UTC. Two days before the 9th is 08:00 on the 7th, not 07:00.
    expect(iso(firingInstant('2026-03-09', before('P2D'), NEW_YORK))).toBe(
      '2026-03-07T13:00:00.000Z',
    );
    expect(iso(firingInstant('2026-03-07', after('P2D'), NEW_YORK))).toBe(
      '2026-03-09T12:00:00.000Z',
    );
  });

  it('moves a time the clocks skip forward, and takes the first of a time that comes twice', () => {
    expect(iso(firingInstant('2026-03-08', before('P0D', '02:30'), NEW_YORK))).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    expect(iso(firingInstant('2026-11-01', before('P0D', '01:30'), NEW_YORK))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it.each([
    ['a date that does not exist', '2026-02-30', onTheDay, NAIROBI],
    ['something that is not a date', 'soon', onTheDay, NAIROBI],
    ['a time zone that is not one', '2026-10-20', onTheDay, 'Mars/Olympus'],
    ['a length of time that is not one', '2026-10-20', before('3 days'), NAIROBI],
  ])('gives nothing for %s', (_name, date, rule, zone) => {
    expect(firingInstant(date, rule, zone)).toBeUndefined();
  });
});

describe('which dates fire in a stretch of time', () => {
  const at = (value: string) => new Date(value);

  it('finds the date whose time falls in it, the end included and the start not', () => {
    expect(
      datesFiringIn(onTheDay, NAIROBI, at('2026-10-20T04:59:00Z'), at('2026-10-20T05:00:00Z')),
    ).toEqual(['2026-10-20']);
    expect(
      datesFiringIn(onTheDay, NAIROBI, at('2026-10-20T05:00:00Z'), at('2026-10-20T05:01:00Z')),
    ).toEqual([]);
    expect(
      datesFiringIn(onTheDay, NAIROBI, at('2026-10-20T04:58:00Z'), at('2026-10-20T04:59:00Z')),
    ).toEqual([]);
  });

  it('finds the date an offset away', () => {
    expect(
      datesFiringIn(before('P3D'), NAIROBI, at('2026-10-17T04:59:00Z'), at('2026-10-17T05:00:00Z')),
    ).toEqual(['2026-10-20']);
    expect(
      datesFiringIn(after('P1D'), NAIROBI, at('2026-10-21T04:59:00Z'), at('2026-10-21T05:00:00Z')),
    ).toEqual(['2026-10-20']);
    expect(
      datesFiringIn(before('P1M'), NAIROBI, at('2026-10-15T04:59:00Z'), at('2026-10-15T05:00:00Z')),
    ).toEqual(['2026-11-15']);
  });

  it('finds every date of a longer stretch, in order', () => {
    expect(
      datesFiringIn(onTheDay, NAIROBI, at('2026-10-19T05:00:00Z'), at('2026-10-20T05:00:00Z')),
    ).toEqual(['2026-10-20']);
    expect(
      datesFiringIn(onTheDay, NAIROBI, at('2026-10-19T04:59:00Z'), at('2026-10-20T05:00:00Z')),
    ).toEqual(['2026-10-19', '2026-10-20']);
  });

  it('finds each of the dates that land on one day when months differ in length', () => {
    // A month after 29 January 2027 is 1 March (February has 28 days), as is a month after
    // 1 February.
    expect(
      datesFiringIn(after('P1M'), NAIROBI, at('2027-03-01T04:59:00Z'), at('2027-03-01T05:00:00Z')),
    ).toEqual(['2027-01-29', '2027-02-01']);
  });

  it('finds nothing in a time zone that is not one, or an empty stretch', () => {
    expect(
      datesFiringIn(
        onTheDay,
        'Mars/Olympus',
        at('2026-10-19T00:00:00Z'),
        at('2026-10-21T00:00:00Z'),
      ),
    ).toEqual([]);
    expect(
      datesFiringIn(onTheDay, NAIROBI, at('2026-10-20T05:00:00Z'), at('2026-10-20T05:00:00Z')),
    ).toEqual([]);
  });
});

describe('the days of the year a date stands for', () => {
  it('is its own month and day', () => {
    expect(yearlyDays('2026-10-20')).toEqual([{ month: 10, day: 20 }]);
    expect(yearlyDays('2028-02-29')).toEqual([{ month: 2, day: 29 }]);
    expect(yearlyDays('2028-02-28')).toEqual([{ month: 2, day: 28 }]);
  });

  it('is also 29 February on the 28th of a year without one', () => {
    expect(yearlyDays('2027-02-28')).toEqual([
      { month: 2, day: 28 },
      { month: 2, day: 29 },
    ]);
  });
});
