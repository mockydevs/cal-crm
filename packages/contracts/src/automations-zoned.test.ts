import { describe, expect, it } from 'vitest';

import { zonedDay, zonedParts, zonedTime } from './automations-zoned.js';

describe('time zones', () => {
  it('turn a local date and time into the instant', () => {
    expect(zonedTime('2026-10-18', '09:00', 'Africa/Nairobi')).toEqual(
      new Date('2026-10-18T06:00:00Z'),
    );
    expect(zonedTime('2026-07-01', '09:00', 'Europe/London')).toEqual(
      new Date('2026-07-01T08:00:00Z'),
    );
    expect(zonedTime('2026-12-01', '09:00', 'Europe/London')).toEqual(
      new Date('2026-12-01T09:00:00Z'),
    );
  });

  // Each expected instant was checked against Temporal's "compatible" disambiguation.
  it('move a time the clocks skip forward by the length of the gap', () => {
    // New York skips 02:00 to 03:00 on 8 March 2026, so 02:30 becomes 03:30 EDT.
    expect(zonedTime('2026-03-08', '01:59', 'America/New_York')).toEqual(
      new Date('2026-03-08T06:59:00Z'),
    );
    expect(zonedTime('2026-03-08', '02:30', 'America/New_York')).toEqual(
      new Date('2026-03-08T07:30:00Z'),
    );
    expect(zonedTime('2026-03-08', '03:00', 'America/New_York')).toEqual(
      new Date('2026-03-08T07:00:00Z'),
    );
    expect(zonedTime('2026-03-29', '01:30', 'Europe/London')).toEqual(
      new Date('2026-03-29T01:30:00Z'),
    );
    expect(zonedTime('2026-10-04', '02:30', 'Australia/Sydney')).toEqual(
      new Date('2026-10-03T16:30:00Z'),
    );
    // A half-hour gap, and the whole day Samoa skipped.
    expect(zonedTime('2026-10-04', '02:15', 'Australia/Lord_Howe')).toEqual(
      new Date('2026-10-03T15:45:00Z'),
    );
    expect(zonedTime('2011-12-30', '12:00', 'Pacific/Apia')).toEqual(
      new Date('2011-12-30T22:00:00Z'),
    );
  });

  it('take the first of the two times when the clocks repeat an hour', () => {
    // New York repeats 01:00 to 02:00 on 1 November 2026: 01:30 EDT comes before 01:30 EST.
    expect(zonedTime('2026-11-01', '01:30', 'America/New_York')).toEqual(
      new Date('2026-11-01T05:30:00Z'),
    );
    expect(zonedTime('2026-11-01', '02:00', 'America/New_York')).toEqual(
      new Date('2026-11-01T07:00:00Z'),
    );
    expect(zonedTime('2026-10-25', '01:30', 'Europe/London')).toEqual(
      new Date('2026-10-25T00:30:00Z'),
    );
    expect(zonedTime('2026-04-05', '02:30', 'Australia/Sydney')).toEqual(
      new Date('2026-04-04T15:30:00Z'),
    );
    expect(zonedTime('2026-04-05', '01:45', 'Australia/Lord_Howe')).toEqual(
      new Date('2026-04-04T14:45:00Z'),
    );
  });

  it('keep years before 100 as written, not as 1900 to 1999', () => {
    expect(zonedTime('0050-06-01', '09:00', 'UTC')).toEqual(new Date('0050-06-01T09:00:00Z'));
    // Nairobi was on local mean time then, 2:27:16 ahead.
    expect(zonedTime('0050-06-01', '09:00', 'Africa/Nairobi')).toEqual(
      new Date('0050-06-01T06:32:44Z'),
    );
    expect(zonedTime('0000-06-01', '09:00', 'UTC')).toEqual(new Date('0000-06-01T09:00:00Z'));
    // The instant falls in the year before year 1, which Intl gives as 1 BC.
    expect(zonedTime('0001-01-01', '00:00', 'Africa/Nairobi')).toEqual(
      new Date('0000-12-31T21:32:44Z'),
    );
  });

  it('refuse a date, a time or a time zone that does not exist', () => {
    expect(zonedTime('2026-02-30', '09:00', 'UTC')).toBeUndefined();
    expect(zonedTime('2026-13-45', '09:00', 'UTC')).toBeUndefined();
    expect(zonedTime('date', '09:00', 'UTC')).toBeUndefined();
    expect(zonedTime('2026-10-18', '25:00', 'UTC')).toBeUndefined();
    expect(zonedTime('2026-10-18', '09:00', 'Not/A_Zone')).toBeUndefined();
  });
});

describe('local dates of an instant', () => {
  it('read the date, time and seconds on the clock of the zone', () => {
    expect(zonedParts(new Date('2026-11-01T03:30:15Z'), 'America/New_York')).toEqual({
      date: '2026-10-31',
      time: '23:30',
      seconds: 15,
    });
    expect(zonedParts(new Date('2026-11-01T03:30:00Z'), 'UTC')).toEqual({
      date: '2026-11-01',
      time: '03:30',
      seconds: 0,
    });
  });

  it('read nothing for a zone or an instant that is not one', () => {
    expect(zonedParts(new Date('2026-11-01T03:30:00Z'), 'Not/A_Zone')).toBeUndefined();
    expect(zonedParts(new Date(Number.NaN), 'UTC')).toBeUndefined();
    expect(zonedParts(new Date('+020000-01-01T00:00:00Z'), 'UTC')).toBeUndefined();
  });
});

describe('a day in a time zone', () => {
  it('runs from its first moment to the next day, also over a clock change', () => {
    expect(zonedDay('2026-11-01', 'America/New_York')).toEqual({
      start: new Date('2026-11-01T04:00:00Z'),
      end: new Date('2026-11-02T05:00:00Z'),
    });
    expect(zonedDay('2026-12-31', 'UTC')).toEqual({
      start: new Date('2026-12-31T00:00:00Z'),
      end: new Date('2027-01-01T00:00:00Z'),
    });
  });

  it('is nothing for a date or a zone that is not one', () => {
    expect(zonedDay('2026-02-30', 'UTC')).toBeUndefined();
    expect(zonedDay('2026-11-01', 'Not/A_Zone')).toBeUndefined();
  });
});
