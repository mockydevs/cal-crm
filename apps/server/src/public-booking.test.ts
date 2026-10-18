import { Writable } from 'node:stream';
import { allowEveryone } from '@repo/commands';
import { BOOKING_NOTIFICATION_WORDING, publicBookingEndpoints } from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import { ConflictError, NotFoundError } from '@repo/kernel';
import { BookingTooSoonError, type PublicBookingHandlers } from '@repo/module-calendar';
import { pino } from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { createIntakeGate } from './intake-gate.js';
import { loggerOptions } from './logger.js';
import type { PublicBookingRateLimit, PublicBookingTransport } from './public-booking.js';
import { createIntakeScopes } from './public-intake-limit.js';
import { buildServer, type Server } from './server.js';

const token = Buffer.alloc(32, 11).toString('base64url');
const calendarPath = '/api/v1/public/book/agency/business/calendar';
const appointmentPath = `/api/v1/public/appointments/${token}`;
const calendar: Awaited<ReturnType<PublicBookingHandlers['calendar']>> = {
  notificationWording: BOOKING_NOTIFICATION_WORDING,
  appearance: {
    style: 'neo',
    primaryColor: '#178af6',
    backgroundColor: '#ffffff',
    buttonText: '',
    logoUrl: null,
    coverUrl: null,
  },
  name: 'Consultation',
  description: 'Meet the team.',
  timezone: 'Africa/Nairobi',
  slotMinutes: 30,
  durations: [30],
  renderToken: `1793000000000.${'A'.repeat(43)}`,
};
const challenge: Awaited<ReturnType<PublicBookingHandlers['challenge']>> = {
  kind: 'altcha',
  challenge: {
    parameters: {
      algorithm: 'PBKDF2/SHA-256',
      nonce: 'ab'.repeat(16),
      salt: 'cd'.repeat(16),
      cost: 1000,
      keyLength: 32,
      keyPrefix: 'ef'.repeat(16),
      keySignature: '01'.repeat(32),
      expiresAt: 1_793_003_600,
      data: { render: 'A'.repeat(43) },
    },
    signature: '02'.repeat(32),
  },
};
const receipt = {
  status: 'booked' as const,
  startsAt: '2026-10-10T09:00:00.000Z',
  endsAt: '2026-10-10T09:30:00.000Z',
};
const operation = {
  operationRequestId: 'ad84e888-4fe9-4d53-8c45-91ef2a586685',
  revision: 'a'.repeat(64),
};
const booking = {
  notificationConsent: true as const,
  contactTimezone: 'Africa/Nairobi',
  bookingRequestId: 'ad84e888-4fe9-4d53-8c45-91ef2a586686',
  startsAt: receipt.startsAt,
  contact: { email: 'test@example.test' },
  renderToken: calendar.renderToken,
};
const config: Config = {
  nodeEnv: 'test',
  role: 'app',
  host: '127.0.0.1',
  port: 0,
  logLevel: 'info',
  databaseAppUrl: 'postgres://crm_app@127.0.0.1:1/crm',
  databaseWorkerUrl: undefined,
  databasePoolSize: 1,
  shutdownTimeoutMs: 1000,
  dashboardDir: undefined,
  devTenantContext: undefined,
  publicUrl: 'https://crm.example.test',
  authentication: undefined,
  mail: undefined,
  trustProxy: [],
  files: undefined,
  vault: undefined,
};
const servers: Server[] = [];
const databases: ReturnType<typeof connectDatabase>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

async function start(over: Partial<PublicBookingTransport> = {}) {
  const handlers: PublicBookingHandlers = {
    calendar: vi.fn<PublicBookingHandlers['calendar']>().mockResolvedValue(calendar),
    slots: vi
      .fn<PublicBookingHandlers['slots']>()
      .mockResolvedValue({ slots: [{ startsAt: receipt.startsAt, endsAt: receipt.endsAt }] }),
    book: vi.fn<PublicBookingHandlers['book']>().mockResolvedValue({
      ...receipt,
      managementUrl: `https://crm.example.test/book/appointments/${token}`,
    }),
    appointment: vi.fn<PublicBookingHandlers['appointment']>().mockResolvedValue({
      ...receipt,
      calendarName: calendar.name,
      timezone: calendar.timezone,
      revision: operation.revision,
    }),
    cancel: vi
      .fn<PublicBookingHandlers['cancel']>()
      .mockResolvedValue({ ...receipt, status: 'cancelled' as const }),
    reschedule: vi.fn<PublicBookingHandlers['reschedule']>().mockResolvedValue(receipt),
    appointmentSlots: vi
      .fn<PublicBookingHandlers['appointmentSlots']>()
      .mockResolvedValue({ slots: [{ startsAt: receipt.startsAt, endsAt: receipt.endsAt }] }),
    challenge: vi.fn<PublicBookingHandlers['challenge']>().mockResolvedValue(challenge),
  };
  const rateLimit = vi.fn<PublicBookingRateLimit>().mockResolvedValue({ allowed: true });
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logs.push(chunk.toString());
      done();
    },
  });
  const db = connectDatabase({
    connectionString: config.databaseAppUrl,
    onConnectionError: () => undefined,
  });
  databases.push(db);
  const server = await buildServer({
    config,
    logger: pino(loggerOptions(config), stream),
    serveApi: true,
    routes: [],
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
    publicBooking: { handlers, rateLimit, ...over },
  });
  servers.push(server);
  return { app: server.app, handlers, rateLimit, logs };
}

it('serves all eight strict public operations without a session, and keeps protected API authentication', async () => {
  const { app, handlers } = await start();
  const requests = [
    { method: 'GET' as const, url: calendarPath },
    { method: 'GET' as const, url: `${calendarPath}/slots?date=2026-10-10` },
    { method: 'POST' as const, url: `${calendarPath}/appointments`, payload: booking },
    { method: 'GET' as const, url: appointmentPath },
    { method: 'POST' as const, url: `${appointmentPath}/cancel`, payload: operation },
    {
      method: 'POST' as const,
      url: `${appointmentPath}/reschedule`,
      payload: { ...operation, startsAt: receipt.startsAt },
    },
    { method: 'GET' as const, url: `${appointmentPath}/slots?date=2026-10-10` },
    {
      method: 'POST' as const,
      url: `${calendarPath}/challenge`,
      payload: { renderToken: calendar.renderToken },
    },
  ];
  for (const [index, request] of requests.entries()) {
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(publicBookingEndpoints[index]?.response.schema.safeParse(response.json()).success).toBe(
      true,
    );
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  }
  expect(handlers.book).toHaveBeenCalledOnce();
  expect(vi.mocked(handlers.challenge).mock.calls[0]?.slice(0, 2)).toEqual([
    { agencySlug: 'agency', businessSlug: 'business', calendarSlug: 'calendar' },
    { renderToken: calendar.renderToken },
  ]);
  expect(handlers.appointmentSlots).toHaveBeenCalledOnce();
  const slotsCall = vi.mocked(handlers.appointmentSlots).mock.calls[0];
  expect(slotsCall?.slice(0, 2)).toEqual([token, { date: '2026-10-10' }]);
  expect(slotsCall?.[2].requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(slotsCall?.[2].ipAddress).toBe('127.0.0.1');
  expect((await app.inject('/api/v1/private')).statusCode).toBe(401);
});

it('passes only validated scope and trusted request id/IP to handlers and the limiter', async () => {
  const { app, handlers, rateLimit } = await start();
  const response = await app.inject({
    url: calendarPath,
    remoteAddress: '192.0.2.8',
    headers: {
      'x-request-id': 'client-chosen',
      'x-forwarded-for': '198.51.100.1',
      'business-id': 'attacker-chosen',
    },
  });
  expect(response.statusCode).toBe(200);
  const request = { requestId: response.headers['x-request-id'], ipAddress: '192.0.2.8' };
  expect(request.requestId).not.toBe('client-chosen');
  // The handler is also given the way to say which business the address turned out to
  // be for; the limiter is given nothing of the kind until the module has said so.
  expect(handlers.calendar).toHaveBeenCalledExactlyOnceWith(
    { agencySlug: 'agency', businessSlug: 'business', calendarSlug: 'calendar' },
    { ...request, onBusiness: expect.any(Function) as unknown },
  );
  expect(rateLimit).toHaveBeenCalledExactlyOnceWith(request, 'read');
});

const BUSINESS = '0b0e6f0c-5a3f-4a52-9d0f-5a1c2f1e7a11';
const OTHER_BUSINESS = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const page = {
  ...receipt,
  calendarName: calendar.name,
  timezone: calendar.timezone,
  revision: operation.revision,
};

it('counts a request toward its business once the module has said which business an address or a link is for', async () => {
  const scopes = createIntakeScopes();
  const learn = vi.spyOn(scopes, 'learn');
  const { app, handlers, rateLimit } = await start({ scopes });
  const scoped = () => rateLimit.mock.calls.map(([request]) => request.businessId);
  // Nobody has resolved this address yet: its first request counts by its address alone.
  vi.mocked(handlers.calendar).mockImplementation((_params, request) => {
    request.onBusiness?.(BUSINESS);
    return Promise.resolve(calendar);
  });
  expect((await app.inject(calendarPath)).statusCode).toBe(200);
  expect(scoped()).toEqual([undefined]);
  expect(rateLimit.mock.calls[0]?.[0]).not.toHaveProperty('businessId');
  // Every later request for the business counts toward it: this calendar, a booking on
  // it, and another calendar of the same business.
  await app.inject(`${calendarPath}/slots?date=2026-10-10`);
  await app.inject({ method: 'POST', url: `${calendarPath}/appointments`, payload: booking });
  await app.inject('/api/v1/public/book/agency/business/another-calendar');
  expect(scoped().slice(1)).toEqual([BUSINESS, BUSINESS, BUSINESS]);
  // Another business is not this one.
  await app.inject('/api/v1/public/book/agency/neighbour/calendar');
  expect(scoped().at(-1)).toBeUndefined();

  // A link to an appointment names its business the same way, from its second request on.
  vi.mocked(handlers.appointment).mockImplementation((_token, request) => {
    request.onBusiness?.(OTHER_BUSINESS);
    return Promise.resolve(page);
  });
  await app.inject(appointmentPath);
  expect(scoped().at(-1)).toBeUndefined();
  await app.inject({ method: 'POST', url: `${appointmentPath}/cancel`, payload: operation });
  await app.inject(`${appointmentPath}/slots?date=2026-10-10`);
  expect(scoped().slice(-2)).toEqual([OTHER_BUSINESS, OTHER_BUSINESS]);
  // The link is the permission: what is remembered of it is a digest, never the link.
  const keys = learn.mock.calls.map(([key]) => key);
  expect(keys.join(' ')).not.toContain(token);
  expect(
    keys.every((key) => /^(book:agency\/(business|neighbour)|link:[\w-]{43})$/.test(key)),
  ).toBe(true);
});

it('remembers nothing for an address or a link the module could not resolve', async () => {
  const scopes = createIntakeScopes();
  const learn = vi.spyOn(scopes, 'learn');
  const { app, handlers, rateLimit } = await start({ scopes });
  vi.mocked(handlers.calendar).mockRejectedValue(new NotFoundError('Booking calendar', 'x'));
  vi.mocked(handlers.appointment).mockRejectedValue(new NotFoundError('Appointment', 'x'));
  for (const url of [calendarPath, calendarPath, appointmentPath, appointmentPath])
    expect((await app.inject(url)).statusCode).toBe(404);
  expect(learn).not.toHaveBeenCalled();
  expect(rateLimit.mock.calls.every(([request]) => request.businessId === undefined)).toBe(true);
});

it('lets one request of a business at a time reach the handlers, and tells one that finds the line full to wait', async () => {
  const { app, handlers } = await start({ gate: createIntakeGate({ maxWaiting: 1 }) });
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: string[] = [];
  vi.mocked(handlers.calendar).mockImplementation(async (params) => {
    order.push(`${params.businessSlug} started`);
    if (params.businessSlug === 'business') await held;
    order.push(`${params.businessSlug} ended`);
    return calendar;
  });
  vi.mocked(handlers.slots).mockImplementation((params) => {
    order.push(`${params.businessSlug} slots`);
    return Promise.resolve({ slots: [] });
  });
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const running = app.inject(calendarPath);
  await tick();
  // A second request of the same business, for another calendar of it, waits its turn...
  const waiting = app.inject('/api/v1/public/book/agency/business/another/slots?date=2026-10-10');
  await tick();
  expect(order).toEqual(['business started']);
  // ...and a third finds the line full: it is told to wait, and no handler runs for it.
  const refused = await app.inject({
    method: 'POST',
    url: `${calendarPath}/appointments`,
    payload: booking,
  });
  expect(refused.statusCode).toBe(429);
  expect(refused.headers).toMatchObject({ 'retry-after': '2', 'cache-control': 'no-store' });
  expect(refused.json()).toMatchObject({ status: 429, title: 'Too Many Requests' });
  expect(handlers.book).not.toHaveBeenCalled();
  // Another business is not behind it.
  expect((await app.inject('/api/v1/public/book/agency/neighbour/calendar')).statusCode).toBe(200);
  expect(order).toEqual(['business started', 'neighbour started', 'neighbour ended']);
  release();
  expect((await running).statusCode).toBe(200);
  expect((await waiting).statusCode).toBe(200);
  expect(order.slice(-2)).toEqual(['business ended', 'business slots']);
  // The line is free again.
  expect(
    (await app.inject({ method: 'POST', url: `${calendarPath}/appointments`, payload: booking }))
      .statusCode,
  ).toBe(200);
});

it('puts a link into the line of its business once that is known, and lets the next request through when one fails', async () => {
  const { app, handlers } = await start({ gate: createIntakeGate({ maxWaiting: 0 }) });
  let fail: (error: Error) => void = () => undefined;
  const held = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  vi.mocked(handlers.calendar).mockImplementation((_params, request) => {
    request.onBusiness?.(BUSINESS);
    return Promise.resolve(calendar);
  });
  vi.mocked(handlers.appointment).mockImplementation((_token, request) => {
    request.onBusiness?.(BUSINESS);
    return Promise.resolve(page);
  });
  // Both the address and the link are now known to be the one business.
  expect((await app.inject(calendarPath)).statusCode).toBe(200);
  expect((await app.inject(appointmentPath)).statusCode).toBe(200);
  vi.mocked(handlers.calendar).mockImplementationOnce(() => held);
  const running = app.inject(calendarPath);
  await new Promise<void>((resolve) => setImmediate(resolve));
  // The link waits in the same line as the address, which has no room.
  expect((await app.inject(appointmentPath)).statusCode).toBe(429);
  fail(new Error('the database is down'));
  expect((await running).statusCode).toBe(500);
  expect((await app.inject(appointmentPath)).statusCode).toBe(200);
});

it.each([
  { url: `${calendarPath}/appointments`, payload: { ...booking, businessId: 'forged' } },
  {
    url: `${calendarPath}/appointments`,
    payload: { ...booking, contact: { ...booking.contact, contactId: 'forged' } },
  },
  { url: `${appointmentPath}/cancel`, payload: { ...operation, userId: 'forged' } },
])(
  'refuses privileged or unknown body members before a handler runs: $url',
  async ({ url, payload }) => {
    const { app, handlers } = await start();
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(422);
    expect(handlers.book).not.toHaveBeenCalled();
    expect(handlers.cancel).not.toHaveBeenCalled();
  },
);

it('refuses invalid dates and capabilities before resolving scope', async () => {
  const { app, handlers } = await start();
  expect((await app.inject(`${calendarPath}/slots?date=0000-01-01`)).statusCode).toBe(422);
  expect((await app.inject(`${appointmentPath}/slots?date=0000-01-01`)).statusCode).toBe(422);
  expect(
    (await app.inject(`${appointmentPath}/slots?date=2026-10-10&contactId=forged`)).statusCode,
  ).toBe(422);
  expect((await app.inject('/api/v1/public/appointments/not-a-capability')).statusCode).toBe(422);
  expect(handlers.slots).not.toHaveBeenCalled();
  expect(handlers.appointment).not.toHaveBeenCalled();
  expect(handlers.appointmentSlots).not.toHaveBeenCalled();
});

it('bounds parsed JSON and treats malformed JSON safely', async () => {
  const { app, handlers } = await start();
  for (const [payload, status] of [
    [JSON.stringify({ ...booking, extra: 'x'.repeat(9000) }), 413],
    ['{"broken":', 400],
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: `${calendarPath}/appointments`,
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(response.statusCode).toBe(status);
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  }
  expect(handlers.book).not.toHaveBeenCalled();
});

it('fails closed when rate-limited or the required limiter is unavailable', async () => {
  const { app, handlers, rateLimit } = await start();
  rateLimit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 37 });
  const response = await app.inject({
    method: 'POST',
    url: `${calendarPath}/appointments`,
    payload: booking,
  });
  expect(response.statusCode).toBe(429);
  expect(response.headers['retry-after']).toBe('37');
  expect(rateLimit.mock.calls[0]?.[1]).toBe('write');
  rateLimit.mockRejectedValueOnce(new Error(`limiter secret ${token}`));
  const unavailable = await app.inject(calendarPath);
  expect(unavailable.statusCode).toBe(503);
  expect(unavailable.body).not.toContain(token);
  expect(handlers.calendar).not.toHaveBeenCalled();
  expect(handlers.book).not.toHaveBeenCalled();
});

it('rejects private extra fields in handler responses instead of serializing them', async () => {
  const { app, handlers, logs } = await start();
  const privateResult = {
    ...calendar,
    contactId: 'private-contact',
    email: 'private@example.test',
  };
  vi.mocked(handlers.calendar).mockResolvedValue(privateResult);
  const response = await app.inject(calendarPath);
  expect(response.statusCode).toBe(500);
  expect(response.body + logs.join('')).not.toMatch(/private-contact|private@example/);
});

it.each([
  new NotFoundError('Appointment', token),
  new ConflictError(`private ${token}`),
  new Error(`secret ${token}`),
])('redacts domain and unexpected errors from responses and logs', async (error) => {
  const { app, handlers, logs } = await start();
  vi.mocked(handlers.appointment).mockRejectedValue(error);
  const response = await app.inject(appointmentPath);
  expect(response.statusCode).toBe(
    error instanceof NotFoundError ? 404 : error instanceof ConflictError ? 409 : 500,
  );
  expect(response.body + logs.join('')).not.toContain(token);
});

it('keeps unknown paths, malformed router input and HEAD private without invoking handlers', async () => {
  const { app, handlers, logs } = await start();
  for (const url of [
    `${appointmentPath}/unknown`,
    '/api/v1/public/appointments/%zz',
    `/api/v1/public/appointments/${token.repeat(4)}`,
  ]) {
    const response = await app.inject(url);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain(token);
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  }
  expect((await app.inject({ method: 'HEAD', url: appointmentPath })).statusCode).toBe(404);
  expect(handlers.appointment).not.toHaveBeenCalled();
  expect(logs.join('')).not.toContain(token);
});

it('answers a booking sent sooner than a person books with 429 and the wait the module named', async () => {
  const { app, handlers } = await start();
  vi.mocked(handlers.book).mockRejectedValueOnce(new BookingTooSoonError(2));
  const refused = await app.inject({
    method: 'POST',
    url: `${calendarPath}/appointments`,
    payload: booking,
  });
  expect(refused.statusCode).toBe(429);
  expect(refused.headers['retry-after']).toBe('2');
  vi.mocked(handlers.book).mockRejectedValueOnce(new BookingTooSoonError(0));
  const unnamed = await app.inject({
    method: 'POST',
    url: `${calendarPath}/appointments`,
    payload: booking,
  });
  expect(unnamed.statusCode).toBe(429);
  expect(unnamed.headers['retry-after']).toBeUndefined();
});

it('serves the booking embed’s script beside the API, uncounted by the limiter, only when built', async () => {
  const script = { body: Buffer.from('(function(){})();'), etag: '"embed"' };
  const { app, rateLimit } = await start({ script });
  const answer = await app.inject({ method: 'GET', url: '/calendars/embed.js' });
  expect(answer.statusCode).toBe(200);
  expect(answer.body).toBe('(function(){})();');
  expect(answer.headers['cross-origin-resource-policy']).toBe('cross-origin');
  // A page view costs the install nothing an attacker could use up.
  expect(rateLimit).not.toHaveBeenCalled();
  const { app: unbuilt } = await start();
  expect((await unbuilt.inject({ method: 'GET', url: '/calendars/embed.js' })).statusCode).toBe(
    404,
  );
});
