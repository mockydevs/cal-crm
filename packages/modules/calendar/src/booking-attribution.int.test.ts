// A public booking records where the booker came from, through the real booking command and
// the CRM's own recorder, against a migrated Postgres.
import { randomUUID } from 'node:crypto';

import { intakeContact, recordBookingTouch } from '@repo/module-crm';
import { expect, it } from 'vitest';

import { bookingFixtureSuite, request } from '../test/booking-fixtures.js';

const suite = bookingFixtureSuite();
const { fixture, handlers } = suite;

const day = (ahead: number): string =>
  new Date(Date.now() + ahead * 86_400_000).toISOString().slice(0, 10);

it('keeps the visit a booking came from on the contact, tied to the appointment', async () => {
  const f = await fixture();
  // As the server composes it: a booking makes its contact as a booking, and says so.
  const book = handlers(
    (trx, input, command) => intakeContact(trx, input, command, 'booking'),
    undefined,
    recordBookingTouch,
  );
  const booking = (ahead: number, visit?: { pageUrl?: string; referrer?: string }) =>
    book.book(
      f.params,
      {
        bookingRequestId: randomUUID(),
        startsAt: `${day(ahead)}T10:00:00Z`,
        contact: { firstName: 'Maya', email: 'maya@example.test' },
        notificationConsent: true as const,
        contactTimezone: 'UTC',
        ...(visit === undefined ? {} : { visit }),
      },
      request(),
    );
  await booking(1, {
    pageUrl:
      'https://crm.example.test/book/venue-tour?utm_source=fb_ad&utm_campaign=Open+day&fbclid=abc',
    referrer: 'https://l.facebook.com/',
  });
  // The same person books again, from a page that says nothing of the visit.
  await booking(2);

  const touches = await suite.database.withTenant(f.business.context, (sql) =>
    sql.query(
      `select t.medium, t.session_source, t.utm_campaign, t.fbclid, t.referrer_domain,
              t.landing_url, t.subject_kind, t.is_first, t.is_latest,
              a.id is not null as of_appointment
       from crm.contact_attributions t
       left join calendar.appointments a
         on a.business_id = t.business_id and a.id = t.subject_id and a.contact_id = t.contact_id
       order by t.touched_at, t.id`,
    ),
  );
  expect(touches).toEqual([
    {
      medium: 'calendar',
      session_source: 'paid_social',
      utm_campaign: 'Open day',
      fbclid: 'abc',
      referrer_domain: 'l.facebook.com',
      landing_url: 'https://crm.example.test/book/venue-tour',
      // The contact's own first touch, filled in by the booking that made it.
      subject_kind: 'appointment',
      is_first: true,
      is_latest: false,
      of_appointment: true,
    },
    {
      medium: 'calendar',
      session_source: 'direct',
      utm_campaign: null,
      fbclid: null,
      referrer_domain: null,
      landing_url: null,
      subject_kind: 'appointment',
      is_first: false,
      is_latest: true,
      of_appointment: true,
    },
  ]);
});

it('books as before when nothing records the visit', async () => {
  const f = await fixture();
  const receipt = await handlers().book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${day(1)}T10:00:00Z`,
      contact: { firstName: 'Amina', email: 'amina@example.test' },
      notificationConsent: true as const,
      contactTimezone: 'UTC',
      visit: { pageUrl: 'https://crm.example.test/book/venue-tour?utm_source=adwords' },
    },
    request(),
  );
  expect(receipt.status).toBe('booked');
  const touches = await suite.database.withTenant(f.business.context, (sql) =>
    sql.query<{ medium: string; utm_source: string | null }>(
      'select medium, utm_source from crm.contact_attributions',
    ),
  );
  // The contact still has the touch it was made with, and nothing of the visit.
  expect(touches).toEqual([{ medium: 'unknown', utm_source: null }]);
});
