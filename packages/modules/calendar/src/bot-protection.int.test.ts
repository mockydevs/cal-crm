// A calendar's bot protection: off by default; when on, the page is given a challenge
// bound to the showing it holds, and a booking is taken only with a proof that the bot
// check accepts for that same showing. The check here is a stand-in: ALTCHA itself is
// tested in the forms module (bot-challenge.test) and through the server
// (public-booking-http.int.test).
import { randomUUID } from 'node:crypto';
import type { BookingBotCheck } from './public-routes.js';
import { ConflictError, NotFoundError } from '@repo/kernel';
import type { BotProof } from '@repo/contracts';
import type { TestDatabase } from '@repo/testing';
import { beforeAll, expect, it } from 'vitest';
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

/** A stand-in check: the "solution" is the showing's mark, in the challenge's salt. */
const issued: string[] = [];
const bot: BookingBotCheck = {
  issue: (render) => {
    issued.push(render);
    return Promise.resolve({
      kind: 'altcha',
      challenge: {
        parameters: {
          algorithm: 'PBKDF2/SHA-256',
          nonce: '00',
          salt: '00',
          cost: 1,
          keyLength: 32,
          keyPrefix: '00',
          data: { render },
        },
        signature: '00',
      },
    });
  },
  verify: (render, proof) =>
    Promise.resolve(
      proof?.challenge.parameters.data?.render === render && proof.solution.derivedKey === 'aa',
    ),
};
const proofFor = (token: string): BotProof => ({
  kind: 'altcha',
  challenge: {
    parameters: {
      algorithm: 'PBKDF2/SHA-256',
      nonce: '00',
      salt: '00',
      cost: 1,
      keyLength: 32,
      keyPrefix: '00',
      data: { render: token.slice(14) },
    },
    signature: '00',
  },
  solution: { counter: 1, derivedKey: 'aa' },
});

it('is off by default: the page names none, gives no challenge, and books without a proof', async () => {
  const f = await fixture('Open');
  const date = tomorrow();
  const page = await handlers(undefined, undefined, undefined, { bot }).calendar(
    f.params,
    request(),
  );
  expect(page).not.toHaveProperty('botProtection');
  await expect(
    handlers(undefined, undefined, undefined, { bot }).challenge(
      f.params,
      { renderToken: page.renderToken },
      request(),
    ),
  ).rejects.toBeInstanceOf(NotFoundError);
  expect(
    (
      await handlers(undefined, undefined, undefined, { bot }).book(
        f.params,
        booking(date, '10:00', 'open@example.test'),
        request(),
      )
    ).status,
  ).toBe('booked');
});

it('when on, takes a booking only with a proof solved for the same showing of the page', async () => {
  const f = await fixture('Guarded', { settings: { botProtection: 'altcha' } });
  const live = handlers(undefined, undefined, undefined, { bot });
  const date = tomorrow();
  const page = await live.calendar(f.params, request());
  expect(page.botProtection).toBe('altcha');
  // The challenge is bound to the showing the visitor holds.
  const token = renderToken();
  const view = await live.challenge(f.params, { renderToken: token }, request());
  expect(view.challenge.parameters.data).toEqual({ render: token.slice(14) });
  expect(issued.at(-1)).toBe(token.slice(14));
  // A token the proof refuses gets no challenge: the page is shown again.
  await expect(
    live.challenge(f.params, { renderToken: renderToken('STALE') }, request()),
  ).rejects.toBeInstanceOf(ConflictError);
  // No proof, a wrong one, or one solved for another showing: the page is shown again.
  for (const proof of [
    undefined,
    { ...proofFor(token), solution: { counter: 1, derivedKey: 'bb' } },
    proofFor(renderToken()),
  ])
    await expect(
      live.book(
        f.params,
        {
          ...booking(date, '10:00', 'guarded@example.test'),
          renderToken: token,
          ...(proof === undefined ? {} : { botProof: proof }),
        },
        request(),
      ),
    ).rejects.toThrow('The booking page changed');
  const booked = await live.book(
    f.params,
    {
      ...booking(date, '10:00', 'guarded@example.test'),
      renderToken: token,
      botProof: proofFor(token),
    },
    request(),
  );
  expect(booked.status).toBe('booked');
  // The solved challenge is spent with its showing: used again, it is refused.
  await expect(
    live.book(
      f.params,
      {
        ...booking(date, '11:00', 'again@example.test'),
        renderToken: token,
        botProof: proofFor(token),
      },
      request(),
    ),
  ).rejects.toThrow('The booking page changed');
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select render_mark from calendar.appointments'),
    ),
  ).toEqual([{ render_mark: token.slice(14) }]);
});

it('fails closed when the server has no bot check: no challenge and no booking', async () => {
  const f = await fixture('No check', { settings: { botProtection: 'altcha' } });
  const token = renderToken();
  await expect(
    handlers().challenge(f.params, { renderToken: token }, request()),
  ).rejects.toBeInstanceOf(NotFoundError);
  await expect(
    handlers().book(
      f.params,
      {
        ...booking(tomorrow(), '10:00', 'closed@example.test'),
        renderToken: token,
        botProof: proofFor(token),
      },
      request(),
    ),
  ).rejects.toThrow('The booking page changed');
});

it('keeps the setting with the calendar', async () => {
  const f = await fixture('Stored', { settings: { botProtection: 'altcha' } });
  expect(
    await database.withTenant(f.business.context, (sql) =>
      sql.query('select bot_protection from calendar.calendars'),
    ),
  ).toEqual([{ bot_protection: 'altcha' }]);
  await expect(
    database.withTenant(f.business.context, (sql) =>
      sql.query("update calendar.calendars set bot_protection = 'captcha'"),
    ),
  ).rejects.toThrow(/calendars_bot_protection_valid/);
});
