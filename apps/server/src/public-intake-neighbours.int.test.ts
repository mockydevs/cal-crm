// Booking and web chat beside a neighbour, through the production start, over real HTTP, on
// real Postgres with the real shared limiter (migration 0089): a crowd on one business is
// slowed at that business's own ceiling, with "wait, then try again", while the business
// beside it is served as if nothing were happening, and nothing that was accepted is lost.
//
// The load test (bench/neighbours.load.ts) measures the same thing against the clock; this
// file keeps its counts, which do not depend on the machine.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { publicCalendarPage } from '@repo/contracts';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { openBench, WEBSITE, type Bench, type BenchBusiness } from '../bench/harness.js';

/** The limiter's ceiling for one business, a minute (migration 0089). */
const BUSINESS_WRITES_A_MINUTE = 100;

let bench: Bench;
beforeAll(async () => {
  bench = await openBench(inject('databaseServer'));
});
afterAll(async () => {
  await bench.close();
});

let crowds = 0;
/** Visitors with an address each, as a proxy in front of the server would name them. */
function crowd() {
  const base = (crowds += 1);
  return (n: number): string => `2001:db8:${base.toString(16)}:${n.toString(16)}::1`;
}

/**
 * The limiter counts in minutes of the database clock, so a count taken across the turn of
 * a minute is the count of two. A scenario that fails while the minute turned is run again,
 * with every counter empty; one that fails inside a single minute has failed.
 */
async function inOneMinute(scenario: () => Promise<void>): Promise<void> {
  const minute = async (): Promise<string> =>
    (
      await bench.database.as('crm_owner', (sql) =>
        sql.one<{ minute: string }>(
          "select date_trunc('minute', clock_timestamp())::text as minute",
        ),
      )
    ).minute;
  for (let attempt = 1; ; attempt += 1) {
    await bench.resetLimiter();
    const before = await minute();
    try {
      await scenario();
      return;
    } catch (error) {
      if (attempt === 3 || (await minute()) === before) throw error;
    }
  }
}

/** `work(n)` for n below `total`, at most `atOnce` running together. */
async function each<T>(
  total: number,
  atOnce: number,
  work: (n: number) => Promise<T>,
): Promise<T[]> {
  const answers: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: atOnce }, async () => {
      for (;;) {
        const mine = next;
        next += 1;
        if (mine >= total) return;
        answers[mine] = await work(mine);
      }
    }),
  );
  return answers;
}

const tally = (statuses: readonly number[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const status of statuses) counts[String(status)] = (counts[String(status)] ?? 0) + 1;
  return counts;
};

interface Answer {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly body: unknown;
}
async function send(url: string, init: RequestInit): Promise<Answer> {
  const response = await fetch(url, init);
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, retryAfter: response.headers.get('retry-after'), body };
}

/** The day and the slot of the visitor numbered n: 30 days of 16 half hours, each once. */
function slotOf(n: number): string {
  const day = new Date(Date.now() + (1 + (n % 30)) * 86_400_000).toISOString().slice(0, 10);
  const minutes = 9 * 60 + (Math.floor(n / 30) % 16) * 30;
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
  return `${day}T${hour}:${minutes % 60 === 0 ? '00' : '30'}:00Z`;
}

/** How long a person looks at the page before booking: the server wants at least 2 s. */
const A_PERSONS_PAUSE_MS = 2100;

/**
 * The booking page as this visitor is shown it: its proof of the showing, bound to the
 * calendar and to the visitor's address, and good for one booking.
 */
async function shown(url: string, address: string): Promise<string> {
  const page = await send(url, { headers: { 'x-forwarded-for': address } });
  expect(page.status).toBe(200);
  return publicCalendarPage.parse(page.body).renderToken;
}

/** Each of `total` visitors is shown the page, at most `atOnce` at a time; then they pause. */
async function shownToAll(
  url: string,
  visitor: (n: number) => string,
  total: number,
  atOnce: number,
): Promise<string[]> {
  const tokens = await each(total, atOnce, (n) => shown(url, visitor(n)));
  await sleep(A_PERSONS_PAUSE_MS);
  return tokens;
}

const book = (url: string, address: string, n: number, renderToken: string): Promise<Answer> =>
  send(`${url}/appointments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
    body: JSON.stringify({
      bookingRequestId: randomUUID(),
      startsAt: slotOf(n),
      contact: { firstName: 'Maya', email: `maya-${randomUUID().slice(0, 8)}@example.test` },
      notificationConsent: true,
      contactTimezone: 'UTC',
      renderToken,
    }),
  });

const booked = (business: BenchBusiness) =>
  bench.database.as('crm_owner', (sql) =>
    sql.one<{ appointments: number; events: number; confirmations: number }>(
      `select
         (select count(*)::integer from calendar.appointments where business_id = $1) as appointments,
         (select count(*)::integer from events.events
           where business_id = $1 and type = 'appointment.booked') as events,
         (select count(*)::integer from messaging.messages where business_id = $1) as confirmations`,
      [business.id],
    ),
  );

it('stops a crowd booking one business at that business’s ceiling, and books its neighbour’s visitors as usual', async () => {
  await inOneMinute(async () => {
    const flooded = await bench.business();
    const quiet = await bench.business();
    const target = await bench.calendar(flooded);
    const calm = await bench.calendar(quiet);
    const visitor = crowd();

    // The first request for an address tells the server which business it is for.
    expect(
      (await send(target.url, { headers: { 'x-forwarded-for': visitor(0xffff) } })).status,
    ).toBe(200);
    // 130 visitors, each with an address of their own and a slot of their own: none is
    // stopped by the limit of an address (ten writes a minute), and none by a taken slot.
    // Each is shown the page first, which is a read, and books with that showing's proof.
    const tokens = await shownToAll(target.url, visitor, 130, 8);
    const answers = await each(130, 8, (n) => book(target.url, visitor(n), n, tokens[n] ?? ''));
    const refused = answers.filter((answer) => answer.status === 429);
    expect(tally(answers.map((answer) => answer.status))).toEqual({
      200: BUSINESS_WRITES_A_MINUTE,
      429: 130 - BUSINESS_WRITES_A_MINUTE,
    });
    for (const answer of refused) {
      expect(Number(answer.retryAfter)).toBeGreaterThanOrEqual(1);
      expect(Number(answer.retryAfter)).toBeLessThanOrEqual(60);
      expect(answer.body).toMatchObject({ status: 429, title: 'Too Many Requests' });
    }
    // Nothing accepted was lost, and nothing refused was stored.
    expect(await booked(flooded)).toEqual({
      appointments: BUSINESS_WRITES_A_MINUTE,
      events: BUSINESS_WRITES_A_MINUTE,
      confirmations: BUSINESS_WRITES_A_MINUTE,
    });

    // The neighbour, in the same minute: its calendar is shown and its visitors are booked.
    // The flood used a fifth of what the install takes in a minute, and none of theirs.
    const neighbours = crowd();
    expect(
      (await send(calm.url, { headers: { 'x-forwarded-for': neighbours(0xffff) } })).status,
    ).toBe(200);
    const shownToNeighbours = await shownToAll(calm.url, neighbours, 12, 4);
    const usual = await each(12, 4, (n) =>
      book(calm.url, neighbours(n), n, shownToNeighbours[n] ?? ''),
    );
    expect(tally(usual.map((answer) => answer.status))).toEqual({ 200: 12 });
    expect(await booked(quiet)).toEqual({ appointments: 12, events: 12, confirmations: 12 });

    // The flooded business is still at its ceiling, for a new visitor too, until the minute
    // ends; reading its calendar is another count, and still answers.
    const [late = ''] = await shownToAll(target.url, () => visitor(500), 1, 1);
    expect((await book(target.url, visitor(500), 400, late)).status).toBe(429);
    expect((await send(target.url, { headers: { 'x-forwarded-for': visitor(501) } })).status).toBe(
      200,
    );
  });
});

it('answers a burst on one business’s calendar with the page or "wait", never an error, while its neighbour is answered', async () => {
  const flooded = await bench.business();
  const quiet = await bench.business();
  const target = await bench.calendar(flooded);
  const calm = await bench.calendar(quiet);
  await bench.resetLimiter();
  const visitor = crowd();
  const neighbours = crowd();
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  expect((await send(target.url, { headers: { 'x-forwarded-for': visitor(0xffff) } })).status).toBe(
    200,
  );

  // 120 visitors ask for the slots of a day within half a second: far more than the
  // server has connections (ten), each of them needing the row of the business. One at a
  // time reaches the database, 32 wait their turn holding nothing, and any past that are
  // told to wait.
  const [burst, usual] = await Promise.all([
    Promise.all(
      Array.from({ length: 120 }, async (_each, n) => {
        await sleep(n * 4);
        return send(`${target.url}/slots?date=${date}`, {
          headers: { 'x-forwarded-for': visitor(n) },
        });
      }),
    ),
    each(10, 1, (n) =>
      send(`${calm.url}/slots?date=${date}`, { headers: { 'x-forwarded-for': neighbours(n) } }),
    ),
  ]);
  const statuses = tally(burst.map((answer) => answer.status));
  expect(Object.keys(statuses).filter((status) => !['200', '429'].includes(status))).toEqual([]);
  expect(statuses['200']).toBeGreaterThanOrEqual(33);
  for (const answer of burst.filter((each) => each.status === 429))
    expect(answer.retryAfter).toBe('2');
  expect(tally(usual.map((answer) => answer.status))).toEqual({ 200: 10 });
});

interface ChatAnswer {
  readonly started: number;
  readonly written: number | undefined;
  readonly retryAfter: string | null;
}
async function chat(key: string, address: string): Promise<ChatAnswer> {
  const base = `${bench.app.address}/api/v1/public/webchat/${key}`;
  const headers = {
    'content-type': 'application/json',
    'x-forwarded-for': address,
    origin: WEBSITE,
  };
  const started = await send(`${base}/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'Maya Thompson',
      email: `maya-${randomUUID().slice(0, 8)}@example.test`,
      marketingConsent: false,
    }),
  });
  if (started.status !== 201)
    return { started: started.status, written: undefined, retryAfter: started.retryAfter };
  const { token } = started.body as { token: string };
  const written = await send(`${base}/messages`, {
    method: 'POST',
    headers: { ...headers, authorization: `Bearer ${token}` },
    body: JSON.stringify({ clientMessageId: randomUUID(), text: 'Are you open on Sunday?' }),
  });
  return { started: 201, written: written.status, retryAfter: written.retryAfter };
}

const chatted = (business: BenchBusiness) =>
  bench.database.as('crm_owner', (sql) =>
    sql.one<{ sessions: number; messages: number; events: number; contacts: number }>(
      `select
         (select count(*)::integer from messaging.webchat_sessions where business_id = $1) as sessions,
         (select count(*)::integer from messaging.messages where business_id = $1) as messages,
         (select count(*)::integer from events.events
           where business_id = $1 and type = 'message.received') as events,
         (select count(*)::integer from crm.contacts where business_id = $1) as contacts`,
      [business.id],
    ),
  );

it('stops a crowd chatting with one business at that business’s ceiling, and takes its neighbour’s chats as usual', async () => {
  const config = (key: string, address: string) =>
    send(`${bench.app.address}/api/v1/public/webchat/${key}`, {
      headers: { 'x-forwarded-for': address, origin: WEBSITE },
    });
  await inOneMinute(async () => {
    const flooded = await bench.business();
    const quiet = await bench.business();
    const target = await bench.widget(flooded);
    const calm = await bench.widget(quiet);
    const visitor = crowd();

    // The first request for a widget's key tells the server which business it is for.
    expect((await config(target.key, visitor(0xffff))).status).toBe(200);
    // 80 visitors each start a chat and write once: 160 writes, from 80 addresses.
    const answers = await each(80, 8, (n) => chat(target.key, visitor(n)));
    const started = answers.filter((answer) => answer.started === 201);
    const written = answers.filter((answer) => answer.written === 200);
    const refused = answers.filter((answer) => answer.started === 429 || answer.written === 429);
    // Every answer is "done" or "wait"; the business's hundred writes went to chats started
    // and messages taken, and to nothing else.
    expect(answers.every((answer) => [201, 429].includes(answer.started))).toBe(true);
    expect(started.every((answer) => answer.written === 200 || answer.written === 429)).toBe(true);
    expect(started.length + written.length).toBe(BUSINESS_WRITES_A_MINUTE);
    expect(refused.length).toBeGreaterThan(0);
    for (const answer of refused) expect(Number(answer.retryAfter)).toBeGreaterThanOrEqual(1);
    // Nothing accepted was lost: a session for each chat started; a message, its event and
    // its contact for each message taken.
    expect(await chatted(flooded)).toEqual({
      sessions: started.length,
      messages: written.length,
      events: written.length,
      contacts: written.length,
    });

    // The neighbour, in the same minute.
    const neighbours = crowd();
    expect((await config(calm.key, neighbours(0xffff))).status).toBe(200);
    const usual = await each(10, 2, (n) => chat(calm.key, neighbours(n)));
    expect(usual.map((answer) => [answer.started, answer.written])).toEqual(
      Array.from({ length: 10 }, () => [201, 200]),
    );
    expect(await chatted(quiet)).toEqual({ sessions: 10, messages: 10, events: 10, contacts: 10 });

    // The flooded business is still at its ceiling for a new visitor; its widget still shows.
    expect((await chat(target.key, visitor(900))).started).toBe(429);
    expect((await config(target.key, visitor(901))).status).toBe(200);
  });
});
