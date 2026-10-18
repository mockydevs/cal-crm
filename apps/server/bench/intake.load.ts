// The intake load test: the production start on a real Postgres, and a crowd of visitors
// who each load a form, take as long as a person does to fill it in, and send it once.
//
// Two questions, two phases:
//
// 1. How many submissions a second can the server store? The crowd grows step by step
//    over forty forms of eight businesses. The limiter's counters are emptied while it
//    runs, as the turn of a minute does, because its ceilings (10 writes a minute an
//    address, 100 a business, 500 the install) are far below what the server can store:
//    every request still pays for the limiter's statement. The ceiling is the last step
//    at which every visitor was answered "received" and none waited long. Past it the
//    server refuses what it cannot take (503, at once) and loses nothing it accepted.
// 2. Does a flood on one business touch another? With the limits as an install has them:
//    one business's form is flooded from hundreds of addresses while a second business
//    takes its usual submissions and a published page is visited once a second.
//
// In both, nothing may be lost: every visitor told "received" is one stored submission and
// one event, and nobody is answered with anything but "received" or "wait, then try again".
//
// Run: pnpm --filter @repo/server run load:intake (needs Docker; about two minutes).
// Numbers go to apps/server/reports/load-intake.json.
import { FORM_LIMITS } from '@repo/contracts';
import { longPage } from '@repo/site-render/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import {
  load,
  machine,
  openBench,
  repeatedly,
  report,
  summary,
  WEBSITE,
  type Bench,
} from './harness.js';

interface Visitor {
  readonly form: string;
  readonly shown: number;
  readonly status: number;
  readonly ms: number;
  readonly retryAfter?: string;
}
interface Crowd {
  readonly visitors: Visitor[];
  readonly pages: { readonly status: number; readonly ms: number }[];
}

/** Visitors a second, step by step, and how long each step lasts. */
const STEPS = [10, 20, 40, 80, 160, 320];
const STEP_SECONDS = 8;
/** A person takes at least this long; a little more, so no submission is "too soon". */
const FILL_MS = FORM_LIMITS.minFillSeconds * 1000 + 250;
/** What this test fails below: forty visitors a second, all received, none waiting. */
const MUST_CARRY_PER_SECOND = 40;
/** A visitor who waits longer than this for "received" has waited too long. */
const P95_CEILING_MS = 1000;

const FLOOD_PER_SECOND = 30;
const FLOOD_SECONDS = 20;
const QUIET_PER_SECOND = 2;
/** What the quiet business's visitors may wait while its neighbour is flooded. */
const QUIET_P95_CEILING_MS = 1500;
const PAGE_P95_CEILING_MS = 250;
/** The limiter's ceiling for one business, a minute (migration 0089). */
const BUSINESS_WRITES_A_MINUTE = 100;

let bench: Bench;
beforeAll(async () => {
  bench = await openBench(inject('databaseServer'));
});
afterAll(async () => {
  await bench.close();
});

/** What the database holds for a business: every one of these is one visitor's "received". */
const stored = (businessId: string) =>
  bench.database.as('crm_owner', (sql) =>
    sql.one<{ submissions: number; events: number; contacts: number }>(
      `select
         (select count(*)::integer from forms.submissions where business_id = $1) as submissions,
         (select count(*)::integer from events.events
           where business_id = $1 and type = 'form.submitted') as events,
         (select count(*)::integer from crm.contacts where business_id = $1) as contacts`,
      [businessId],
    ),
  );

const tally = (visitors: readonly Visitor[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const each of visitors) {
    const key = each.shown === 200 ? String(each.status) : `form not shown (${String(each.shown)})`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

it('stores every submission it accepts, step by step, to the ceiling of this machine', async () => {
  const businesses = await Promise.all(Array.from({ length: 8 }, () => bench.business()));
  const forms: { key: string; website: string; businessId: string }[] = [];
  for (const business of businesses)
    for (let n = 0; n < 5; n += 1) {
      const form = await bench.form(business.invocation, `Enquiry ${String(n)}`);
      forms.push({ key: form.publicKey, website: WEBSITE, businessId: business.id });
    }

  const stopEmptying = repeatedly(40, () => bench.resetLimiter());

  const steps = [];
  let accepted = 0;
  try {
    for (const [index, perSecond] of STEPS.entries()) {
      const started = performance.now();
      const crowd = await load<Crowd>({
        kind: 'submit',
        origin: bench.app.address,
        forms,
        perSecond,
        seconds: STEP_SECONDS,
        fillMs: FILL_MS,
        addressBase: 10 + index,
      });
      const received = crowd.visitors.filter((each) => each.status === 201);
      accepted += received.length;
      steps.push({
        visitorsPerSecond: perSecond,
        visitors: crowd.visitors.length,
        answers: tally(crowd.visitors),
        storedPerSecond: Number(
          (received.length / ((performance.now() - started) / 1000)).toFixed(1),
        ),
        ms: received.length === 0 ? null : summary(received.map((each) => each.ms)),
      });
    }
  } finally {
    await stopEmptying();
  }

  const held = await Promise.all(businesses.map((business) => stored(business.id)));
  const totals = held.reduce(
    (sum, each) => ({
      submissions: sum.submissions + each.submissions,
      events: sum.events + each.events,
      contacts: sum.contacts + each.contacts,
    }),
    { submissions: 0, events: 0, contacts: 0 },
  );
  const clean = steps.filter(
    (step) =>
      Object.keys(step.answers).every((answer) => answer === '201') &&
      (step.ms?.p95 ?? Number.POSITIVE_INFINITY) < P95_CEILING_MS,
  );
  const ceiling = Math.max(0, ...clean.map((step) => step.visitorsPerSecond));
  report('load-intake-capacity', {
    machine: machine(),
    forms: forms.length,
    businesses: businesses.length,
    stepSeconds: STEP_SECONDS,
    steps,
    accepted,
    stored: totals,
    ceilingSubmissionsPerSecond: ceiling,
    p95CeilingMs: P95_CEILING_MS,
  });

  // Nothing lost and nothing made up: each "received" is one submission, one event and
  // (every visitor has an address of their own) one contact.
  expect(totals).toEqual({ submissions: accepted, events: accepted, contacts: accepted });
  // Up to the crowd every install must carry, nobody was answered with anything but
  // "received": no refusal, no error, nobody waiting.
  for (const step of steps.filter((each) => each.visitorsPerSecond <= MUST_CARRY_PER_SECOND)) {
    expect(step.answers).toEqual({ 201: step.visitors });
    expect(step.ms?.p95).toBeLessThan(P95_CEILING_MS);
  }
  // Past what the machine can store, the server says so at once (429 from a ceiling, 503
  // when it has no connection to spare) and never anything else: no failure halfway, no
  // request left hanging. What it did accept is all there, as counted above.
  for (const step of steps)
    expect(
      Object.keys(step.answers).filter(
        (answer) => !['201', '429', '503', 'form not shown (503)'].includes(answer),
      ),
    ).toEqual([]);
  expect(ceiling).toBeGreaterThanOrEqual(MUST_CARRY_PER_SECOND);
});

it('slows a flood on one business without touching another, and keeps the page answering', async () => {
  // As an install has them: counters as the last minute left them, emptied once, never again.
  await bench.resetLimiter();
  const flooded = await bench.business();
  const quiet = await bench.business();
  const target = await bench.form(flooded.invocation, 'Flooded');
  const calm = await bench.form(quiet.invocation, 'Quiet');
  const page = await bench.publish(longPage());
  // The page once, so it is kept: during the flood it is answered from what was kept.
  expect(
    (await fetch(page.url, { headers: { 'x-forwarded-for': '2001:db8:fe00:1::1' } })).status,
  ).toBe(200);

  const [flood, usual] = await Promise.all([
    load<Crowd>({
      kind: 'submit',
      origin: bench.app.address,
      forms: [{ key: target.publicKey, website: WEBSITE }],
      perSecond: FLOOD_PER_SECOND,
      seconds: FLOOD_SECONDS,
      fillMs: FILL_MS,
      addressBase: 100,
      pageUrl: page.url,
    }),
    load<Crowd>({
      kind: 'submit',
      origin: bench.app.address,
      forms: [{ key: calm.publicKey, website: WEBSITE }],
      perSecond: QUIET_PER_SECOND,
      seconds: FLOOD_SECONDS,
      fillMs: FILL_MS,
      addressBase: 110,
    }),
  ]);

  const floodReceived = flood.visitors.filter((each) => each.status === 201);
  const floodRefused = flood.visitors.filter((each) => each.status === 429);
  const quietReceived = usual.visitors.filter((each) => each.status === 201);
  const result = {
    machine: machine(),
    seconds: FLOOD_SECONDS,
    flooded: {
      visitorsPerSecond: FLOOD_PER_SECOND,
      visitors: flood.visitors.length,
      answers: tally(flood.visitors),
      stored: await stored(flooded.id),
      receivedMs: floodReceived.length === 0 ? null : summary(floodReceived.map((each) => each.ms)),
      refusedMs: floodRefused.length === 0 ? null : summary(floodRefused.map((each) => each.ms)),
    },
    quiet: {
      visitorsPerSecond: QUIET_PER_SECOND,
      visitors: usual.visitors.length,
      answers: tally(usual.visitors),
      stored: await stored(quiet.id),
      receivedMs: summary(quietReceived.map((each) => each.ms)),
    },
    page: {
      visits: flood.pages.length,
      answers: flood.pages.reduce<Record<string, number>>((counts, each) => {
        counts[String(each.status)] = (counts[String(each.status)] ?? 0) + 1;
        return counts;
      }, {}),
      ms: summary(flood.pages.map((each) => each.ms)),
    },
  };
  report('load-intake-isolation', result);

  // The flood: every visitor was told "received" or "wait, then try again", with how long
  // to wait, and nothing else. What was received is stored, once each.
  expect(Object.keys(result.flooded.answers).sort()).toEqual(['201', '429']);
  for (const refused of floodRefused) expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(1);
  expect(result.flooded.stored).toEqual({
    submissions: floodReceived.length,
    events: floodReceived.length,
    contacts: floodReceived.length,
  });
  // No more than its ceiling in each of the minutes the flood ran across (two at most).
  expect(floodReceived.length).toBeLessThanOrEqual(2 * BUSINESS_WRITES_A_MINUTE);
  expect(floodReceived.length).toBeGreaterThan(0);
  expect(floodRefused.length).toBeGreaterThan(flood.visitors.length / 2);

  // The neighbour: every one of its visitors received, none lost, none waiting.
  expect(result.quiet.answers).toEqual({ 201: usual.visitors.length });
  expect(result.quiet.stored).toEqual({
    submissions: usual.visitors.length,
    events: usual.visitors.length,
    contacts: usual.visitors.length,
  });
  expect(result.quiet.receivedMs.p95).toBeLessThan(QUIET_P95_CEILING_MS);

  // The page: answered throughout, from what was kept, within its ceiling.
  expect(Object.keys(result.page.answers).every((status) => ['200', '304'].includes(status))).toBe(
    true,
  );
  expect(result.page.answers['304']).toBeGreaterThanOrEqual(flood.pages.length - 1);
  expect(result.page.ms.p95).toBeLessThan(PAGE_P95_CEILING_MS);
});
