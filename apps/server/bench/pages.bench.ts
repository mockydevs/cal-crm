// The server's own time for a published page: the production start, a real Postgres, the
// 20-section page, and a crowd in a thread of its own. Three visits are measured:
//
//   cold     the page has to be rendered: nothing is kept (the cache is switched off)
//   kept     the page is in the process's cache: one statement says it is still the page
//   held     the visitor already has it (If-None-Match): 304 and no bytes
//
// each with the shared limiter as an install has it. The limiter's ceilings are a minute
// long (120 reads an address, 1200 a business, 6000 the install), and the crowd is larger
// than a minute allows, so the counters are emptied while it runs, as the turn of a minute
// does: every request still pays for the limiter's statement.
//
// Run: pnpm --filter @repo/server run bench:pages (needs Docker). Numbers go to
// apps/server/reports/bench-pages.json.
import { longPage } from '@repo/site-render/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import {
  load,
  machine,
  openBench,
  repeatedly,
  report,
  summary,
  type Bench,
  type GetResult,
} from './harness.js';

const REQUESTS = 3000;
const CONNECTIONS = 8;
/**
 * How often the limiter's counters are emptied: often enough that a business's 1200 reads
 * are never used up between two turns, at the rates this machine reaches.
 */
const RESET_MS = 40;

let bench: Bench;
let cold: Bench;
let stopResets = (): Promise<void> => Promise.resolve();
beforeAll(async () => {
  bench = await openBench(inject('databaseServer'));
  // A second server that keeps no page: every visit there renders.
  cold = await openBench(inject('databaseServer'), { sitesPageCachePages: 0 });
  stopResets = repeatedly(RESET_MS, async () => {
    await bench.resetLimiter();
    await cold.resetLimiter();
  });
});
afterAll(async () => {
  await stopResets();
  await bench.close();
  await cold.close();
});

const run = async (
  url: string,
  headers: Record<string, string>,
  addressBase: number,
  connections = CONNECTIONS,
  requests = REQUESTS,
) => {
  const result = await load<GetResult>({
    kind: 'get',
    url,
    headers,
    connections,
    requests,
    addressBase,
  });
  return {
    connections,
    statuses: result.statuses,
    requestsPerSecond: Math.round(requests / result.seconds),
    bytesPerResponse: Math.round(result.bytes / requests),
    ms: summary(result.latencies),
  };
};

it('measures a published 20-section page: rendered, kept, and already held', async () => {
  const document = longPage();
  const { url } = await bench.publish(document);
  const first = await fetch(url, { headers: { 'x-forwarded-for': '2001:db8:ffff:1::1' } });
  expect(first.status).toBe(200);
  const etag = first.headers.get('etag') ?? '';
  const html = await first.text();

  // Warm the connections and the just-in-time compiler before anything is timed.
  await load<GetResult>({
    kind: 'get',
    url,
    headers: {},
    connections: CONNECTIONS,
    requests: 300,
    addressBase: 250,
  });

  const kept = await run(url, {}, 1);
  const keptBrotli = await run(url, { 'accept-encoding': 'br' }, 2);
  const held = await run(url, { 'if-none-match': etag }, 3);
  const missing = await run(url.replace('/landing', '/nothing-here'), {}, 4);

  // The same page on a server that keeps nothing: each visit reads its rows and renders.
  const uncached = await cold.publish(document);
  const rendered = await run(uncached.url, {}, 5);
  // One visitor at a time: what one visit costs when nobody else is asking.
  const renderedAlone = await run(uncached.url, {}, 6, 1, 500);
  const keptAlone = await run(url, {}, 7, 1, 500);
  const heldAlone = await run(url, { 'if-none-match': etag }, 8, 1, 500);

  const result = {
    machine: machine(),
    page: {
      sections: 20,
      elements: 300,
      htmlBytes: Buffer.byteLength(html),
      connections: CONNECTIONS,
      requests: REQUESTS,
    },
    keptIdentity: kept,
    keptBrotli,
    held304: held,
    notFound404: missing,
    renderedEveryVisit: rendered,
    oneVisitorAtATime: { rendered: renderedAlone, kept: keptAlone, held304: heldAlone },
  };
  report('bench-pages', result);

  expect(kept.statuses).toEqual({ 200: REQUESTS });
  expect(keptBrotli.statuses).toEqual({ 200: REQUESTS });
  expect(held.statuses).toEqual({ 304: REQUESTS });
  expect(held.bytesPerResponse).toBe(0);
  expect(missing.statuses).toEqual({ 404: REQUESTS });
  expect(rendered.statuses).toEqual({ 200: REQUESTS });
  expect(keptBrotli.bytesPerResponse).toBeLessThan(kept.bytesPerResponse / 5);
});
