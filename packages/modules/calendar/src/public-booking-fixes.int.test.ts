// The public booking fixes of the 2026-10-14 edge-case hunt: one person has one diary
// across every business, confirmations in the booker's zone with a calendar invite
//, settings that now apply, the page's proof and hidden field, and booking
// without a mailbox.
import { randomUUID } from 'node:crypto';
import { BOOKING_NOTIFICATION_WORDING } from '@repo/contracts';
import { ConflictError, ValidationError } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it, vi } from 'vitest';
import { BookingTooSoonError } from './booking.js';
import { bookingFixtureSuite, renderToken, request } from '../test/booking-fixtures.js';

const suite = bookingFixtureSuite();
const { fixture, handlers } = suite;
let database: TestDatabase;
beforeAll(() => {
  database = suite.database;
});

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const booking = (date: string, time: string, email: string) => ({
  bookingRequestId: randomUUID(),
  startsAt: `${date}T${time}:00Z`,
  contact: { firstName: 'Maya', lastName: 'Lee', email },
  notificationConsent: true as const,
  contactTimezone: 'America/New_York',
});
const settled = <T>(attempt: Promise<T>) =>
  attempt.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

it('never books one person twice at once across two businesses, even when both are booked at the same moment (C4)', async () => {
  const a = await fixture('Studio A');
  const b = await fixture('Studio B', { user: a.user });
  const date = tomorrow();
  // Both pages offer 10:00 while nothing is booked.
  for (const f of [a, b])
    expect((await handlers().slots(f.params, { date }, request())).slots).toContainEqual({
      startsAt: `${date}T10:00:00Z`,
      endsAt: `${date}T10:30:00Z`,
    });
  // Ten rounds of two visitors, one on each business's page, sending the same time at once.
  for (const time of ['10:00', '11:00', '12:00', '13:00', '14:00']) {
    const results = await Promise.all([
      settled(
        handlers().book(
          a.params,
          booking(date, time, `a-${time.replace(':', '')}@example.test`),
          request(),
        ),
      ),
      settled(
        handlers().book(
          b.params,
          booking(date, time, `b-${time.replace(':', '')}@example.test`),
          request(),
        ),
      ),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused?.ok === false ? refused.error : undefined).toBeInstanceOf(ConflictError);
  }
  // Once one business holds 15:00, the other's page no longer offers it, and booking it fails.
  await handlers().book(a.params, booking(date, '15:00', 'first@example.test'), request());
  const offered = (await handlers().slots(b.params, { date }, request())).slots;
  expect(offered.map((slot) => slot.startsAt)).not.toContain(`${date}T15:00:00Z`);
  expect(offered.map((slot) => slot.startsAt)).toContain(`${date}T15:30:00Z`);
  await expect(
    handlers().book(b.params, booking(date, '15:00', 'second@example.test'), request()),
  ).rejects.toBeInstanceOf(ConflictError);
  const held = async (f: typeof a) =>
    database.withTenant(f.business.context, (sql) =>
      sql.query<{ n: number }>(
        "select count(*)::integer as n from calendar.appointments where status='booked'",
      ),
    );
  expect([(await held(a))[0]?.n ?? 0, (await held(b))[0]?.n ?? 0].reduce((x, y) => x + y)).toBe(6);
});

it('shows another business only busy times of its own team, and nothing of the appointments themselves', async () => {
  const a = await fixture('Studio A');
  const b = await fixture('Studio B', { user: a.user });
  const stranger = await fixture('Elsewhere');
  const date = tomorrow();
  await handlers().book(a.params, booking(date, '10:00', 'private@example.test'), request());
  const busy = (f: typeof a, userId: string) =>
    database.withTenant(f.business.context, (sql) =>
      sql.query(
        `select * from private.host_busy(array[$1]::uuid[], $2::timestamptz, $3::timestamptz)`,
        [userId, `${date}T00:00:00Z`, `${date}T23:59:00Z`],
      ),
    );
  // B's own host: one bare range, no business, appointment or contact.
  expect(await busy(b, a.user.id)).toEqual([
    {
      user_id: a.user.id,
      starts_at: new Date(`${date}T10:00:00Z`),
      ends_at: new Date(`${date}T10:30:00Z`),
    },
  ]);
  // A business that does not have the person on a calendar learns nothing.
  expect(await busy(stranger, a.user.id)).toEqual([]);
  // A's own appointments are A's to read as appointments, not through this.
  expect(await busy(a, a.user.id)).toEqual([]);
  // The app role cannot read the table of every business's busy times at all.
  await expect(
    database.withTenant(b.business.context, (sql) =>
      sql.query('select * from calendar.host_bookings'),
    ),
  ).rejects.toThrow(/permission denied/);
});

it('takes a booking without a mailbox: shown on the page with its link, no email (H5)', async () => {
  const f = await fixture('No mailbox', { mailbox: false });
  const page = await handlers().calendar(f.params, request());
  expect(page.notificationWording).toBe(BOOKING_NOTIFICATION_WORDING);
  const date = tomorrow();
  const receipt = await handlers().book(
    f.params,
    booking(date, '10:00', 'nomail@example.test'),
    request(),
  );
  expect(receipt).toMatchObject({ status: 'booked', emailed: false });
  expect(receipt.managementUrl).toMatch(/\/appointments\/manage\/[A-Za-z0-9_-]{43}$/);
  const token = receipt.managementUrl?.split('/').at(-1) ?? '';
  // It can be moved and cancelled from its link, with no email either.
  const shown = await handlers().appointment(token, request());
  const moved = await handlers().reschedule(
    token,
    { operationRequestId: randomUUID(), revision: shown.revision, startsAt: `${date}T11:00:00Z` },
    request(),
  );
  expect(moved).toMatchObject({ status: 'booked', startsAt: `${date}T11:00:00.000Z` });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select 1 from messaging.messages'),
    ),
  ).toEqual([]);
});

it('says the time in the booker’s zone and the calendar’s, and sends one invite UID through booking, moving and cancelling (H2)', async () => {
  const f = await fixture('Consultation');
  const date = tomorrow();
  const receipt = await handlers().book(
    f.params,
    booking(date, '15:00', 'zones@example.test'),
    request(),
  );
  expect(receipt.emailed).toBe(true);
  const token = receipt.managementUrl?.split('/').at(-1) ?? '';
  const first = await handlers().appointment(token, request());
  await handlers().reschedule(
    token,
    { operationRequestId: randomUUID(), revision: first.revision, startsAt: `${date}T16:00:00Z` },
    request(),
  );
  const second = await handlers().appointment(token, request());
  await handlers().cancel(
    token,
    { operationRequestId: randomUUID(), revision: second.revision },
    request(),
  );
  const sent = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ subject: string; body_text: string; method: string; content: string }>(
      `select m.subject, m.body_text, i.method, i.content
       from messaging.messages m join messaging.message_invites i on i.business_id=m.business_id and i.message_id=m.id
       order by m.created_at, m.id`,
    ),
  );
  expect(sent.map((message) => [message.subject, message.method])).toEqual([
    ['Your appointment is booked', 'REQUEST'],
    ['Your appointment has moved', 'REQUEST'],
    ['Your appointment is cancelled', 'CANCEL'],
  ]);
  const [booked, moved, cancelled] = sent;
  // The booker chose New York; the calendar is in UTC. Never a raw instant.
  expect(booked?.body_text).toContain('11:00 AM – 11:30 AM Eastern');
  expect(booked?.body_text).toContain('For the host:');
  expect(booked?.body_text).toContain('3:00 PM – 3:30 PM Coordinated Universal Time (UTC)');
  expect(booked?.body_text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  expect(booked?.body_text).toContain(receipt.managementUrl);
  const unfolded = (text = '') => text.replaceAll('\r\n ', '');
  const uid = /UID:(\S+)/.exec(unfolded(booked?.content))?.[1];
  expect(uid).toMatch(/^[0-9a-f-]{36}@crm\.example\.test$/);
  for (const [message, sequence] of [
    [booked, 0],
    [moved, 1],
    [cancelled, 2],
  ] as const) {
    const content = unfolded(message?.content);
    expect(content).toContain(`UID:${uid ?? ''}`);
    expect(content).toContain(`SEQUENCE:${String(sequence)}`);
    expect(content).toContain('ORGANIZER:mailto:bookings@example.test');
    expect(content).toContain('ATTENDEE;CN="Maya Lee";');
    expect(content).toContain('mailto:zones@example.test');
  }
  expect(unfolded(moved?.content)).toContain(`DTSTART:${date.replaceAll('-', '')}T160000Z`);
  expect(unfolded(cancelled?.content)).toContain('STATUS:CANCELLED');
});

it('asks for the page’s proof, keeps it for one booking, and drops a filled hidden field (H4)', async () => {
  const f = await fixture('Proof');
  const date = tomorrow();
  expect((await handlers().calendar(f.params, request())).renderToken).toMatch(
    /^[0-9]{13}\.[A-Za-z0-9_-]{43}$/,
  );
  // A program that fills the hidden field is told what a person is told, and nothing is stored.
  expect(
    await handlers().book(
      f.params,
      { ...booking(date, '10:00', 'bot@example.test'), trap: 'https://spam.example' },
      request(),
    ),
  ).toEqual({
    status: 'booked',
    startsAt: `${date}T10:00:00.000Z`,
    endsAt: `${date}T10:30:00.000Z`,
    emailed: false,
  });
  // Sent too soon after the page was shown: wait and send again.
  const slow = await settled(
    handlers().book(
      f.params,
      { ...booking(date, '10:00', 'a@example.test'), renderToken: renderToken('SLOW') },
      request(),
    ),
  );
  expect(slow.ok ? undefined : slow.error).toBeInstanceOf(BookingTooSoonError);
  expect(slow.ok ? 0 : (slow.error as BookingTooSoonError).retryAfterSeconds).toBe(2);
  // Not this server's, or shown to someone else: show the page again.
  await expect(
    handlers().book(
      f.params,
      { ...booking(date, '10:00', 'a@example.test'), renderToken: renderToken('STALE') },
      request(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  // One showing, one booking: the same token for a second booking is refused.
  const once = renderToken();
  await handlers().book(
    f.params,
    { ...booking(date, '10:00', 'a@example.test'), renderToken: once },
    request(),
  );
  await expect(
    handlers().book(
      f.params,
      { ...booking(date, '11:00', 'b@example.test'), renderToken: once },
      request(),
    ),
  ).rejects.toThrow('The booking page changed');
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select render_mark from calendar.appointments'),
    ),
  ).toEqual([{ render_mark: once.slice(14) }]);
});

it('applies the consent wording, the extra lengths and the owner setting of the calendar (H3)', async () => {
  const quiet = await fixture('No box', { settings: { consentEnabled: false } });
  const date = tomorrow();
  expect((await handlers().calendar(quiet.params, request())).notificationWording).toBeNull();
  const { notificationConsent: _ticked, ...unticked } = booking(
    date,
    '10:00',
    'nobox@example.test',
  );
  expect(await handlers().book(quiet.params, unticked, request())).toMatchObject({
    emailed: false,
  });
  expect(
    await database.withTenant(quiet.business.context, (sql) =>
      sql.query('select 1 from messaging.consents union all select 1 from messaging.messages'),
    ),
  ).toEqual([]);

  const own = 'Text me and email me about this visit.';
  const worded = await fixture('Own words', {
    settings: { consentText: own, extraDurationMinutes: [60, 90] },
  });
  const page = await handlers().calendar(worded.params, request());
  expect(page).toMatchObject({ notificationWording: own, durations: [30, 60, 90] });
  await expect(
    handlers().book(worded.params, { ...unticked, bookingRequestId: randomUUID() }, request()),
  ).rejects.toBeInstanceOf(ValidationError);
  // A length the calendar offers changes the slots and the booking; another is refused.
  const long = await handlers().slots(worded.params, { date, minutes: 90 }, request());
  expect(long.slots[0]).toEqual({ startsAt: `${date}T09:00:00Z`, endsAt: `${date}T10:30:00Z` });
  expect(long.slots.at(-1)?.startsAt).toBe(`${date}T15:30:00Z`);
  await expect(
    handlers().slots(worded.params, { date, minutes: 45 }, request()),
  ).rejects.toBeInstanceOf(ValidationError);
  const assignOwner = vi.fn(() => Promise.resolve());
  const receipt = await handlers(undefined, undefined, undefined, { assignOwner }).book(
    worded.params,
    { ...booking(date, '12:00', 'worded@example.test'), minutes: 60 },
    request(),
  );
  expect(receipt).toMatchObject({
    startsAt: `${date}T12:00:00.000Z`,
    endsAt: `${date}T13:00:00.000Z`,
  });
  const proof = await database.withTenant(worded.business.context, (sql) =>
    sql.query<{ wording: string }>("select proof->>'wording' as wording from messaging.consents"),
  );
  expect(proof).toEqual([{ wording: own }]);
  // The host is made the contact's owner, as the calendar is set to by default.
  expect(assignOwner).toHaveBeenCalledTimes(1);
  expect(assignOwner.mock.calls[0]).toEqual([
    expect.anything(),
    expect.objectContaining({ membershipId: worded.membershipId, keepExisting: false }),
    expect.anything(),
  ]);
  // Switched off, nobody is made the owner.
  const unassigned = await fixture('Leave owners', { settings: { assignContactToMember: false } });
  const untouched = vi.fn(() => Promise.resolve());
  await handlers(undefined, undefined, undefined, { assignOwner: untouched }).book(
    unassigned.params,
    booking(date, '12:00', 'left@example.test'),
    request(),
  );
  expect(untouched).not.toHaveBeenCalled();
});

it('keeps taking bookings and moves when the sender stops sending, and emails nothing then (H5)', async () => {
  const f = await fixture('Sender stops', { settings: { maxPerSlot: 1 } });
  const date = tomorrow();
  const receipt = await handlers().book(
    f.params,
    booking(date, '10:00', 'sender@example.test'),
    request(),
  );
  expect(receipt.emailed).toBe(true);
  // A start time that took its one booking is no longer offered (maxPerSlot).
  expect(
    (await handlers().slots(f.params, { date }, request())).slots.map((slot) => slot.startsAt),
  ).not.toContain(`${date}T10:00:00Z`);
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update messaging.channel_accounts set status='paused'"),
  );
  const token = receipt.managementUrl?.split('/').at(-1) ?? '';
  const shown = await handlers().appointment(token, request());
  await handlers().reschedule(
    token,
    { operationRequestId: randomUUID(), revision: shown.revision, startsAt: `${date}T11:00:00Z` },
    request(),
  );
  expect(
    await handlers().book(f.params, booking(date, '12:00', 'later@example.test'), request()),
  ).toMatchObject({ status: 'booked', emailed: false });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query<{ n: number }>('select count(*)::integer as n from messaging.messages'),
    ),
  ).toEqual([{ n: 1 }]);
});
