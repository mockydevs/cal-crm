// Production start and unsigned HTTP exercise the actual public factory and shared PG
// limiter. A queued confirmation is inspected in storage; no provider is called.
import { randomUUID } from 'node:crypto';
import { allowEveryone } from '@repo/commands';
import {
  BOOKING_NOTIFICATION_WORDING,
  botChallenge,
  calendarConfiguration,
  publicAppointmentPage,
  publicAppointmentReceipt,
  publicBookingReceipt,
  publicCalendarPage,
  publicSlots,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { toAltchaChallenge } from '@repo/module-forms';
import {
  createSealingVault,
  newSecretsKey,
  parseSecretsPublicKey,
  type SealingVault,
} from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { afterAll, afterEach, beforeAll, expect, inject, it } from 'vitest';
import { apiRoutes } from './api-routes.js';
import type { Config } from './config.js';
import { start, type Running } from './start.js';

let database: TestDatabase;
let db: Database;
let vault: SealingVault;
const running: Running[] = [];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  vault = await createSealingVault(parseSecretsPublicKey((await newSecretsKey(1)).publicKey));
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.stop()));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

/** With `address`, the server trusts the loopback proxy and every request comes from it. */
async function fixture(address?: string) {
  const agencySlug = `http-${randomUUID().slice(0, 8)}`;
  const agency = await database.fixtures.agency({ slug: agencySlug });
  const business = await database.fixtures.business(agency.id, { slug: 'events' });
  const user = await database.fixtures.user();
  const membership = await database.withTenant(business.context, (sql) =>
    sql.one<{ id: string }>(
      "with role as (insert into tenancy.roles(agency_id,scope,key,name) values(app.agency_id(),'business','host','Host') returning id) insert into tenancy.memberships(agency_id,business_id,user_id,role_id) select app.agency_id(),app.business_id(),$1,id from role returning id",
      [user.id],
    ),
  );
  const secretId = await withTenant(db, business.context, (trx) =>
    vault.store(
      trx,
      { agencyId: agency.id, businessId: business.id, purpose: 'mailbox.credentials' },
      'sealed fixture; never dispatched',
    ),
  );
  const account = await database.withTenant(business.context, async (sql) => {
    await sql.query(
      'insert into messaging.settings(business_id,quiet_hours_enabled) values(app.business_id(),false)',
    );
    const account = await sql.one<{ id: string }>(
      "insert into messaging.channel_accounts(business_id,channel,name) values(app.business_id(),'email','Bookings') returning id",
    );
    await sql.query(
      `insert into messaging.mailboxes(business_id,id,email_address,auth_method,smtp_host,smtp_port,smtp_security,smtp_username,secret_id,use_for_conversations)
      values(app.business_id(),$1,'bookings@example.test','password','localhost',1025,'none','fixture',$2,true)`,
      [account.id, secretId],
    );
    return account;
  });
  const route = apiRoutes().find((route) => route.endpoint.operationId === 'createCalendar');
  if (route === undefined) throw new Error('Missing calendar create route.');
  calendarConfiguration.parse(
    await route.run(
      {
        invocation: {
          context: { ...business.context, correlationId: randomUUID() },
          permissions: 'all',
        },
        params: {},
        query: {},
        body: {
          name: 'Venue tour',
          kind: 'personal',
          timezone: 'UTC',
          bookingSlug: 'venue-tour',
          confirmationSenderId: toPublicId('mailbox', account.id),
          isActive: true,
          minNoticeMinutes: 0,
          members: [{ membershipId: toPublicId('membership', membership.id), weight: 1 }],
          weeklyHours: Array.from({ length: 7 }, (_, weekday) => ({
            weekday,
            startTime: '09:00',
            endTime: '17:00',
          })),
          dateOverrides: [],
        },
      },
      { db, authorize: allowEveryone },
    ),
  );
  const config: Config = {
    nodeEnv: 'test',
    role: 'app',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: undefined,
    databasePoolSize: 4,
    shutdownTimeoutMs: 2000,
    dashboardDir: undefined,
    devTenantContext: undefined,
    publicUrl: 'https://crm.example.test',
    publicIntake: { secret: 'public-http-fixture-key-with-at-least-32-bytes' },
    authentication: undefined,
    mail: undefined,
    trustProxy: address === undefined ? [] : ['loopback'],
    files: undefined,
    vault: undefined,
  };
  const app = await start(config, apiRoutes, []);
  running.push(app);
  const request = async (path: string, payload?: object, status = 200): Promise<unknown> => {
    const from = address === undefined ? {} : { 'x-forwarded-for': address };
    const response = await fetch(`${app.address}/api/v1${path}`, {
      ...(payload === undefined
        ? { headers: from }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...from },
            body: JSON.stringify(payload),
          }),
    });
    const body: unknown = await response.json();
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    return body;
  };
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const path = `/public/book/${agencySlug}/events/venue-tour`;
  // As a visitor does: the page is loaded, which gives its proof, and a person takes a
  // moment before booking. Each proof is good for one booking.
  const shown = async (): Promise<string> => {
    const page = publicCalendarPage.parse(await request(path));
    await new Promise((resolve) => setTimeout(resolve, 2100));
    return page.renderToken;
  };
  const input = {
    bookingRequestId: randomUUID(),
    startsAt: `${date}T10:00:00Z`,
    contact: { firstName: 'Maya', email: 'maya@example.test' },
    notificationConsent: true,
    contactTimezone: 'UTC',
    renderToken: await shown(),
  };
  return {
    business,
    request,
    shown,
    input,
    date,
    address: app.address,
    path,
  };
}

it('books, replays, reads, reschedules and cancels through all seven unsigned HTTP operations', async () => {
  const f = await fixture();
  expect(publicCalendarPage.parse(await f.request(f.path))).toMatchObject({
    name: 'Venue tour',
    notificationWording: BOOKING_NOTIFICATION_WORDING,
  });
  const slots = publicSlots.parse(await f.request(`${f.path}/slots?date=${f.date}`));
  expect(
    slots.slots.some((slot) => new Date(slot.startsAt).toISOString() === `${f.date}T10:00:00.000Z`),
  ).toBe(true);
  const receipt = publicBookingReceipt.parse(await f.request(`${f.path}/appointments`, f.input));
  expect(receipt.status).toBe('booked');
  if (receipt.managementUrl === undefined) throw new Error('Missing first booking capability.');
  const token = new URL(receipt.managementUrl).pathname.split('/').at(-1);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const managedPath = `/public/appointments/${token ?? ''}`;
  const replay = publicBookingReceipt.parse(await f.request(`${f.path}/appointments`, f.input));
  expect(replay).toEqual({
    status: receipt.status,
    startsAt: receipt.startsAt,
    endsAt: receipt.endsAt,
  });
  const current = publicAppointmentPage.parse(await f.request(managedPath));
  const available = publicSlots.parse(await f.request(`${managedPath}/slots?date=${f.date}`));
  expect(
    available.slots.some((slot) => new Date(slot.startsAt).toISOString() === receipt.startsAt),
  ).toBe(true);
  const move = {
    operationRequestId: randomUUID(),
    revision: current.revision,
    startsAt: `${f.date}T11:00:00Z`,
  };
  const moved = publicAppointmentReceipt.parse(await f.request(`${managedPath}/reschedule`, move));
  expect(moved.startsAt).toBe(`${f.date}T11:00:00.000Z`);
  expect(await f.request(`${managedPath}/reschedule`, move)).toEqual(moved);
  const updated = publicAppointmentPage.parse(await f.request(managedPath));
  const cancellation = { operationRequestId: randomUUID(), revision: updated.revision };
  expect(
    publicAppointmentReceipt.parse(await f.request(`${managedPath}/cancel`, cancellation)).status,
  ).toBe('cancelled');
  expect(publicAppointmentPage.parse(await f.request(managedPath)).status).toBe('cancelled');
  const messages = await database.withTenant(f.business.context, (sql) =>
    sql.query<{ status: string }>('select status from messaging.messages'),
  );
  expect(messages).toHaveLength(3);
  expect(messages.every((message) => message.status === 'queued')).toBe(true);
});

it('draws the calendar’s look, and shows a picture only by its public Media Storage address', async () => {
  const f = await fixture();
  // The defaults of a new calendar, and no pictures.
  expect(publicCalendarPage.parse(await f.request(f.path)).appearance).toEqual({
    style: 'neo',
    primaryColor: '#178af6',
    backgroundColor: '#ffffff',
    buttonText: '',
    logoUrl: null,
    coverUrl: null,
  });
  const key = 'AbCdEfGhIjKlMnOpQrStUv';
  const image = (filename: string, publicKey: string | null) =>
    database.withTenant(f.business.context, (sql) =>
      sql.one<{ id: string }>(
        `insert into files.files
           (agency_id, business_id, storage, storage_key, filename, content_type, size_bytes,
            sha256, uploaded_by_kind, library, public_key)
         values (app.agency_id(), app.business_id(), 'local', $1::text, $2, 'image/png', 1024,
                 sha256($1::text::bytea), 'system', true, $3)
         returning id`,
        [randomUUID(), filename, publicKey],
      ),
    );
  const logo = await image('our logo.png', key);
  const cover = await image('cover.png', null);
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      `update calendar.calendars set logo_file_id = $1, cover_file_id = $2, widget_style = 'classic',
         primary_color = '#0a7d33', background_color = '#10182880', button_text = 'Book my tour'
       where booking_slug = 'venue-tour'`,
      [logo.id, cover.id],
    ),
  );
  const raw = await f.request(f.path);
  expect(publicCalendarPage.parse(raw).appearance).toEqual({
    style: 'classic',
    primaryColor: '#0a7d33',
    backgroundColor: '#10182880',
    buttonText: 'Book my tour',
    // The private cover is not shown, and neither file's id is named anywhere.
    logoUrl: `https://crm.example.test/m/${key}/our%20logo.png`,
    coverUrl: null,
  });
  expect(JSON.stringify(raw)).not.toContain(toPublicId('file', cover.id));
  expect(JSON.stringify(raw)).not.toContain(toPublicId('file', logo.id));
  // Made private again, the logo goes from the page too.
  await database.withTenant(f.business.context, (sql) =>
    sql.query('update files.files set public_key = null where id = $1', [logo.id]),
  );
  expect(publicCalendarPage.parse(await f.request(f.path)).appearance.logoUrl).toBeNull();
});

it('gives two people posting for the same slot at once one booking and one "taken", and a cancellation puts the slot back', async () => {
  const f = await fixture();
  const post = async (payload: object) => {
    const response = await fetch(`${f.address}/api/v1${f.path}/appointments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };
  const people = await Promise.all(
    ['first@example.test', 'second@example.test'].map(async (email) => ({
      ...f.input,
      bookingRequestId: randomUUID(),
      contact: { email },
      renderToken: await f.shown(),
    })),
  );
  // Both requests are in flight together; whichever the database serves second loses.
  const answers = await Promise.all(people.map((person) => post(person)));
  expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
  const lost = answers.find((answer) => answer.status === 409);
  expect(lost?.body).toEqual({
    type: 'about:blank',
    title: 'Conflict',
    status: 409,
    detail: 'That slot is taken, or the appointment has changed. Reload and try again.',
  });
  const won = publicBookingReceipt.parse(answers.find((answer) => answer.status === 200)?.body);
  const stored = () =>
    database.withTenant(f.business.context, async (sql) => ({
      appointments: await sql.query<{ status: string }>(
        'select status from calendar.appointments order by created_at',
      ),
      contacts: (await sql.query('select id from crm.contacts')).length,
    }));
  // The loser left nothing behind: no appointment, and no contact of its own.
  expect(await stored()).toEqual({ appointments: [{ status: 'booked' }], contacts: 1 });
  const offered = async () =>
    publicSlots
      .parse(await f.request(`${f.path}/slots?date=${f.date}`))
      .slots.map((slot) => new Date(slot.startsAt).toISOString());
  expect(await offered()).not.toContain(won.startsAt);

  // The winner cancels with the link from their receipt: the slot is offered again.
  if (won.managementUrl === undefined) throw new Error('Missing first booking capability.');
  const managedPath = `/public/appointments/${new URL(won.managementUrl).pathname.split('/').at(-1) ?? ''}`;
  const page = publicAppointmentPage.parse(await f.request(managedPath));
  expect(
    publicAppointmentReceipt.parse(
      await f.request(`${managedPath}/cancel`, {
        operationRequestId: randomUUID(),
        revision: page.revision,
      }),
    ).status,
  ).toBe('cancelled');
  expect(await offered()).toContain(won.startsAt);
  // And the person who lost can now have it.
  const loser = people[answers.findIndex((answer) => answer.status === 409)];
  if (loser === undefined) throw new Error('Nobody lost the race.');
  expect(
    publicBookingReceipt.parse(await f.request(`${f.path}/appointments`, loser)),
  ).toMatchObject({ status: 'booked', startsAt: won.startsAt });
  expect(await stored()).toEqual({
    appointments: [{ status: 'cancelled' }, { status: 'booked' }],
    contacts: 2,
  });
});

it('rolls back the whole booking when the canonical confirmation queue refuses its address', async () => {
  const f = await fixture();
  await database.withTenant(f.business.context, (sql) =>
    sql.query(
      "insert into messaging.suppressions(business_id,channel,address_normalized,reason) values(app.business_id(),'email','maya@example.test','hard_bounce')",
    ),
  );
  expect(await f.request(`${f.path}/appointments`, f.input, 409)).toMatchObject({ status: 409 });
  await database.withTenant(f.business.context, async (sql) => {
    for (const table of [
      'calendar.appointments',
      'crm.contacts',
      'messaging.consents',
      'messaging.messages',
    ]) {
      expect(await sql.query<{ n: number }>(`select count(*)::integer as n from ${table}`)).toEqual(
        [{ n: 0 }],
      );
    }
  });
});

it('takes a booking on a protected calendar only with a real ALTCHA proof for that showing', async () => {
  // An address of its own: the limiter allows each address ten writes a minute.
  const f = await fixture('198.51.100.77');
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update calendar.calendars set bot_protection = 'altcha'"),
  );
  const page = publicCalendarPage.parse(await f.request(f.path));
  expect(page.botProtection).toBe('altcha');
  const view = botChallenge.parse(
    await f.request(`${f.path}/challenge`, { renderToken: page.renderToken }),
  );
  // The server's own policy, solved as a browser solves it (the same library's solver).
  expect(view.challenge.parameters).toMatchObject({ algorithm: 'PBKDF2/SHA-256', cost: 1000 });
  const solution = await solveChallenge({
    challenge: toAltchaChallenge(view.challenge),
    deriveKey,
  });
  if (solution === null) throw new Error('Expected a solution.');
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const booking = { ...f.input, bookingRequestId: randomUUID(), renderToken: page.renderToken };
  // Without the proof: shown again.
  await f.request(`${f.path}/appointments`, booking, 409);
  const receipt = publicBookingReceipt.parse(
    await f.request(`${f.path}/appointments`, {
      ...booking,
      bookingRequestId: randomUUID(),
      botProof: { kind: 'altcha', challenge: view.challenge, solution },
    }),
  );
  expect(receipt.status).toBe('booked');
  // A challenge for a token of no showing is refused, and so is the solved one used again.
  await f.request(`${f.path}/challenge`, { renderToken: `1793000000000.${'A'.repeat(43)}` }, 409);
  await f.request(
    `${f.path}/appointments`,
    {
      ...booking,
      bookingRequestId: randomUUID(),
      startsAt: `${f.date}T11:00:00Z`,
      botProof: { kind: 'altcha', challenge: view.challenge, solution },
    },
    409,
  );
  // A calendar without protection gives no challenge.
  await database.withTenant(f.business.context, (sql) =>
    sql.query("update calendar.calendars set bot_protection = 'off'"),
  );
  await f.request(`${f.path}/challenge`, { renderToken: page.renderToken }, 404);
});
