// Google Calendar for each team member, against real Postgres and a local stand-in for
// Google (test/fake-google.ts). Nothing here reaches Google.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  allowEveryone,
  runCommand,
  type AnyTask,
  type Invocation,
  type Services,
} from '@repo/commands';
import { withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  ValidationError,
} from '@repo/kernel';
import { lockBookingContact, readContactNames } from '@repo/module-crm';
import {
  queueCalendarConfirmation,
  readCalendarConfirmationRecipient,
} from '@repo/module-messaging';
import { readCalendarMemberMemberships } from '@repo/module-tenancy';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import type { TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { bookingFixtureSuite, calendars, request } from '../../test/booking-fixtures.js';
import { readTestNames } from '../../test/people.js';
import { createAppointmentRoutes, type AppointmentOptions } from '../index.js';
import {
  ALL_SCOPES,
  FAKE_CLIENT,
  startFakeGoogle,
  type FakeGoogle,
} from '../../test/fake-google.js';
import { createGoogleTransport } from './google-api.js';
import { freshenGoogleBusy, readGoogleBusy } from './google-busy.js';
import {
  completeGoogleConnect,
  completeGoogleConnectCommand,
  connectGoogleCommand,
  createGoogleCalendarRoutes,
  type GoogleConnectionOptions,
} from './google-connections.js';
import { createGoogleWorker, scheduleGoogleRefreshes, type GoogleWorker } from './google-worker.js';

const suite = bookingFixtureSuite();
const { fixture, handlers } = suite;
let database: TestDatabase;
let db: Database;
let services: Services;
let fake: FakeGoogle;
let vault: Vault;
let options: GoogleConnectionOptions;
let worker: GoogleWorker;
/** Who was told their Google Calendar stopped working. */
const told: { userId: string; connectionId: string }[] = [];

beforeAll(async () => {
  database = suite.database;
  db = suite.db;
  services = { db, authorize: allowEveryone };
  fake = await startFakeGoogle();
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  const google = { client: FAKE_CLIENT, transport: createGoogleTransport(fake.fetch) };
  options = { google, vault, members: { memberships: readCalendarMemberMemberships } };
  worker = createGoogleWorker({
    google,
    vault,
    members: { memberships: readCalendarMemberMemberships },
    notifyDisconnected: (_trx, _context, notice) => {
      told.push(notice);
      return Promise.resolve();
    },
    random: () => 0.5,
  });
});
afterAll(async () => {
  await fake.close();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const grants = new Set(['appointments.manage', 'calendars.manage'] as const);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

/** The host, signed in, in their business. */
function person(f: Fixture, permissions: Invocation['permissions'] = grants): Invocation {
  return {
    context: {
      agencyId: f.business.agencyId,
      businessId: f.business.id,
      userId: f.user.id,
      actorKind: 'user',
      actorId: f.user.id,
      correlationId: randomUUID(),
    },
    permissions,
  };
}

function route(operationId: string, invocation: Invocation, body?: unknown): Promise<unknown> {
  const found = createGoogleCalendarRoutes(options).find(
    (each) => each.endpoint.operationId === operationId,
  );
  if (found === undefined) throw new Error(`Missing ${operationId}.`);
  return found.run({ invocation, params: {}, query: {}, body }, services);
}

/** Runs the queued Google jobs as the worker would, until none are left. */
async function work(): Promise<string[]> {
  const tasks = new Map<string, AnyTask>(worker.tasks.map((task) => [task.name, task]));
  const ran: string[] = [];
  for (let round = 0; round < 20; round += 1) {
    const received = await database.runJobs([...tasks.keys()]);
    if (received.length === 0) break;
    for (const job of received) {
      const envelope = job.payload as {
        agencyId: string;
        businessId: string;
        correlationId: string;
        data: unknown;
      };
      const task = tasks.get(job.task);
      if (task === undefined) throw new Error(`No task ${job.task}.`);
      await task.run(task.data.parse(envelope.data), {
        invocation: {
          context: {
            agencyId: envelope.agencyId,
            businessId: envelope.businessId,
            actorKind: 'system',
            correlationId: envelope.correlationId,
          },
          permissions: 'all',
        },
        services,
      });
      ran.push(job.task);
    }
  }
  return ran;
}

interface Connected {
  readonly sub: string;
  readonly primary: string;
}

/** Connects the host's Google account, as the browser and Google would, and reads it. */
async function connect(f: Fixture, sub = `g${randomUUID().slice(0, 8)}`): Promise<Connected> {
  const primary = `${sub}@example.test`;
  fake.addAccount({
    sub,
    email: primary,
    calendars: [
      { id: primary, summary: primary, primary: true, accessRole: 'owner' },
      { id: `team-${sub}`, summary: 'Team', accessRole: 'writer' },
      { id: `holidays-${sub}`, summary: 'Holidays', accessRole: 'reader' },
    ],
  });
  const started = (await route('connectGoogle', person(f))) as { authorizationUrl: string };
  const url = new URL(started.authorizationUrl);
  const code = fake.consent({ sub, codeChallenge: url.searchParams.get('code_challenge') ?? '' });
  const result = await completeGoogleConnect(
    options,
    services,
    { state: url.searchParams.get('state') ?? undefined, code, error: undefined },
    { userId: f.user.id, grantsIn: () => Promise.resolve(grants) },
    randomUUID(),
  );
  expect(result).toEqual({
    outcome: 'connected',
    path: '/b/events/settings/calendars/connections',
  });
  await work();
  return { sub, primary };
}

const connectionOf = (f: Fixture) =>
  database.withTenant(f.business.context, (sql) =>
    sql.one<{
      id: string;
      status: string;
      disconnected_reason: string | null;
      secret_id: string | null;
      write_calendar_id: string | null;
    }>(
      'select id, status, disconnected_reason, secret_id, write_calendar_id from calendar.google_connections where user_id = $1',
      [f.user.id],
    ),
  );

/** Makes the connection due and runs the sweep and what it queues. */
async function refreshNow(f: Fixture): Promise<void> {
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      "update calendar.google_connections set next_refresh_at = now() - interval '1 second' where user_id = $1",
      [f.user.id],
    ),
  );
  await scheduleGoogleRefreshes(services);
  await work();
}

const slotsOn = async (f: Fixture, date: string) =>
  (await handlers().slots(f.params, { date }, request())).slots.map((slot) =>
    slot.startsAt.slice(11, 16),
  );

const calendarIdOf = async (f: Fixture) =>
  (
    await database.withTenant(f.business.context, (sql) =>
      sql.one<{ id: string }>('select id from calendar.calendars'),
    )
  ).id;

/** The team's appointment routes' ports, as the server composes them (api-routes.ts). */
const teamPorts: AppointmentOptions = {
  calendars,
  members: calendars.members,
  contacts: { names: readContactNames, lock: lockBookingContact },
  people: { names: readTestNames },
  notifications: {
    queue: queueCalendarConfirmation,
    recipient: readCalendarConfirmationRecipient,
  },
};

/** The fresh look as the server gives it (start.ts), with the worker answering meanwhile. */
const google = {
  freshen: async (
    context: Parameters<typeof freshenGoogleBusy>[1],
    calendarId: string,
    range: { readonly from: Date; readonly to: Date },
  ) => {
    const asked = freshenGoogleBusy(db, context, calendarId, range, 5000);
    // The worker answers meanwhile, as it would beside the app.
    for (let tries = 0; tries < 40; tries += 1) {
      await sleep(50);
      if ((await work()).includes('calendar.google.check_busy')) break;
    }
    return asked;
  },
};

const booking = (date: string, time: string) => ({
  bookingRequestId: randomUUID(),
  startsAt: `${date}T${time}:00Z`,
  contact: { firstName: 'Maya', lastName: 'Lee', email: `maya-${randomUUID()}@example.test` },
  notificationConsent: true as const,
  contactTimezone: 'UTC',
});

it('connects with a single-use state and PKCE, seals the token, and reads the calendars', async () => {
  const f = await fixture();
  const started = (await route('connectGoogle', person(f))) as { authorizationUrl: string };
  const url = new URL(started.authorizationUrl);
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    client_id: FAKE_CLIENT.clientId,
    redirect_uri: FAKE_CLIENT.redirectUri,
    response_type: 'code',
    scope: ALL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge_method: 'S256',
  });
  expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const { primary, sub } = await connect(f);
  const connection = await connectionOf(f);
  expect(connection).toMatchObject({ status: 'connected', write_calendar_id: primary });
  const view = (await route('getGoogleConnections', person(f))) as {
    available: boolean;
    mine: { calendars: { id: string; checkConflicts: boolean }[]; email: string };
    team: unknown[];
  };
  expect(view.available).toBe(true);
  expect(view.mine.email).toBe(primary);
  // The primary calendar is checked for conflicts and linked, as GoHighLevel starts.
  expect(view.mine.calendars.map((each) => [each.id, each.checkConflicts])).toEqual([
    [primary, true],
    [`team-${sub}`, false],
    [`holidays-${sub}`, false],
  ]);
  expect(view.team).toHaveLength(1);

  // The refresh token is nowhere in clear: not in the connection, the audit log, the events
  // or the vault's sealed bytes as crm_app reads them.
  const leaks = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ found: string }>(
      `select 'connection' as found from calendar.google_connections c where c::text like '%1//fixture%'
       union all select 'audit' from audit.commands a where a::text like '%1//fixture%'
       union all select 'event' from events.events e where e::text like '%1//fixture%'
       union all select 'vault' from vault.secrets s
         where encode(s.ciphertext, 'escape') like '%1//fixture%'`,
    ),
  );
  expect(leaks).toEqual([]);
  expect(connection.secret_id).not.toBeNull();
});

it('refuses another person’s state, a spent one, a denied or partial consent and a wrong verifier', async () => {
  const f = await fixture();
  const sub = `g${randomUUID().slice(0, 8)}`;
  fake.addAccount({
    sub,
    email: `${sub}@example.test`,
    calendars: [{ id: `${sub}@example.test`, summary: 'Mine', primary: true, accessRole: 'owner' }],
  });
  const start = async () => {
    const url = new URL(
      ((await route('connectGoogle', person(f))) as { authorizationUrl: string }).authorizationUrl,
    );
    return {
      state: url.searchParams.get('state') ?? '',
      challenge: url.searchParams.get('code_challenge') ?? '',
    };
  };
  const finish = (
    attempt: { state: string },
    code: string | undefined,
    userId = f.user.id,
    error?: string,
  ) =>
    completeGoogleConnect(
      options,
      services,
      { state: attempt.state, code, error },
      { userId, grantsIn: () => Promise.resolve(grants) },
      randomUUID(),
    );

  const first = await start();
  const code = fake.consent({ sub, codeChallenge: first.challenge });
  // Someone else's browser can't finish it, and doesn't spend it.
  expect((await finish(first, code, randomUUID())).outcome).toBe('failed');
  expect((await finish(first, code)).outcome).toBe('connected');
  // A state works once.
  expect((await finish(first, code)).outcome).toBe('expired');
  expect((await finish({ state: 'never-issued' }, code)).outcome).toBe('expired');

  const denied = await start();
  expect((await finish(denied, undefined, f.user.id, 'access_denied')).outcome).toBe('denied');

  const partial = await start();
  const revokedBefore = fake.revoked.length;
  const partialCode = fake.consent({
    sub,
    codeChallenge: partial.challenge,
    scopes: ALL_SCOPES.filter((scope) => !scope.endsWith('calendar.events')),
  });
  expect((await finish(partial, partialCode)).outcome).toBe('scopes_missing');
  // What Google gave without every box is revoked at once, never kept.
  expect(fake.revoked.length).toBe(revokedBefore + 1);

  // A code given for another attempt's challenge fails PKCE at the token endpoint.
  const other = await start();
  const wrong = await start();
  const stolen = fake.consent({ sub, codeChallenge: other.challenge });
  expect((await finish(wrong, stolen)).outcome).toBe('failed');
});

it('keeps Google busy time out of slots, and time not read lately; a disconnected member is the CRM’s alone', async () => {
  const f = await fixture();
  const date = tomorrow();
  const { primary } = await connect(f);
  expect(await slotsOn(f, date)).toHaveLength(16);
  fake.setBusy(primary, [{ start: `${date}T10:00:00Z`, end: `${date}T11:00:00Z` }]);
  await refreshNow(f);
  const offered = await slotsOn(f, date);
  expect(offered).toHaveLength(14);
  expect(offered).not.toContain('10:00');
  expect(offered).not.toContain('10:30');

  // Twenty minutes without a reading: Google's time is unknown, and unknown is not free.
  await database.as('crm_owner', (sql) =>
    sql.query(
      "update calendar.google_busy_windows set checked_at = now() - interval '20 minutes' where business_id = $1",
      [f.business.id],
    ),
  );
  expect(await slotsOn(f, date)).toEqual([]);

  await route('disconnectGoogle', person(f));
  expect(await slotsOn(f, date)).toHaveLength(16);
  // A disconnected connection has no calendars to choose or read again.
  await expect(route('refreshGoogleCalendars', person(f))).rejects.toBeInstanceOf(NotFoundError);
});

it('looks at Google again for the slot when booking, and refuses time busy there', async () => {
  const f = await fixture();
  const date = tomorrow();
  const { primary } = await connect(f);
  // Busy in Google after the last reading: the store still says free.
  fake.setBusy(primary, [{ start: `${date}T10:00:00Z`, end: `${date}T10:30:00Z` }]);
  expect(await slotsOn(f, date)).toContain('10:00');
  await expect(
    handlers(undefined, undefined, undefined, { google }).book(
      f.params,
      booking(date, '10:00'),
      request(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    handlers(undefined, undefined, undefined, { google }).book(
      f.params,
      booking(date, '11:00'),
      request(),
    ),
  ).resolves.toMatchObject({ status: 'booked' });
  // Google fails the fresh look: a reading of the last 15 minutes still decides.
  fake.failNext('POST', /\/freeBusy$/, 503);
  await expect(
    handlers(undefined, undefined, undefined, { google }).book(
      f.params,
      booking(date, '12:00'),
      request(),
    ),
  ).resolves.toMatchObject({ status: 'booked' });
  const checks = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ outcome: string }>(
      'select outcome from calendar.google_busy_checks order by requested_at',
    ),
  );
  expect(checks.map((check) => check.outcome)).toEqual(['ok', 'ok', 'failed']);
});

it('looks at Google again before the team books or moves, and before the booker moves', async () => {
  const f = await fixture();
  const date = tomorrow();
  const { primary } = await connect(f);
  const team = (operationId: string, body: unknown, id?: string, invocation = person(f)) => {
    const found = createAppointmentRoutes({ ...teamPorts, google }).find(
      (each) => each.endpoint.operationId === operationId,
    );
    if (found === undefined) throw new Error(`Missing ${operationId}.`);
    return found.run(
      { invocation, params: id === undefined ? {} : { id }, query: {}, body },
      services,
    ) as Promise<{ id: string; revision: string; startsAt: string }>;
  };
  const checks = async () =>
    (
      await database.withTenant(f.business.context, (sql) =>
        sql.query<{ outcome: string | null }>('select outcome from calendar.google_busy_checks'),
      )
    ).length;
  const contactId = toPublicId(
    'contact',
    (await database.fixtures.contact(f.business.context, { firstName: 'Ines' })).id,
  );
  const busy: { start: string; end: string }[] = [];
  /** Busy in Google after the last reading: the store still offers the time. */
  const busyInGoogle = async (time: string) => {
    busy.push({ start: `${date}T${time}:00Z`, end: `${date}T${time.slice(0, 3)}30:00Z` });
    fake.setBusy(primary, busy);
    expect(await slotsOn(f, date)).toContain(time);
  };
  const book = (time: string, more: Record<string, unknown> = {}) =>
    team('createAppointment', {
      requestId: randomUUID(),
      calendarId: f.saved.calendar.id,
      contactId,
      startsAt: `${date}T${time}:00Z`,
      ...more,
    });

  // The team books: the fresh look finds the meeting, and the time is refused.
  await busyInGoogle('10:00');
  await expect(book('10:00')).rejects.toBeInstanceOf(ConflictError);
  expect(await checks()).toBe(1);
  const booked = await book('11:00');
  expect(await checks()).toBe(2);
  // A time set exactly sets the calendar's rules aside, Google with them: nothing is asked.
  await book('16:00', { endsAt: `${date}T16:30:00Z`, ignoreAvailability: true });
  expect(await checks()).toBe(2);

  // The team moves it: the same.
  await busyInGoogle('13:00');
  await expect(
    team(
      'rescheduleAppointment',
      { revision: booked.revision, startsAt: `${date}T13:00:00Z` },
      booked.id,
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  const moved = await team(
    'rescheduleAppointment',
    { revision: booked.revision, startsAt: `${date}T12:00:00Z` },
    booked.id,
  );
  expect(moved.startsAt).toBe(`${date}T12:00:00.000Z`);

  // The booker moves theirs from the management link: the same.
  const api = handlers(undefined, undefined, undefined, { google });
  const page = await api.book(f.params, booking(date, '15:00'), request());
  const token = page.managementUrl?.split('/').at(-1) ?? '';
  await busyInGoogle('14:00');
  const opened = await api.appointment(token, request());
  await expect(
    api.reschedule(
      token,
      {
        operationRequestId: randomUUID(),
        revision: opened.revision,
        startsAt: `${date}T14:00:00Z`,
      },
      request(),
    ),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(
    api.reschedule(
      token,
      {
        operationRequestId: randomUUID(),
        revision: opened.revision,
        startsAt: `${date}T14:30:00Z`,
      },
      request(),
    ),
  ).resolves.toMatchObject({ startsAt: `${date}T14:30:00.000Z` });

  // Someone who may not book is refused, and makes the worker ask Google nothing.
  const before = await checks();
  await expect(
    team(
      'createAppointment',
      {
        requestId: randomUUID(),
        calendarId: f.saved.calendar.id,
        contactId,
        startsAt: `${date}T09:00:00Z`,
      },
      undefined,
      person(f, new Set(['calendars.manage'])),
    ),
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(await checks()).toBe(before);
});

it('writes each appointment once, moves it and deletes it, through Google’s failures', async () => {
  const f = await fixture();
  const date = tomorrow();
  const { primary } = await connect(f);
  await handlers().book(f.params, booking(date, '11:00'), request());
  expect(await work()).toContain('calendar.google.sync_appointment');
  const [event] = fake.events(primary);
  const appointment = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string; title: string }>('select id, title from calendar.appointments'),
  );
  expect(event).toMatchObject({
    id: `crm${appointment.id.replaceAll('-', '')}g1`,
    status: 'confirmed',
    summary: appointment.title,
    start: { dateTime: `${date}T11:00:00.000Z`, timeZone: 'UTC' },
    end: { dateTime: `${date}T11:30:00.000Z`, timeZone: 'UTC' },
    extendedProperties: { private: { crmAppointmentId: appointment.id } },
  });
  // No attendees: Google sends nobody anything; the booker's invite is the CRM's.
  expect(event?.attendees).toBeUndefined();
  expect(event?.description).toContain('Contact: Maya Lee');

  // Moved: Google fails once, the job is tried again, and the event moves.
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      "update calendar.appointments set starts_at = starts_at + interval '2 hours', ends_at = ends_at + interval '2 hours'",
    ),
  );
  fake.failNext('PATCH', /\/events\//, 503);
  await expect(
    worker.syncAppointment(appointment.id, f.business.context, services),
  ).rejects.toThrow(/tried again/);
  await worker.syncAppointment(appointment.id, f.business.context, services);
  await work();
  expect(fake.events(primary)).toHaveLength(1);
  expect(fake.events(primary)[0]?.start.dateTime).toBe(`${date}T13:00:00.000Z`);

  // Its own copy never blocks it: the store has it busy, slots don't.
  fake.setBusy(primary, [{ start: `${date}T13:00:00Z`, end: `${date}T13:30:00Z` }]);
  await refreshNow(f);
  const busy = await withTenant(db, f.business.context, (trx) =>
    readGoogleBusy(trx, f.business.id, [f.user.id], {
      from: new Date(`${date}T00:00:00Z`),
      to: new Date(`${date}T23:59:00Z`),
    }),
  );
  expect(busy.get(f.user.id)).toEqual([]);
  // Nobody asked about, and no business to ask in, cost nothing.
  expect(
    await withTenant(db, f.business.context, (trx) =>
      readGoogleBusy(trx, f.business.id, [], { from: new Date(), to: new Date() }),
    ),
  ).toEqual(new Map());
  expect(
    await freshenGoogleBusy(
      db,
      { agencyId: f.business.agencyId, actorKind: 'system', correlationId: randomUUID() },
      randomUUID(),
      { from: new Date(), to: new Date(Date.now() + 1000) },
    ),
  ).toBe('not_needed');

  // An answer lost after Google kept the event: the next write finds it and patches it.
  await database.as('crm_owner', (sql) =>
    sql.query('delete from calendar.google_event_syncs where appointment_id = $1', [
      appointment.id,
    ]),
  );
  await worker.syncAppointment(appointment.id, f.business.context, services);
  expect(fake.events(primary)).toHaveLength(1);

  // Cancelled: deleted in Google, once.
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update calendar.appointments set status = 'cancelled', cancelled_at = now()"),
  );
  await work();
  expect(fake.events(primary).map((each) => each.status)).toEqual(['cancelled']);
  const sync = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ state: string }>('select state from calendar.google_event_syncs'),
  );
  expect(sync.state).toBe('deleted');
});

it('adds a Google Meet as the meeting place and writes its link into the appointment', async () => {
  const f = await fixture();
  const date = tomorrow();
  const { primary } = await connect(f);
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `update calendar.calendar_members
       set locations = '[{"kind":"google_meet","value":"Google Meet","label":null}]'::jsonb`,
    ),
  );
  fake.holdMeets(true);
  await handlers().book(f.params, booking(date, '12:00'), request());
  await work();
  const appointment = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string; location: string | null }>(
      'select id, location from calendar.appointments',
    ),
  );
  // Google makes the Meet in its own time: the appointment says Google Meet meanwhile, and
  // the job comes back for the link.
  expect(appointment.location).toBe('Google Meet');
  const waiting = await database.as('crm_owner', (sql) =>
    sql.query<{ key: string }>('select key from graphile_worker.jobs where key = $1', [
      `calendar-google-meet:${appointment.id}`,
    ]),
  );
  expect(waiting).toHaveLength(1);
  fake.holdMeets(false);
  fake.finishMeets();
  await worker.syncAppointment(appointment.id, f.business.context, services);
  const after = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ location: string }>('select location from calendar.appointments'),
  );
  expect(after.location).toMatch(/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  // The location's change queues a sync that has nothing to write.
  const before = fake.requests.length;
  await work();
  expect(
    fake.requests
      .slice(before)
      .filter((each) => each.method !== 'POST' || !each.path.endsWith('/token')),
  ).toEqual([]);
  expect(fake.events(primary)).toHaveLength(1);
});

it('gives a Google Meet only while the member is connected, and the next place otherwise', async () => {
  const f = await fixture();
  const date = tomorrow();
  const placesAre = (places: readonly { kind: string; value: string }[]) =>
    database.withTenant(f.business.context, (sql) =>
      sql.query('update calendar.calendar_members set locations = $1::jsonb', [
        JSON.stringify(places.map((place) => ({ ...place, label: null }))),
      ]),
    );
  const placeAt = async (time: string) => {
    await handlers().book(f.params, booking(date, time), request());
    return (
      await database.withTenant(f.business.context, (sql) =>
        sql.one<{ location: string | null }>(
          'select location from calendar.appointments where starts_at = $1',
          [`${date}T${time}:00Z`],
        ),
      )
    ).location;
  };
  await placesAre([
    { kind: 'google_meet', value: 'Google Meet' },
    { kind: 'address', value: 'Harbor office' },
  ]);
  // Never connected: no Meet can be made, so the booker is told the next place.
  expect(await placeAt('10:00')).toBe('Harbor office');

  // Connected with a linked calendar: the Meet, and its link once Google made it.
  const { primary } = await connect(f);
  expect(await placeAt('11:00')).toBe('Google Meet');
  await work();
  const located = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ starts_at: Date; location: string | null }>(
      'select starts_at, location from calendar.appointments order by starts_at',
    ),
  );
  expect(located[0]?.location).toBe('Harbor office');
  expect(located[1]?.location).toMatch(/^https:\/\/meet\.google\.com\//);
  // The one booked before keeps the place its booker was told: no Meet is asked for it.
  const events = fake
    .events(primary)
    .sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
  expect(events.map((event) => [event.location, event.conference === undefined])).toEqual([
    ['Harbor office', true],
    ['Google Meet', false],
  ]);

  // Disconnected: the next place again, and none when the Meet was the only one.
  await route('disconnectGoogle', person(f));
  expect(await placeAt('12:00')).toBe('Harbor office');
  await placesAre([{ kind: 'google_meet', value: 'Google Meet' }]);
  expect(await placeAt('13:00')).toBeNull();
});

it('disconnects a connection Google no longer accepts, tells the member, and books from the CRM alone', async () => {
  const f = await fixture();
  const date = tomorrow();
  const { sub, primary } = await connect(f);
  fake.setBusy(primary, [{ start: `${date}T10:00:00Z`, end: `${date}T12:00:00Z` }]);
  await refreshNow(f);
  expect(await slotsOn(f, date)).toHaveLength(12);
  fake.revokeAccount(sub);
  await refreshNow(f);
  const connection = await connectionOf(f);
  expect(connection).toMatchObject({
    status: 'disconnected',
    disconnected_reason: 'expired_or_revoked',
    secret_id: null,
  });
  expect(told.filter((each) => each.connectionId === connection.id)).toHaveLength(1);
  expect(await slotsOn(f, date)).toHaveLength(16);
  const view = (await route('getGoogleConnections', person(f))) as {
    mine: { status: string; disconnectedReason: string };
  };
  expect(view.mine).toMatchObject({
    status: 'disconnected',
    disconnectedReason: 'expired_or_revoked',
  });
  // Reconnecting the same account works again.
  await connect(f, sub);
  expect((await connectionOf(f)).status).toBe('connected');
});

it('stops when the member leaves the business, and revokes the access', async () => {
  const f = await fixture();
  await connect(f);
  const revokedBefore = fake.revoked.length;
  await database.as('crm_owner', (sql) =>
    sql.query('delete from tenancy.memberships where user_id = $1 and business_id = $2', [
      f.user.id,
      f.business.id,
    ]),
  );
  await refreshNow(f);
  expect(await connectionOf(f)).toMatchObject({
    status: 'disconnected',
    disconnected_reason: 'membership_ended',
    secret_id: null,
  });
  expect(fake.revoked.length).toBe(revokedBefore + 1);
});

it('revokes on disconnect, unless another business still uses the same Google account', async () => {
  const one = await fixture();
  const two = await fixture('Second', { user: one.user });
  const { sub } = await connect(one);
  await connect(two, sub);
  const revokedBefore = fake.revoked.length;
  await route('disconnectGoogle', person(one));
  await work();
  expect(await connectionOf(one)).toMatchObject({ status: 'disconnected', secret_id: null });
  // The other business's connection still works: its grant was not revoked under it.
  expect(fake.revoked.length).toBe(revokedBefore);
  await refreshNow(two);
  expect((await connectionOf(two)).status).toBe('connected');
  await route('disconnectGoogle', person(two));
  await work();
  expect(fake.revoked.length).toBe(revokedBefore + 1);
});

it('chooses calendars the member has, links only one they can write to, and is the person’s own', async () => {
  const f = await fixture();
  const { primary, sub } = await connect(f);
  await expect(
    route('chooseGoogleCalendars', person(f), {
      linkedCalendarId: `holidays-${sub}`,
      conflictCalendarIds: [],
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    route('chooseGoogleCalendars', person(f), {
      linkedCalendarId: primary,
      conflictCalendarIds: ['someone-else@example.test'],
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  const chosen = (await route('chooseGoogleCalendars', person(f), {
    linkedCalendarId: `team-${sub}`,
    conflictCalendarIds: [primary, `holidays-${sub}`],
  })) as { linkedCalendarId: string; calendars: { id: string; checkConflicts: boolean }[] };
  expect(chosen.linkedCalendarId).toBe(`team-${sub}`);
  expect(chosen.calendars.filter((each) => each.checkConflicts).map((each) => each.id)).toEqual([
    primary,
    `holidays-${sub}`,
  ]);
  // Without the permission, or not as a person, nothing changes.
  await expect(route('connectGoogle', person(f, new Set()))).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    route('disconnectGoogle', {
      ...person(f),
      context: {
        agencyId: f.business.agencyId,
        businessId: f.business.id,
        actorKind: 'api_key',
        actorId: randomUUID(),
        correlationId: randomUUID(),
      },
    }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  // Someone without a connection has nothing to change.
  const other = await fixture('Other');
  await expect(route('refreshGoogleCalendars', person(other))).rejects.toBeInstanceOf(
    NotFoundError,
  );
});

it('keeps each business’s connections to itself', async () => {
  const one = await fixture();
  await connect(one);
  const two = await fixture('Elsewhere');
  const view = (await route('getGoogleConnections', person(two))) as {
    mine: unknown;
    team: unknown[];
  };
  expect(view).toMatchObject({ mine: null, team: [] });
  const seen = await database.withTenant(two.business.context, (sql) =>
    sql.query('select id from calendar.google_connections'),
  );
  expect(seen).toEqual([]);
  // Without the Google settings, only the read is served, and it says so.
  const hidden = createGoogleCalendarRoutes({ ...options, google: undefined });
  expect(hidden.map((each) => each.endpoint.operationId)).toEqual(['getGoogleConnections']);
  const said = (await hidden[0]?.run(
    { invocation: person(one), params: {}, query: {}, body: undefined },
    services,
  )) as { available: boolean };
  expect(said.available).toBe(false);
});

it('says when Google is not answering, and tries again with a fresh token after a 401', async () => {
  const f = await fixture();
  const date = tomorrow();
  const { primary } = await connect(f);
  fake.failNext('POST', /\/freeBusy$/, 503);
  await refreshNow(f);
  const failing = (await route('getGoogleConnections', person(f))) as {
    mine: { busyFailing: boolean };
    team: { busyFailing: boolean }[];
  };
  expect(failing.mine.busyFailing).toBe(true);
  expect(failing.team[0]?.busyFailing).toBe(true);
  // An access token Google stops taking early is refreshed once, and the reading goes on.
  fake.setBusy(primary, [{ start: `${date}T15:00:00Z`, end: `${date}T16:00:00Z` }]);
  fake.failNext('POST', /\/freeBusy$/, 401);
  await refreshNow(f);
  const answering = (await route('getGoogleConnections', person(f))) as {
    mine: { busyFailing: boolean };
  };
  expect(answering.mine.busyFailing).toBe(false);
  expect(await slotsOn(f, date)).not.toContain('15:00');
  // The calendar list Google can't give now is tried again later, the old one kept.
  fake.failNext('GET', /\/calendarList$/, 500);
  await route('refreshGoogleCalendars', person(f));
  await work();
  const kept = (await route('getGoogleConnections', person(f))) as {
    mine: { calendars: unknown[]; busyFailing: boolean };
  };
  expect(kept.mine.calendars).toHaveLength(3);
  expect(kept.mine.busyFailing).toBe(true);
});

it('follows the member’s calendar list: a linked calendar that went links nothing, and another account starts over', async () => {
  const f = await fixture();
  const { sub, primary } = await connect(f);
  await route('chooseGoogleCalendars', person(f), {
    linkedCalendarId: `team-${sub}`,
    conflictCalendarIds: [],
  });
  await work();
  fake.addAccount({
    sub,
    email: primary,
    calendars: [{ id: primary, summary: primary, primary: true, accessRole: 'owner' }],
  });
  await route('refreshGoogleCalendars', person(f));
  await work();
  expect((await connectionOf(f)).write_calendar_id).toBeNull();
  // Connected again with another account: its own calendars, chosen afresh.
  const other = await connect(f);
  expect((await connectionOf(f)).write_calendar_id).toBe(other.primary);
  const view = (await route('getGoogleConnections', person(f))) as {
    mine: { email: string; calendars: { id: string }[] };
  };
  expect(view.mine.email).toBe(other.primary);
  expect(view.mine.calendars.map((each) => each.id)).not.toContain(primary);
});

it('disconnects a connection whose sealed token can no longer be opened', async () => {
  const f = await fixture();
  await connect(f);
  const { secret_id } = await connectionOf(f);
  await database.as('crm_owner', (sql) =>
    sql.query(
      "update vault.secrets set ciphertext = decode(repeat('00', 64), 'hex') where id = $1",
      [secret_id],
    ),
  );
  await refreshNow(f);
  expect(await connectionOf(f)).toMatchObject({
    status: 'disconnected',
    disconnected_reason: 'expired_or_revoked',
  });
});

it('answers a fresh look as failed when the connection went, and retries a revocation Google missed', async () => {
  const f = await fixture();
  const date = tomorrow();
  await connect(f);
  const context = { ...f.business.context, correlationId: randomUUID() };
  const range = { from: new Date(`${date}T00:00:00Z`), to: new Date(`${date}T23:00:00Z`) };
  // Nobody answers in time: the booking goes on with what is known.
  expect(await freshenGoogleBusy(db, context, await calendarIdOf(f), range, 150)).toBe('timed_out');
  await route('disconnectGoogle', person(f));
  fake.failNext('POST', /^\/revoke$/, 503);
  await expect(work()).rejects.toThrow(/revocation/);
  // Graphile tries the revocation again later; here it is run again by hand.
  const revoke = worker.tasks.find((task) => task.name === 'calendar.google.revoke');
  await revoke?.run(
    { connectionId: (await connectionOf(f)).id },
    { invocation: { context, permissions: 'all' }, services },
  );
  // The check queued before the disconnection finds nothing to read.
  await work();
  const outcomes = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ outcome: string }>('select outcome from calendar.google_busy_checks'),
  );
  expect(outcomes.map((each) => each.outcome)).toEqual(['failed']);
  expect(await connectionOf(f)).toMatchObject({ status: 'disconnected', secret_id: null });
  expect(await freshenGoogleBusy(db, context, await calendarIdOf(f), range, 150)).toBe(
    'not_needed',
  );
});

it('writes a new event when one was deleted in Google, and gives up on one Google refuses', async () => {
  const f = await fixture();
  const date = tomorrow();
  const { primary } = await connect(f);
  await handlers().book(f.params, booking(date, '14:00'), request());
  await work();
  const appointment = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>('select id from calendar.appointments'),
  );
  // Someone deletes it in Google; the next change writes it again, under the next id.
  const [first] = fake.events(primary);
  if (first !== undefined) first.status = 'cancelled';
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update calendar.appointments set title = 'Venue tour, again'"),
  );
  await work();
  expect(fake.events(primary).map((each) => [each.id.slice(-2), each.status])).toEqual([
    ['g1', 'cancelled'],
    ['g2', 'confirmed'],
  ]);
  // A refusal of the event itself is kept, not retried.
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update calendar.appointments set title = 'Refused'"),
  );
  fake.failNext('PATCH', /\/events\//, 403, {
    error: { errors: [{ domain: 'calendar', reason: 'forbiddenForNonOrganizer' }], code: 403 },
  });
  await work();
  const sync = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ rejected_at: Date | null }>(
      'select rejected_at from calendar.google_event_syncs where appointment_id = $1',
      [appointment.id],
    ),
  );
  expect(sync.rejected_at).not.toBeNull();
});

it('answers what each reader may see, and refuses callbacks it cannot place', async () => {
  const f = await fixture();
  await connect(f);
  // Someone who books appointments reads the team too: they book for colleagues.
  const booker = (await route(
    'getGoogleConnections',
    person(f, new Set(['appointments.manage'])),
  )) as { mine: unknown; team: unknown[] };
  expect(booker.mine).not.toBeNull();
  expect(booker.team).toHaveLength(1);
  // Without calendars.manage or appointments.manage: one's own connection, no team.
  const own = (await route('getGoogleConnections', person(f, new Set(['contacts.manage'])))) as {
    mine: unknown;
    team: unknown;
  };
  expect(own.mine).not.toBeNull();
  expect(own.team).toBeNull();
  // A program reads the team, and has no connection of its own.
  const program = (await route('getGoogleConnections', {
    context: {
      agencyId: f.business.agencyId,
      businessId: f.business.id,
      actorKind: 'api_key',
      actorId: randomUUID(),
      correlationId: randomUUID(),
    },
    permissions: grants,
  })) as { mine: unknown; team: unknown[] };
  expect(program.mine).toBeNull();
  expect(program.team).toHaveLength(1);
  // Someone who left is not listed for the team.
  await database.as('crm_owner', (sql) =>
    sql.query('delete from tenancy.memberships where user_id = $1 and business_id = $2', [
      f.user.id,
      f.business.id,
    ]),
  );
  expect(((await route('getGoogleConnections', person(f))) as { team: unknown[] }).team).toEqual(
    [],
  );

  const callback = (state: string | undefined) => ({ state, code: 'c', error: undefined });
  const somebody = { userId: f.user.id, grantsIn: () => Promise.resolve(grants) };
  expect(
    (
      await completeGoogleConnect(
        { ...options, google: undefined },
        services,
        callback('s'),
        somebody,
        randomUUID(),
      )
    ).outcome,
  ).toBe('failed');
  expect(
    (await completeGoogleConnect(options, services, callback(undefined), somebody, randomUUID()))
      .outcome,
  ).toBe('expired');
  expect(
    (
      await completeGoogleConnect(
        options,
        services,
        callback('x'.repeat(201)),
        somebody,
        randomUUID(),
      )
    ).outcome,
  ).toBe('expired');
  // An attempt of a business the person is no longer in is refused, and the jobs of a
  // connection that went find nothing to do.
  const g = await fixture();
  const url = new URL(
    ((await route('connectGoogle', person(g))) as { authorizationUrl: string }).authorizationUrl,
  );
  expect(
    (
      await completeGoogleConnect(
        options,
        services,
        callback(url.searchParams.get('state') ?? ''),
        { userId: g.user.id, grantsIn: () => Promise.resolve(undefined) },
        randomUUID(),
      )
    ).outcome,
  ).toBe('failed');
  const context = { ...g.business.context, correlationId: randomUUID() };
  const job = { invocation: { context, permissions: 'all' as const }, services };
  for (const task of worker.tasks)
    await task.run(
      task.name === 'calendar.google.sync_appointment'
        ? { appointmentId: randomUUID() }
        : task.name === 'calendar.google.check_busy'
          ? { checkId: randomUUID() }
          : { connectionId: randomUUID(), readCalendars: false },
      job,
    );
});

it('removes the event of an appointment nobody holds now, and links nothing when asked', async () => {
  const f = await fixture();
  const date = tomorrow();
  const { primary } = await connect(f);
  await handlers().book(f.params, booking(date, '15:00'), request());
  await work();
  expect(fake.events(primary).map((each) => each.status)).toEqual(['confirmed']);
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update calendar.appointments set assigned_user_id = null'),
  );
  // Google fails the deletion once: the job fails, to be tried again.
  fake.failNext('DELETE', /\/events\//, 503);
  await expect(work()).rejects.toThrow(/deletion/);
  const { id } = await database.withTenant(f.business.context, (sql) =>
    sql.one<{ id: string }>('select id from calendar.appointments'),
  );
  await worker.syncAppointment(id, f.business.context, services);
  expect(fake.events(primary).map((each) => each.status)).toEqual(['cancelled']);
  const view = (await route('chooseGoogleCalendars', person(f), {
    linkedCalendarId: null,
    conflictCalendarIds: [],
  })) as { linkedCalendarId: string | null; calendars: { checkConflicts: boolean }[] };
  expect(view.linkedCalendarId).toBeNull();
  expect(view.calendars.some((each) => each.checkConflicts)).toBe(false);
  // An install without a vault connects nobody, whatever reaches the commands.
  await expect(
    runCommand(services, connectGoogleCommand({ ...options, vault: undefined }), {}, person(f)),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    runCommand(
      services,
      completeGoogleConnectCommand({ ...options, vault: undefined }),
      { attemptId: randomUUID(), sub: 's', email: 'a@example.test', refreshToken: 'r' },
      person(f),
    ),
  ).rejects.toBeInstanceOf(ValidationError);
});
