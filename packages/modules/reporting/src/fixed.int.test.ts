// The Appointment report and the Attribution report against real Postgres, with numbers
// worked out by hand from the rows below.
import { appointmentOverview, attributionReport } from '@repo/contracts';
import { toPublicId, ValidationError } from '@repo/kernel';
import { beforeAll, expect, it } from 'vitest';

import { seriesGrain } from './fixed.js';
import { refusalOf, reportingSuite, type Seeded } from '../test/reporting-fixtures.js';

const suite = reportingSuite();
const SEPTEMBER = { from: '2026-09-01', to: '2026-09-30' };

let one: Seeded;
let people: { p1: string; p2: string; p3: string; p4: string };
let calendars: { k1: string; k2: string };

beforeAll(async () => {
  one = await suite.business();
  // Contacts, one a day from 1 September:
  //   p1 paid_search (adwords, spring) from www.google.com
  //   p2 paid_search (adwords, spring)
  //   p3 organic_search from www.bing.com
  //   p4 no touch recorded
  const paid = { sessionSource: 'paid_search', utmSource: 'adwords', utmCampaign: 'spring' };
  const p1 = await suite.contact(
    one,
    { createdAt: '2026-09-01T09:00:00+03:00', createdSource: 'form' },
    [{ at: '2026-09-01T09:00:00+03:00', ...paid, referrer: 'www.google.com' }],
  );
  const p2 = await suite.contact(
    one,
    { createdAt: '2026-09-02T09:00:00+03:00', createdSource: 'form' },
    [{ at: '2026-09-02T09:00:00+03:00', ...paid }],
  );
  const p3 = await suite.contact(
    one,
    { createdAt: '2026-09-03T09:00:00+03:00', createdSource: 'form' },
    [
      {
        at: '2026-09-03T09:00:00+03:00',
        sessionSource: 'organic_search',
        referrer: 'www.bing.com',
      },
    ],
  );
  const p4 = await suite.contact(one, { createdAt: '2026-09-04T09:00:00+03:00' });
  // And one from August, which came by a newsletter: no lead of the range, but its
  // appointment was booked in it.
  const p0 = await suite.contact(
    one,
    { createdAt: '2026-08-10T09:00:00+03:00', createdSource: 'form' },
    [
      {
        at: '2026-08-10T09:00:00+03:00',
        sessionSource: 'referral',
        utmSource: 'newsletter',
        utmCampaign: 'old',
        referrer: 'news.example.com',
      },
    ],
  );
  people = { p1, p2, p3, p4 };
  // Opportunities, all made on 5 September: p1's won on the 10th for KES 1000, p2's open
  // at KES 500, p3's won on the 12th for USD 50.
  const pipeline = await suite.pipeline(one, 'Sales', ['New']);
  const made = '2026-09-05T09:00:00+03:00';
  await suite.deal(one, {
    pipeline,
    contactId: p1,
    createdAt: made,
    status: 'won',
    closedAt: '2026-09-10T09:00:00+03:00',
    amount: 1000,
  });
  await suite.deal(one, { pipeline, contactId: p2, createdAt: made, amount: 500 });
  await suite.deal(one, {
    pipeline,
    contactId: p3,
    createdAt: made,
    status: 'won',
    closedAt: '2026-09-12T09:00:00+03:00',
    amount: 50,
    currency: 'USD',
  });
  // Appointments:
  //   K1 p1 Mon 7 Sep  booked     booked on 6 Sep on the booking page, assigned
  //   K1 p3 Tue 8 Sep  cancelled  booked on 6 Sep by the team
  //   K2 p4 Wed 9 Sep  completed  booked on 30 August by the team
  const k1 = await suite.calendar(one, 'Consultations');
  const k2 = await suite.calendar(one, 'Site visits');
  calendars = { k1, k2 };
  const booked = '2026-09-06T09:00:00+03:00';
  await suite.appointment(one, {
    calendarId: k1,
    contactId: p1,
    startsAt: '2026-09-07T10:00:00+03:00',
    createdAt: booked,
    source: 'booking_page',
    assigned: true,
  });
  await suite.appointment(one, {
    calendarId: k1,
    contactId: p3,
    startsAt: '2026-09-08T10:00:00+03:00',
    createdAt: booked,
    status: 'cancelled',
    cancelledAt: '2026-09-07T10:00:00+03:00',
  });
  await suite.appointment(one, {
    calendarId: k2,
    contactId: p4,
    startsAt: '2026-09-09T10:00:00+03:00',
    createdAt: '2026-08-30T09:00:00+03:00',
    status: 'completed',
  });
  //   K2 p0 Thu 10 Sep confirmed  booked on 6 Sep through the API
  await suite.appointment(one, {
    calendarId: k2,
    contactId: p0,
    startsAt: '2026-09-10T10:00:00+03:00',
    createdAt: booked,
    status: 'confirmed',
    source: 'api',
  });
});

it('answers the Attribution report: what each source produced', async () => {
  const report = attributionReport.parse(
    await suite.api(one, 'getAttributionReport', { query: SEPTEMBER }),
  );
  expect(report).toMatchObject({
    timeZone: 'Africa/Nairobi',
    attribution: 'first',
    range: { from: '2026-09-01', to: '2026-09-30' },
    // The appointment booked in August is not one of the range's.
    totals: {
      leads: 4,
      appointments: 3,
      opportunities: 3,
      won: 2,
      wonValue: [
        { currency: 'KES', amount: '1000.0000' },
        { currency: 'USD', amount: '50.0000' },
      ],
    },
  });
  expect(report.sources).toEqual([
    {
      sessionSource: 'paid_search',
      leads: 2,
      appointments: 1,
      opportunities: 2,
      won: 1,
      wonValue: [{ currency: 'KES', amount: '1000.0000' }],
    },
    {
      sessionSource: 'organic_search',
      leads: 1,
      appointments: 1,
      opportunities: 1,
      won: 1,
      wonValue: [{ currency: 'USD', amount: '50.0000' }],
    },
    { sessionSource: null, leads: 1, appointments: 0, opportunities: 0, won: 0, wonValue: [] },
    // No lead of the range, and still a source that produced something in it.
    {
      sessionSource: 'referral',
      leads: 0,
      appointments: 1,
      opportunities: 0,
      won: 0,
      wonValue: [],
    },
  ]);
  expect(report.campaigns).toEqual([
    {
      utmSource: 'adwords',
      utmCampaign: 'spring',
      other: false,
      leads: 2,
      appointments: 1,
      opportunities: 2,
      won: 1,
      wonValue: [{ currency: 'KES', amount: '1000.0000' }],
    },
    {
      utmSource: null,
      utmCampaign: null,
      other: false,
      leads: 2,
      appointments: 1,
      opportunities: 1,
      won: 1,
      wonValue: [{ currency: 'USD', amount: '50.0000' }],
    },
    // The campaigns shown are the ones with leads; what the others produced is added up.
    {
      utmSource: null,
      utmCampaign: null,
      other: true,
      leads: 0,
      appointments: 1,
      opportunities: 0,
      won: 0,
      wonValue: [],
    },
  ]);
  expect(report.referrers).toEqual([
    { referrerDomain: null, other: false, leads: 2 },
    { referrerDomain: 'www.bing.com', other: false, leads: 1 },
    { referrerDomain: 'www.google.com', other: false, leads: 1 },
  ]);
  expect(report.series.grain).toBe('day');
  expect(report.series.points).toHaveLength(30);
  expect(report.series.points.slice(0, 5)).toEqual([
    { date: '2026-09-01', leads: 1 },
    { date: '2026-09-02', leads: 1 },
    { date: '2026-09-03', leads: 1 },
    { date: '2026-09-04', leads: 1 },
    { date: '2026-09-05', leads: 0 },
  ]);
  expect(
    report.touches.map((touch) => [
      touch.contact.id,
      touch.sessionSource,
      touch.first,
      touch.referrerDomain,
    ]),
  ).toEqual([
    [toPublicId('contact', people.p3), 'organic_search', true, 'www.bing.com'],
    [toPublicId('contact', people.p2), 'paid_search', true, null],
    [toPublicId('contact', people.p1), 'paid_search', true, 'www.google.com'],
  ]);
});

it('reads the latest touch when asked, and the last 30 days when no range is named', async () => {
  // p1 comes back through Facebook: its latest touch moves, its first stays.
  await suite.database.as('crm_owner', async (sql) => {
    await sql.query('update crm.contact_attributions set is_latest = false where contact_id = $1', [
      people.p1,
    ]);
    await sql.query(
      `insert into crm.contact_attributions
         (business_id, contact_id, touched_at, medium, session_source, referrer_domain, subject_kind, subject_id, is_latest)
       values ($1, $2, '2026-09-20T09:00:00+03:00', 'form', 'social_media', 'www.facebook.com', 'contact', $2, true)`,
      [one.businessId, people.p1],
    );
  });
  const latest = attributionReport.parse(
    await suite.api(one, 'getAttributionReport', {
      query: { ...SEPTEMBER, attribution: 'latest' },
    }),
  );
  expect(latest.sources.map((row) => [row.sessionSource, row.leads, row.won])).toEqual([
    ['paid_search', 1, 0],
    ['social_media', 1, 1],
    ['organic_search', 1, 1],
    [null, 1, 0],
    ['referral', 0, 0],
  ]);
  expect(latest.touches).toHaveLength(4);
  expect(latest.touches[0]).toMatchObject({ first: false, sessionSource: 'social_media' });
  const first = attributionReport.parse(
    await suite.api(one, 'getAttributionReport', { query: SEPTEMBER }),
  );
  expect(first.sources[0]).toMatchObject({ sessionSource: 'paid_search', leads: 2 });

  const recent = attributionReport.parse(await suite.api(one, 'getAttributionReport'));
  expect(recent.series.points).toHaveLength(30);
  const preset = attributionReport.parse(
    await suite.api(one, 'getAttributionReport', { query: { preset: 'last_year' } }),
  );
  expect(preset.series.grain).toBe('week');
  expect([seriesGrain(92), seriesGrain(93), seriesGrain(731), seriesGrain(732)]).toEqual([
    'day',
    'week',
    'week',
    'month',
  ]);
});

it('answers the Appointment report: statuses, channels, sources, calendars, people and days', async () => {
  const report = appointmentOverview.parse(
    await suite.api(one, 'getAppointmentOverview', { query: SEPTEMBER }),
  );
  expect(report).toMatchObject({
    total: 4,
    dateProperty: 'starts',
    attribution: 'first',
    reschedules: null,
  });
  expect(report.statuses).toEqual([
    { status: 'booked', count: 1 },
    { status: 'confirmed', count: 1 },
    { status: 'cancelled', count: 1 },
    { status: 'no_show', count: 0 },
    { status: 'completed', count: 1 },
    { status: 'invalid', count: 0 },
  ]);
  expect(report.channels).toEqual([
    { channel: 'user', count: 2 },
    { channel: 'booking_page', count: 1 },
    { channel: 'api', count: 1 },
  ]);
  expect(report.sources).toEqual([
    { sessionSource: 'paid_search', count: 1 },
    { sessionSource: 'organic_search', count: 1 },
    { sessionSource: 'referral', count: 1 },
    { sessionSource: null, count: 1 },
  ]);
  expect(report.calendars).toEqual([
    { calendar: { id: toPublicId('calendar', calendars.k1), name: 'Consultations' }, count: 2 },
    { calendar: { id: toPublicId('calendar', calendars.k2), name: 'Site visits' }, count: 2 },
  ]);
  expect(
    report.teamMembers.map((row) => [
      row.assignee === null ? null : row.assignee.membershipId?.slice(0, 4),
      row.count,
    ]),
  ).toEqual([
    [null, 3],
    ['mem_', 1],
  ]);
  expect(report.weekdays).toEqual([
    { weekday: 1, count: 1 },
    { weekday: 2, count: 1 },
    { weekday: 3, count: 1 },
    { weekday: 4, count: 1 },
    { weekday: 5, count: 0 },
    { weekday: 6, count: 0 },
    { weekday: 7, count: 0 },
  ]);
  expect(report.cancellations).toEqual([
    { calendar: { id: toPublicId('calendar', calendars.k1), name: 'Consultations' }, count: 1 },
  ]);
});

it('narrows the Appointment report to a calendar, a date and a preset', async () => {
  const k2 = appointmentOverview.parse(
    await suite.api(one, 'getAppointmentOverview', {
      query: { ...SEPTEMBER, calendarId: toPublicId('calendar', calendars.k2) },
    }),
  );
  expect(k2.total).toBe(2);
  expect(k2.cancellations).toEqual([]);
  const booked = appointmentOverview.parse(
    await suite.api(one, 'getAppointmentOverview', {
      query: {
        ...SEPTEMBER,
        dateProperty: 'created',
        calendarId: toPublicId('calendar', calendars.k1),
      },
    }),
  );
  // Both of K1's were booked on 6 September, a Sunday.
  expect(booked.weekdays[6]).toEqual({ weekday: 7, count: 2 });
  expect(booked.cancellations[0]?.count).toBe(1);
  const preset = appointmentOverview.parse(
    await suite.api(one, 'getAppointmentOverview', { query: { preset: 'this_year' } }),
  );
  expect(preset.range.preset).toBe('this_year');
  const refused = await refusalOf(
    () => suite.api(one, 'getAppointmentOverview', { query: { from: '2026-09-01' } }),
    ValidationError,
  );
  expect(refused.issues[0].path).toBe('/to');
});
