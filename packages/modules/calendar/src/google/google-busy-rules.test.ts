import { describe, expect, it } from 'vitest';

import {
  appointmentMeetsOnGoogle,
  eventDescription,
  freeBusySpans,
  googleBusyIn,
  googleEventId,
  horizonDays,
  meetsOnGoogle,
  merged,
  nextRefreshDelayMs,
  subtracted,
  tokenCache,
  uncovered,
} from './google-busy-rules.js';

const at = (minutes: number) => minutes * 60_000;
const span = (start: number, end: number) => ({ start: at(start), end: at(end) });

describe('intervals', () => {
  it('joins touching and overlapping ones and drops empty ones', () => {
    expect(merged([span(30, 60), span(0, 10), span(10, 20), span(50, 70), span(80, 80)])).toEqual([
      span(0, 20),
      span(30, 70),
    ]);
  });

  it('takes holes out, at either end, in the middle and across several', () => {
    expect(subtracted([span(0, 100)], [span(10, 20), span(40, 50)])).toEqual([
      span(0, 10),
      span(20, 40),
      span(50, 100),
    ]);
    expect(subtracted([span(0, 100)], [span(-10, 10), span(90, 120)])).toEqual([span(10, 90)]);
    expect(subtracted([span(0, 100)], [span(0, 100)])).toEqual([]);
    expect(subtracted([span(0, 10), span(20, 30)], [span(200, 300)])).toEqual([
      span(0, 10),
      span(20, 30),
    ]);
    expect(uncovered(span(0, 60), [span(0, 30)])).toEqual([span(30, 60)]);
  });
});

describe('a member’s Google busy time', () => {
  const day = span(0, 1440);

  it('is Google’s busy time within the range, less the CRM’s own copies', () => {
    expect(googleBusyIn(day, [span(600, 660), span(780, 810)], [span(780, 810)], [day])).toEqual([
      span(600, 660),
    ]);
  });

  it('is busy wherever no recent reading covers the range: unknown is not free', () => {
    expect(googleBusyIn(day, [], [], [span(0, 720)])).toEqual([span(720, 1440)]);
    expect(googleBusyIn(day, [span(-60, 60)], [], [])).toEqual([day]);
  });

  it('is cut to the range', () => {
    expect(googleBusyIn(day, [span(-60, 60), span(1400, 1500)], [], [span(-100, 2000)])).toEqual([
      span(0, 60),
      span(1400, 1440),
    ]);
  });
});

describe('a refresh', () => {
  it('asks in pieces of at most thirty days', () => {
    const days = (n: number) => at(n * 1440);
    expect(freeBusySpans({ start: 0, end: days(75) })).toEqual([
      { start: 0, end: days(30) },
      { start: days(30), end: days(60) },
      { start: days(60), end: days(75) },
    ]);
    expect(freeBusySpans({ start: 0, end: 0 })).toEqual([]);
  });

  it('reads to the furthest booking window, within 14 and 120 days', () => {
    expect(horizonDays([])).toBe(14);
    expect(horizonDays([5])).toBe(14);
    expect(horizonDays([60, 30])).toBe(61);
    expect(horizonDays([730])).toBe(120);
  });

  it('comes back in five minutes, give or take a quarter', () => {
    expect(nextRefreshDelayMs(0)).toBe(225_000);
    expect(nextRefreshDelayMs(0.5)).toBe(300_000);
    expect(nextRefreshDelayMs(1)).toBe(375_000);
    expect(nextRefreshDelayMs(7)).toBe(375_000);
  });
});

describe('an event’s id', () => {
  it('is base32hex, as Google requires, and changes with the generation', () => {
    const id = googleEventId('01890A5D-AC96-774B-BCCE-B302099A8057', 2);
    expect(id).toBe('crm01890a5dac96774bbcceb302099a8057g2');
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
  });
});

describe('what an event carries', () => {
  it('names the calendar and the contact, leaving out what is not known', () => {
    expect(
      eventDescription('Venue tour', { first_name: ' Maya ', last_name: 'Lee' }, [
        { kind: 'email', value: 'maya@example.test' },
        { kind: 'phone', value: '+15555550100' },
      ]),
    ).toBe(
      'Booked in the CRM on the calendar Venue tour.\nContact: Maya Lee\nEmail: maya@example.test\nPhone: +15555550100',
    );
    expect(eventDescription('Venue tour', undefined, [])).toBe(
      'Booked in the CRM on the calendar Venue tour.',
    );
    expect(eventDescription('X', { first_name: null, last_name: ' ' }, [])).toBe(
      'Booked in the CRM on the calendar X.',
    );
  });

  it('asks for a Meet only when the first meeting place is Google Meet', () => {
    expect(meetsOnGoogle([{ kind: 'google_meet', value: 'Google Meet' }])).toBe(true);
    expect(meetsOnGoogle([{ kind: 'phone' }, { kind: 'google_meet' }])).toBe(false);
    expect(meetsOnGoogle([])).toBe(false);
    expect(meetsOnGoogle(undefined)).toBe(false);
    expect(meetsOnGoogle(['google_meet'])).toBe(false);
  });

  it('asks for a Meet only for an appointment given the Meet, or holding its link', () => {
    const meet = [
      { kind: 'google_meet', value: 'Video call' },
      { kind: 'address', value: 'HQ' },
    ];
    const link = 'https://meet.google.com/abc-defg-hij';
    expect(appointmentMeetsOnGoogle(meet, 'Video call', null)).toBe(true);
    expect(appointmentMeetsOnGoogle(meet, link, link)).toBe(true);
    // Booked while Google was not connected: given the next place, and it stays.
    expect(appointmentMeetsOnGoogle(meet, 'HQ', null)).toBe(false);
    // A place the team wrote, an old link no sync holds, or none at all.
    expect(appointmentMeetsOnGoogle(meet, 'Room 4', link)).toBe(false);
    expect(appointmentMeetsOnGoogle(meet, link, null)).toBe(false);
    expect(appointmentMeetsOnGoogle(meet, null, null)).toBe(false);
    expect(appointmentMeetsOnGoogle([{ kind: 'address', value: 'HQ' }], 'HQ', null)).toBe(false);
  });
});

describe('access tokens in memory', () => {
  it('are kept until a minute before they expire, forgotten on demand, and never pile up', () => {
    let now = 0;
    const cache = tokenCache(() => now);
    cache.set('s1', 'ya29.a', 3600);
    now = 3_539_000;
    expect(cache.get('s1')).toBe('ya29.a');
    now = 3_540_000;
    expect(cache.get('s1')).toBeUndefined();
    cache.set('s1', 'ya29.b', 3600);
    cache.forget('s1');
    expect(cache.get('s1')).toBeUndefined();
    expect(cache.get('never')).toBeUndefined();
    for (let index = 0; index <= 10_001; index += 1) cache.set(`s${String(index)}`, 't', 3600);
    expect(cache.get('s0')).toBeUndefined();
    expect(cache.get('s10001')).toBe('t');
  });
});
