// A reminder's link to reschedule or cancel (migration 0107) and the booking page's "Text me
// reminders" box, on real Postgres through the public booking handlers.
import { randomUUID } from 'node:crypto';
import { bookingTextWording } from '@repo/contracts';
import { withTenant, type Database } from '@repo/db';
import { NotFoundError, ValidationError } from '@repo/kernel';
import { hasActiveSmsNumber, recordBookingTextConsent } from '@repo/module-messaging';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';
import { bookingFixtureSuite, request } from '../test/booking-fixtures.js';
import { appointmentLinkDigest, appointmentManageUrl } from './appointment-links.js';

const suite = bookingFixtureSuite();
const { fixture, handlers, managedFixture } = suite;
let database: TestDatabase;
let db: Database;
beforeAll(() => {
  database = suite.database;
  db = suite.db;
});

const install = {
  secret: 'test-only-public-intake-key-0123456789',
  publicUrl: 'https://crm.example.test',
};
type Business = Awaited<ReturnType<typeof fixture>>['business'];

const appointmentOf = async (business: Business): Promise<string> => {
  const [row] = await database.withTenant(business.context, (sql) =>
    sql.query<{ id: string }>('select id from calendar.appointments order by id desc limit 1'),
  );
  if (row === undefined) throw new Error('No appointment.');
  return row.id;
};
const linkFor = (business: Business, appointmentId: string, given = install) =>
  withTenant(db, business.context, (trx) => appointmentManageUrl(trx, given, appointmentId));
const tokenOf = (url: string | null): string => {
  const token = url?.split('/appointments/manage/')[1];
  if (token === undefined) throw new Error(`Not a management address: ${String(url)}`);
  return token;
};

it('opens the appointment it was made for, the same link each time, and moves it', async () => {
  const f = await managedFixture();
  const id = await appointmentOf(f.business);
  const url = await linkFor(f.business, id);
  expect(url).toMatch(/^https:\/\/crm\.example\.test\/appointments\/manage\/[A-Za-z0-9_-]{43}$/);
  // Written again in every reminder: the same address, one row.
  expect(await linkFor(f.business, id)).toBe(url);
  const token = tokenOf(url);
  // Only the digest is kept, never the token.
  const rows = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ digest: string }>('select digest from calendar.appointment_links'),
  );
  expect(rows).toEqual([{ digest: appointmentLinkDigest(token) }]);
  expect(JSON.stringify(rows)).not.toContain(token);

  const api = handlers();
  const page = await api.appointment(token, request());
  expect(page).toEqual(f.appointment);
  const slots = await api.appointmentSlots(token, { date: f.date }, request());
  const later = slots.slots.find((slot) => slot.startsAt !== page.startsAt);
  if (later === undefined) throw new Error('No other slot.');
  const moved = await api.reschedule(
    token,
    { operationRequestId: randomUUID(), revision: page.revision, startsAt: later.startsAt },
    request(),
  );
  const movedTo = new Date(later.startsAt).toISOString();
  expect(moved).toMatchObject({ status: 'booked', startsAt: movedTo });
  // A reschedule keeps the link working for the new time; the booker's own token too.
  expect(await api.appointment(token, request())).toMatchObject({ startsAt: movedTo });
  expect(await api.appointment(f.token, request())).toMatchObject({ startsAt: movedTo });
});

it('stops when the appointment is cancelled or has ended', async () => {
  const f = await managedFixture();
  const id = await appointmentOf(f.business);
  const token = tokenOf(await linkFor(f.business, id));
  const api = handlers();
  const page = await api.appointment(token, request());
  expect(
    await api.cancel(
      token,
      { operationRequestId: randomUUID(), revision: page.revision },
      request(),
    ),
  ).toMatchObject({ status: 'cancelled' });
  // Cancelled: the reminder link opens nothing, and no new one is made.
  await expect(api.appointment(token, request())).rejects.toBeInstanceOf(NotFoundError);
  await expect(api.appointmentSlots(token, { date: f.date }, request())).rejects.toBeInstanceOf(
    NotFoundError,
  );
  expect(await linkFor(f.business, id)).toBeNull();
  // The booker's own token still shows what happened, as before.
  expect(await api.appointment(f.token, request())).toMatchObject({ status: 'cancelled' });

  const g = await managedFixture();
  const other = await appointmentOf(g.business);
  const live = tokenOf(await linkFor(g.business, other));
  await database.withTenant(g.business.context, (sql) =>
    sql.query(
      "update calendar.appointments set starts_at=now()-interval '2 hours', ends_at=now()-interval '1 hour'",
    ),
  );
  // Ended: refused for reading, rescheduling and cancelling alike.
  await expect(api.appointment(live, request())).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    api.cancel(
      live,
      { operationRequestId: randomUUID(), revision: g.appointment.revision },
      request(),
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(await linkFor(g.business, other)).toBeNull();
});

it('is made by no install without public pages, and a new secret replaces it', async () => {
  const f = await managedFixture();
  const id = await appointmentOf(f.business);
  expect(await linkFor(f.business, id, { ...install, secret: '' })).toBeNull();
  expect(await linkFor(f.business, id, { ...install, publicUrl: 'not an address' })).toBeNull();
  const first = tokenOf(await linkFor(f.business, id));
  const second = tokenOf(
    await linkFor(f.business, id, {
      ...install,
      secret: 'another-test-only-intake-key-9876543210',
    }),
  );
  expect(second).not.toBe(first);
  await expect(handlers().appointment(first, request())).rejects.toBeInstanceOf(NotFoundError);
  expect(await handlers().appointment(second, request())).toMatchObject({ status: 'booked' });
});

it("opens only its own business's appointment, and another business can't make or see one", async () => {
  const a = await managedFixture();
  const b = await managedFixture();
  const ofA = await appointmentOf(a.business);
  const ofB = await appointmentOf(b.business);
  const tokenA = tokenOf(await linkFor(a.business, ofA));
  const tokenB = tokenOf(await linkFor(b.business, ofB));
  expect(tokenA).not.toBe(tokenB);
  expect(await handlers().appointment(tokenA, request())).toEqual(a.appointment);
  expect(await handlers().appointment(tokenB, request())).toEqual(b.appointment);
  // Business B can't make a link to A's appointment, nor read A's links.
  expect(await linkFor(b.business, ofA)).toBeNull();
  expect(
    await database.withTenant(b.business.context, (sql) =>
      sql.query('select appointment_id from calendar.appointment_links'),
    ),
  ).toEqual([{ appointment_id: ofB }]);
  // A token's digest planted on another appointment opens nothing it was not made for:
  // the digest is unique, so the row can't be copied.
  await expect(
    database.withTenant(b.business.context, (sql) =>
      sql.query(
        'insert into calendar.appointment_links(business_id,appointment_id,digest) values(app.business_id(),$1,$2)',
        [ofB, appointmentLinkDigest(tokenA)],
      ),
    ),
  ).rejects.toThrow();
});

/** A business with a number that can text, as the composer and the worker read it. */
async function withSmsNumber(business: Business): Promise<void> {
  const { agencyId, businessId } = business.context;
  await database.as('postgres', async (sql) => {
    const secret = await sql.one<{ id: string }>(
      `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
       values ($1, $2, 'sms.credentials', 1, decode(repeat('01', 32), 'hex'), decode(repeat('ab', 32), 'hex'))
       returning id`,
      [agencyId, businessId],
    );
    const connection = await sql.one<{ id: string }>(
      `insert into messaging.provider_connections (agency_id, business_id, provider, label, account_ref, secret_id, status)
       values ($1, $2, 'twilio', 'Main', 'AC' || $3, $4, 'connected') returning id`,
      [agencyId, businessId, randomUUID().replaceAll('-', ''), secret.id],
    );
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts (business_id, channel, name, status) values ($1, 'sms', 'Front desk', 'active') returning id",
      [businessId],
    );
    // A number is registered once in the whole install, so each gets digits of its own.
    await sql.query(
      `insert into messaging.phone_numbers (business_id, id, e164, provider_connection_id, provider_number_ref, capabilities)
       values ($1, $2, '+1444' || lpad(floor(random() * 10000000)::text, 7, '0'), $3, 'PN' || $4, '{sms}')`,
      [businessId, account.id, connection.id, randomUUID().replaceAll('-', '')],
    );
  });
}

const texts = { available: hasActiveSmsNumber, recordConsent: recordBookingTextConsent };

it('offers "Text me reminders" only where the business can text, and records what was ticked', async () => {
  const f = await fixture();
  const api = handlers(undefined, undefined, undefined, { texts });
  // No number that texts: no box.
  expect((await api.calendar(f.params, request())).textWording).toBeUndefined();
  await withSmsNumber(f.business);
  // The words name the business that sends, by its name now (CTIA 5.1.1).
  const renamed = async (name: string) => {
    await database.as('crm_owner', (sql) =>
      sql.query('update tenancy.businesses set name = $2 where id = $1', [f.business.id, name]),
    );
    return bookingTextWording(name);
  };
  const shown = await renamed('Harbor Point Events');
  expect(shown).toBe(
    'Text me reminders about this appointment from Harbor Point Events. Message frequency varies. Message and data rates may apply. Reply HELP for help or STOP to opt out.',
  );
  expect((await api.calendar(f.params, request())).textWording).toBe(shown);
  // A page without the port offers none either.
  expect((await handlers().calendar(f.params, request())).textWording).toBeUndefined();

  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const book = (at: string, email: string, more: Record<string, unknown>) =>
    api.book(
      f.params,
      {
        bookingRequestId: randomUUID(),
        startsAt: `${date}T${at}:00Z`,
        contact: { email, phone: '+1 (212) 555-0123' },
        notificationConsent: true,
        contactTimezone: 'America/New_York',
        ...more,
      },
      request(),
    );
  // Renamed after the page was read: the proof holds the words rendered at booking.
  const kept = await renamed('Harbor Point Weddings');
  await book('10:00', 'ticked@example.test', { textConsent: true });
  await book('11:00', 'unticked@example.test', {});
  // Words sent by the browser are never taken: the booking is refused as malformed.
  await expect(
    book('13:00', 'worded@example.test', { textConsent: true, textWording: 'Anything at all.' }),
  ).rejects.toBeInstanceOf(ValidationError);
  const consents = await database.withTenant(f.business.context, (sql) =>
    sql.query<{
      channel: string;
      purpose: string;
      address_normalized: string | null;
      source: string;
      proof: Record<string, string>;
      email: string;
    }>(
      `select k.channel, k.purpose, k.address_normalized, k.source, k.proof, i.value_normalized as email
       from messaging.consents k
       join crm.contact_identities i on i.contact_id = k.contact_id and i.kind = 'email'
       where k.channel = 'sms'`,
    ),
  );
  // Only the ticked box gives consent, for the number typed, with the words shown.
  expect(consents).toHaveLength(1);
  expect(consents[0]).toMatchObject({
    channel: 'sms',
    purpose: 'transactional',
    address_normalized: '+12125550123',
    source: 'booking',
    email: 'ticked@example.test',
    proof: { wording: kept, ipAddress: '203.0.113.10' },
  });
  expect(consents[0]?.proof['appointmentId']).toMatch(/^[0-9a-f-]{36}$/);

  // The box is for the number given with it.
  await expect(
    api.book(
      f.params,
      {
        bookingRequestId: randomUUID(),
        startsAt: `${date}T12:00:00Z`,
        contact: { email: 'nophone@example.test' },
        notificationConsent: true,
        textConsent: true,
        contactTimezone: 'UTC',
      },
      request(),
    ),
  ).rejects.toBeInstanceOf(ValidationError);
});

it('keeps a number that sent STOP opted out, whatever the box says', async () => {
  const f = await fixture();
  await withSmsNumber(f.business);
  // A STOP from the number, recorded before this contact existed.
  await database.as('postgres', (sql) =>
    sql.query(
      `insert into messaging.consents (business_id, channel, purpose, status, source, address_normalized, proof, recorded_by_kind)
       values ($1, 'sms', 'transactional', 'withdrawn', 'keyword', '+12125550123', '{"keyword": "STOP"}', 'contact')`,
      [f.business.context.businessId],
    ),
  );
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await handlers(undefined, undefined, undefined, { texts }).book(
    f.params,
    {
      bookingRequestId: randomUUID(),
      startsAt: `${date}T10:00:00Z`,
      contact: { email: 'stopped@example.test', phone: '+1 212 555 0123' },
      notificationConsent: true,
      textConsent: true,
      contactTimezone: 'UTC',
    },
    request(),
  );
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query("select status from messaging.consents where channel='sms'"),
    ),
  ).toEqual([{ status: 'withdrawn' }]);
});
