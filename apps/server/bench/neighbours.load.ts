// Booking and web chat beside a neighbour: the production start on a real Postgres, with
// the limits as an install has them. One business's booking calendar, then one business's
// chat widget, is flooded from hundreds of addresses while a second business takes its
// usual bookings and chats.
//
// What must hold: the flooded business's visitors are answered with what they asked for
// or with "wait, then try again" (429 with Retry-After) and nothing else; the neighbour's
// visitors all get what they asked for, without waiting; and every answer that said "done"
// is one row stored, with its event.
//
// Run: pnpm --filter @repo/server run load:neighbours (needs Docker; about a minute).
// Numbers go to apps/server/reports/load-booking-isolation.json and
// load-chat-isolation.json.
import { WEBCHAT_LIMITS } from '@repo/contracts';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import {
  load,
  machine,
  openBench,
  report,
  summary,
  WEBSITE,
  type Bench,
  type BenchBusiness,
} from './harness.js';

interface Visitor {
  readonly shown: number;
  /** Chat only: the answer to "start a chat". */
  readonly started?: number;
  readonly status: number;
  readonly ms: number;
  readonly retryAfter?: string;
}
interface Crowd {
  readonly visitors: Visitor[];
}

const FLOOD_PER_SECOND = 30;
const FLOOD_SECONDS = 20;
const QUIET_PER_SECOND = 2;
/** What the neighbour's visitors may wait while the business beside them is flooded. */
const QUIET_P95_CEILING_MS = 1500;
/** The limiter's ceiling for one business, a minute (migration 0089). */
const BUSINESS_WRITES_A_MINUTE = 100;
/** The days a crowd spreads its bookings over: each has sixteen half-hour slots. */
const DAYS = 30;

let bench: Bench;
beforeAll(async () => {
  bench = await openBench(inject('databaseServer'));
});
afterAll(async () => {
  await bench.close();
});

const count = (answers: readonly (number | undefined)[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const each of answers) counts[String(each)] = (counts[String(each)] ?? 0) + 1;
  return counts;
};
const timed = (visitors: readonly Visitor[]) =>
  visitors.length === 0 ? null : summary(visitors.map((each) => each.ms));

it('slows a flood of bookings on one business without touching another', async () => {
  // As an install has them: counters as the last minute left them, emptied once, never again.
  await bench.resetLimiter();
  const flooded = await bench.business();
  const quiet = await bench.business();
  const target = await bench.calendar(flooded);
  const calm = await bench.calendar(quiet);
  const firstDay = Date.now() + 86_400_000;

  const [flood, usual] = await Promise.all([
    load<Crowd>({
      kind: 'book',
      url: target.url,
      perSecond: FLOOD_PER_SECOND,
      seconds: FLOOD_SECONDS,
      addressBase: 120,
      days: DAYS,
      firstDay,
    }),
    load<Crowd>({
      kind: 'book',
      url: calm.url,
      perSecond: QUIET_PER_SECOND,
      seconds: FLOOD_SECONDS,
      addressBase: 130,
      days: DAYS,
      firstDay,
    }),
  ]);

  const stored = (business: BenchBusiness) =>
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
  const booked = (crowd: Crowd) => crowd.visitors.filter((each) => each.status === 200);
  const result = {
    machine: machine(),
    seconds: FLOOD_SECONDS,
    flooded: {
      visitorsPerSecond: FLOOD_PER_SECOND,
      visitors: flood.visitors.length,
      calendarShown: count(flood.visitors.map((each) => each.shown)),
      bookings: count(flood.visitors.filter((each) => each.shown === 200).map((e) => e.status)),
      stored: await stored(flooded),
      bookedMs: timed(booked(flood)),
      refusedMs: timed(flood.visitors.filter((each) => each.status === 429)),
    },
    quiet: {
      visitorsPerSecond: QUIET_PER_SECOND,
      visitors: usual.visitors.length,
      calendarShown: count(usual.visitors.map((each) => each.shown)),
      bookings: count(usual.visitors.filter((each) => each.shown === 200).map((e) => e.status)),
      stored: await stored(quiet),
      bookedMs: timed(booked(usual)),
    },
  };
  report('load-booking-isolation', result);

  // The flood: the calendar was shown or the visitor was told to wait; a booking was made,
  // or its slot had just gone (409), or the visitor was told to wait. Nothing else.
  expect(
    Object.keys(result.flooded.calendarShown).filter((s) => !['200', '429'].includes(s)),
  ).toEqual([]);
  expect(
    Object.keys(result.flooded.bookings).filter((s) => !['200', '409', '429'].includes(s)),
  ).toEqual([]);
  for (const refused of flood.visitors.filter((each) => each.status === 429))
    expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(1);
  // Every booking made is one appointment, one event and one confirmation queued.
  const made = booked(flood).length;
  expect(result.flooded.stored).toEqual({ appointments: made, events: made, confirmations: made });
  // No more than its ceiling in each of the minutes the flood ran across (two at most).
  expect(made).toBeGreaterThan(0);
  expect(made).toBeLessThanOrEqual(2 * BUSINESS_WRITES_A_MINUTE);
  expect(result.flooded.calendarShown['429'] ?? 0).toBeGreaterThan(0);

  // The neighbour: every visitor saw the calendar and booked the slot they asked for.
  expect(result.quiet.calendarShown).toEqual({ 200: usual.visitors.length });
  expect(result.quiet.bookings).toEqual({ 200: usual.visitors.length });
  expect(result.quiet.stored).toEqual({
    appointments: usual.visitors.length,
    events: usual.visitors.length,
    confirmations: usual.visitors.length,
  });
  expect(result.quiet.bookedMs?.p95).toBeLessThan(QUIET_P95_CEILING_MS);
});

it('slows a flood of chats on one business without touching another', async () => {
  await bench.resetLimiter();
  const flooded = await bench.business();
  const quiet = await bench.business();
  const target = await bench.widget(flooded);
  const calm = await bench.widget(quiet);

  const crowd = (key: string, perSecond: number, addressBase: number) =>
    load<Crowd>({
      kind: 'chat',
      origin: bench.app.address,
      key,
      website: WEBSITE,
      perSecond,
      seconds: FLOOD_SECONDS,
      addressBase,
    });
  const [flood, usual] = await Promise.all([
    crowd(target.key, FLOOD_PER_SECOND, 140),
    crowd(calm.key, QUIET_PER_SECOND, 150),
  ]);

  const stored = (business: BenchBusiness) =>
    bench.database.as('crm_owner', (sql) =>
      sql.one<{ messages: number; events: number; contacts: number; conversations: number }>(
        `select
           (select count(*)::integer from messaging.messages where business_id = $1) as messages,
           (select count(*)::integer from events.events
             where business_id = $1 and type = 'message.received') as events,
           (select count(*)::integer from crm.contacts where business_id = $1) as contacts,
           (select count(*)::integer from messaging.conversations where business_id = $1) as conversations`,
        [business.id],
      ),
    );
  const written = (each: Crowd) => each.visitors.filter((visitor) => visitor.status === 200);
  const shown = (each: Crowd) => each.visitors.filter((visitor) => visitor.shown === 200);
  const started = (each: Crowd) => each.visitors.filter((visitor) => visitor.started === 201);
  const result = {
    machine: machine(),
    seconds: FLOOD_SECONDS,
    flooded: {
      visitorsPerSecond: FLOOD_PER_SECOND,
      visitors: flood.visitors.length,
      widgetShown: count(flood.visitors.map((each) => each.shown)),
      chatsStarted: count(shown(flood).map((each) => each.started)),
      messages: count(started(flood).map((each) => each.status)),
      stored: await stored(flooded),
      writtenMs: timed(written(flood)),
    },
    quiet: {
      visitorsPerSecond: QUIET_PER_SECOND,
      visitors: usual.visitors.length,
      widgetShown: count(usual.visitors.map((each) => each.shown)),
      chatsStarted: count(shown(usual).map((each) => each.started)),
      messages: count(started(usual).map((each) => each.status)),
      stored: await stored(quiet),
      writtenMs: timed(written(usual)),
    },
  };
  report('load-chat-isolation', result);

  // The flood: every answer is what was asked for, or "wait, then try again".
  for (const answers of [
    result.flooded.widgetShown,
    result.flooded.chatsStarted,
    result.flooded.messages,
  ])
    expect(Object.keys(answers).filter((s) => !['200', '201', '429'].includes(s))).toEqual([]);
  for (const refused of flood.visitors.filter(
    (each) => each.started === 429 || each.status === 429,
  ))
    expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(1);
  // Every message taken is one message, one event, one contact and one conversation.
  const taken = written(flood).length;
  expect(result.flooded.stored).toEqual({
    messages: taken,
    events: taken,
    contacts: taken,
    conversations: taken,
  });
  expect(taken).toBeGreaterThan(0);
  // A widget starts no more chats in an hour than its own limit, whoever asks.
  expect(started(flood).length).toBeLessThanOrEqual(WEBCHAT_LIMITS.sessionsPerHour);
  expect(result.flooded.chatsStarted['429'] ?? 0).toBeGreaterThan(0);

  // The neighbour: every visitor saw the widget, started a chat and wrote.
  const all = usual.visitors.length;
  expect(result.quiet.widgetShown).toEqual({ 200: all });
  expect(result.quiet.chatsStarted).toEqual({ 201: all });
  expect(result.quiet.messages).toEqual({ 200: all });
  expect(result.quiet.stored).toEqual({
    messages: all,
    events: all,
    contacts: all,
    conversations: all,
  });
  expect(result.quiet.writtenMs?.p95).toBeLessThan(QUIET_P95_CEILING_MS);
});
