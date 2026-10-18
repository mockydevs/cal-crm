// Sites, stage 1A, through the production start, over real HTTP, on real Postgres with the
// real shared limiter: a person publishes a page through the API and a visitor opens it at
// the install's own address; what a visitor never gets; and the preview of a draft.
import { randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation } from '@repo/commands';
import {
  EMPTY_PAGE_DOCUMENT,
  site as siteContract,
  sitePage,
  sitePagePreview,
  sitePageVersionList,
  sitePublicStatus,
  siteStep,
  type PageDocument,
  type Site,
  type SitePage,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { createSiteRoutes } from '@repo/module-sites';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { apiRoutes } from './api-routes.js';
import type { Config } from './config.js';
import { NOT_FOUND_PAGE } from './public-sites.js';
import { start, type Running } from './start.js';

const PUBLIC_URL = 'https://crm.example.test';
const SECRET = 'sites-http-fixture-key-with-at-least-32-bytes';

let database: TestDatabase;
let db: Database;
let app: Running;
let signedIn: { agencyId: string; businessId: string; userId: string };
let config: Config;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user({ name: 'Dana Brooks' });
  signedIn = { agencyId: agency.id, businessId: business.id, userId: user.id };
  config = {
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
    // Every API request below is this one person in this one business.
    devTenantContext: signedIn,
    publicUrl: PUBLIC_URL,
    publicIntake: { secret: SECRET },
    authentication: undefined,
    mail: undefined,
    // Each visitor below is a client of its own to the limiter, named by this test as a
    // proxy in front of the server would name them.
    trustProxy: ['loopback'],
    files: undefined,
    vault: undefined,
  };
  app = await start(config, apiRoutes, []);
});
afterAll(async () => {
  await app.stop();
  await db.destroy();
  await database.close();
});

let visitors = 0;
/** A visitor's browser, at an address of its own. */
function visitor(server: Running = app) {
  const address = `198.51.100.${String((visitors += 1))}`;
  return (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${server.address}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { 'x-forwarded-for': address, ...(init.headers as Record<string, string>) },
    });
}

/** The signed-in API, over HTTP, as the dashboard calls it. */
async function api<T>(
  parse: { parse: (value: unknown) => T },
  method: string,
  path: string,
  body?: unknown,
  server: Running = app,
): Promise<T> {
  const response = await fetch(`${server.address}/api/v1${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${String(response.status)} ${text}`);
  return parse.parse(JSON.parse(text));
}

const pageSaying = (text: string): PageDocument => ({
  ...EMPTY_PAGE_DOCUMENT,
  sections: [
    {
      id: 'top',
      type: 'section',
      props: { width: 'medium' },
      rows: [
        {
          id: 'row',
          type: 'row',
          columns: [
            {
              id: 'col',
              type: 'column',
              props: { span: 12 },
              children: [{ id: 'title', type: 'headline', props: { text: [{ text }], level: 1 } }],
            },
          ],
        },
      ],
    },
  ],
});

/** A funnel with one step, its page saved with these words. */
async function funnel(words: string, server: Running = app) {
  const made = await api(
    siteContract,
    'POST',
    '/sites',
    { kind: 'funnel', name: `Spring ${randomUUID().slice(0, 8)}` },
    server,
  );
  const step = await api(
    siteStep,
    'POST',
    `/sites/${made.id}/steps`,
    { name: 'Landing', path: 'landing' },
    server,
  );
  const pageId = step.pages[0]?.id ?? '';
  const empty = await api(sitePage, 'GET', `/site-pages/${pageId}`, undefined, server);
  const saved = await api(
    sitePage,
    'PUT',
    `/site-pages/${pageId}/draft`,
    { baseVersion: empty.currentVersion, document: pageSaying(words) },
    server,
  );
  const site: Site = await api(siteContract, 'GET', `/sites/${made.id}`, undefined, server);
  return { site, key: site.publicKey ?? '', page: saved };
}
const publish = (page: SitePage, server: Running = app) =>
  api(sitePage, 'POST', `/site-pages/${page.id}/publish`, { revision: page.revision }, server);

it('publishes a page through the API and serves it at the install’s own address', async () => {
  const { site, key, page } = await funnel('Welcome to spring');
  const open = visitor();
  expect(site.liveUrl).toBeNull();
  const before = await open(`/s/${key}/landing`);
  expect(before.status).toBe(404);
  expect(await before.text()).toBe(NOT_FOUND_PAGE);

  const published = await publish(page);
  expect(published.liveUrl).toBe(`${PUBLIC_URL}/s/${key}/landing`);
  expect((await api(siteContract, 'GET', `/sites/${site.id}`)).liveUrl).toBe(
    `${PUBLIC_URL}/s/${key}`,
  );

  const live = await open(`/s/${key}/landing`);
  expect(live.status).toBe(200);
  const html = await live.text();
  expect(html).toContain('>Welcome to spring</h1>');
  expect(html).toContain(`<link rel="canonical" href="${PUBLIC_URL}/s/${key}/landing">`);
  expect(html).not.toContain('<script');
  expect(live.headers.get('content-type')).toBe('text/html; charset=utf-8');
  // Asked about before every use, and never rewritten on the way: the policy is exact.
  expect(live.headers.get('cache-control')).toBe(
    'public, max-age=0, must-revalidate, no-transform',
  );
  expect(live.headers.get('x-content-type-options')).toBe('nosniff');
  expect(live.headers.get('x-robots-tag')).toBe('noindex');
  expect(live.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(live.headers.get('set-cookie')).toBeNull();
  const policy = live.headers.get('content-security-policy') ?? '';
  expect(policy).toMatch(
    /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/]{43}='; img-src 'self' https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/,
  );
  // The page's one stylesheet is the one the policy names.
  const css = /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? '';
  const digest = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(css)),
  ).toString('base64');
  expect(policy).toContain(`'sha256-${digest}'`);

  // The site's own address is the funnel's first step.
  const home = await open(`/s/${key}`);
  expect(home.status).toBe(200);
  expect(home.headers.get('etag')).toBe(live.headers.get('etag'));

  // The same bytes are not sent twice to someone who holds them.
  const etag = live.headers.get('etag') ?? '';
  // This visitor's browser takes gzip, so the tag is the one of the page in that coding.
  expect(live.headers.get('content-encoding')).toBe('gzip');
  expect(live.headers.get('vary')).toBe('Accept-Encoding');
  expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}\.gz"$/);
  const again = await open(`/s/${key}/landing`, { headers: { 'if-none-match': etag } });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe('');
  const head = await open(`/s/${key}/landing`, { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.headers.get('etag')).toBe(etag);
  // As the page itself would be sent: the same coding, and the length of those bytes.
  expect(head.headers.get('content-encoding')).toBe('gzip');
  expect(Number(head.headers.get('content-length'))).toBeLessThan(Buffer.byteLength(html));
  const plain = await open(`/s/${key}/landing`, {
    method: 'HEAD',
    headers: { 'accept-encoding': 'identity' },
  });
  expect(plain.headers.get('content-length')).toBe(String(Buffer.byteLength(html)));
  expect(plain.headers.get('etag')).toBe(etag.replace('.gz', ''));
  expect(await head.text()).toBe('');
});

it('never serves a draft, and takes a page off the web when it is unpublished or deleted', async () => {
  const { site, key, page } = await funnel('The live words');
  const open = visitor();
  const published = await publish(page);
  const first = await open(`/s/${key}/landing`);
  const etag = first.headers.get('etag') ?? '';

  const edited = await api(sitePage, 'PUT', `/site-pages/${page.id}/draft`, {
    baseVersion: published.currentVersion,
    document: pageSaying('Words nobody should see yet'),
  });
  const unchanged = await open(`/s/${key}/landing`, { headers: { 'if-none-match': etag } });
  expect(unchanged.status).toBe(304);
  expect(await (await open(`/s/${key}/landing`)).text()).not.toContain('nobody should see');

  await publish(edited);
  const changed = await open(`/s/${key}/landing`, { headers: { 'if-none-match': etag } });
  expect(changed.status).toBe(200);
  expect(await changed.text()).toContain('Words nobody should see yet');

  const current = await api(sitePage, 'GET', `/site-pages/${page.id}`);
  const off = await api(sitePage, 'POST', `/site-pages/${page.id}/unpublish`, {
    revision: current.revision,
  });
  expect(off.liveUrl).toBeNull();
  for (const path of [`/s/${key}/landing`, `/s/${key}`]) {
    const gone = await open(path, { headers: { 'if-none-match': etag } });
    expect(gone.status).toBe(404);
    expect(gone.headers.get('cache-control')).toBe('no-store');
    expect(await gone.text()).toBe(NOT_FOUND_PAGE);
  }

  await publish(off);
  expect((await open(`/s/${key}/landing`)).status).toBe(200);
  const deleted = await fetch(`${app.address}/api/v1/sites/${site.id}`, { method: 'DELETE' });
  expect(deleted.status).toBe(204);
  expect((await open(`/s/${key}/landing`)).status).toBe(404);
});

it('refuses to publish a page with a blocking problem, in sentences, with 422', async () => {
  const made = await api(siteContract, 'POST', '/sites', { kind: 'funnel', name: 'Empty one' });
  const step = await api(siteStep, 'POST', `/sites/${made.id}/steps`, {
    name: 'Landing',
    path: 'landing',
  });
  const empty = await api(sitePage, 'GET', `/site-pages/${step.pages[0]?.id ?? ''}`);
  expect(empty.problems).toEqual([expect.objectContaining({ code: 'empty_page', blocking: true })]);
  const response = await fetch(`${app.address}/api/v1/site-pages/${empty.id}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ revision: empty.revision }),
  });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({
    errors: [
      {
        code: 'empty_page',
        message: 'This page is empty. Add a section with some content before publishing.',
      },
    ],
  });
  expect((await visitor()(`/s/${made.publicKey ?? ''}/landing`)).status).toBe(404);
});

it('keeps one business’s site apart from another’s, by key and by id', async () => {
  const mine = await funnel('Only mine');
  await publish(mine.page);
  // Another business of another agency, with a site of its own, made through the module's
  // routes as the server makes them.
  const agency = await database.fixtures.agency();
  const other = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user({ name: 'Sam Reyes' });
  const invocation: Invocation = {
    context: {
      ...other.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  const routes = createSiteRoutes({ publicUrl: PUBLIC_URL, previewSecret: SECRET });
  const run = (operationId: string, request: { params?: unknown; body?: unknown }) => {
    const route = routes.find((each) => each.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`No route for ${operationId}.`);
    return route.run(
      { invocation, params: request.params ?? {}, query: {}, body: request.body },
      { db, authorize: allowEveryone },
    );
  };
  const theirs = siteContract.parse(
    await run('createSite', { body: { kind: 'funnel', name: 'Theirs' } }),
  );
  const step = siteStep.parse(
    await run('createSiteStep', {
      params: { id: theirs.id },
      body: { name: 'Landing', path: 'landing' },
    }),
  );
  const pageId = step.pages[0]?.id ?? '';
  const saved = sitePage.parse(
    await run('saveSitePageDraft', {
      params: { id: pageId },
      body: { baseVersion: 1, document: pageSaying('Only theirs') },
    }),
  );
  await run('publishSitePage', { params: { id: pageId }, body: { revision: saved.revision } });
  const theirKey = siteContract.parse(
    await run('getSite', { params: { id: theirs.id } }),
  ).publicKey;

  const open = visitor();
  expect(await (await open(`/s/${mine.key}/landing`)).text()).toContain('Only mine');
  const shown = await (await open(`/s/${theirKey ?? ''}/landing`)).text();
  expect(shown).toContain('Only theirs');
  expect(shown).not.toContain('Only mine');
  // The signed-in person cannot read, publish or preview the other business's page.
  for (const [method, path, body] of [
    ['GET', `/site-pages/${pageId}`, undefined],
    ['GET', `/site-pages/${pageId}/preview`, undefined],
    ['POST', `/site-pages/${pageId}/publish`, { revision: 1 }],
    ['POST', `/site-pages/${pageId}/unpublish`, { revision: 1 }],
    ['GET', `/sites/${theirs.id}`, undefined],
  ] as const) {
    const response = await fetch(`${app.address}/api/v1${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status).toBe(404);
  }
  expect((await open(`/s/${theirKey ?? ''}/landing`)).status).toBe(200);
});

it('previews a draft through a link that is never stored, and only while the link is good', async () => {
  const { key, page } = await funnel('A draft in progress');
  const open = visitor();
  const preview = await api(sitePagePreview, 'GET', `/site-pages/${page.id}/preview`);
  expect(preview.url.startsWith(`${PUBLIC_URL}/s/_preview/`)).toBe(true);
  expect(Date.parse(preview.expiresAt)).toBeGreaterThan(Date.now() + 55 * 60_000);
  const path = new URL(preview.url).pathname;

  const shown = await open(path);
  expect(shown.status).toBe(200);
  expect(await shown.text()).toContain('A draft in progress');
  expect(shown.headers.get('cache-control')).toBe('no-store, no-transform');
  expect(shown.headers.get('etag')).toBeNull();
  expect(shown.headers.get('x-robots-tag')).toBe('noindex');
  expect(shown.headers.get('referrer-policy')).toBe('no-referrer');
  expect(shown.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  // The draft is still not public.
  expect((await open(`/s/${key}/landing`)).status).toBe(404);

  // A link changed by one character, and one this server did not sign, open nothing.
  const last = path.at(-1) === 'A' ? 'B' : 'A';
  for (const bad of [
    `${path.slice(0, -1)}${last}`,
    `/s/_preview/${'A'.repeat(70)}.${'B'.repeat(22)}`,
  ]) {
    const refused = await open(bad);
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe(NOT_FOUND_PAGE);
  }
});

it('takes only GET and HEAD, and counts every request against the shared limit', async () => {
  const { key, page } = await funnel('Counted');
  await publish(page);
  const open = visitor();
  const posted = await open(`/s/${key}/landing`, { method: 'POST', body: 'a=1' });
  expect(posted.status).toBe(405);

  // The shared limiter takes 120 reads a minute from one address. Its minute may turn over
  // once while this runs, which lets at most 120 more through: so of 250 requests at
  // least ten are refused, and never one of the first 120.
  const statuses: number[] = [];
  let limited: Response | undefined;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const response = await open(`/s/${key}/landing`, { method: 'HEAD' });
    statuses.push(response.status);
    if (response.status === 429) limited = response;
  }
  expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
  expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(10);
  expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  expect(limited?.headers.get('cache-control')).toBe('no-store');
  // Another address is not held back by this one.
  expect((await visitor()(`/s/${key}/landing`)).status).toBe(200);
});

it('serves no page and gives no live address on an install without the public intake secret', async () => {
  const { publicIntake: _left, ...rest } = config;
  const quiet = await start(rest, apiRoutes, []);
  try {
    const { site, key, page } = await funnel('Never public', quiet);
    const published = await publish(page, quiet);
    expect(published.publishedVersion).toBe(2);
    expect(published.liveUrl).toBeNull();
    const read = await api(siteContract, 'GET', `/sites/${site.id}`, undefined, quiet);
    expect(read.liveUrl).toBeNull();
    expect(read.steps[0]?.liveUrl).toBeNull();
    const response = await visitor(quiet)(`/s/${key}/landing`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const preview = await fetch(`${quiet.address}/api/v1/site-pages/${page.id}/preview`);
    expect(preview.status).toBe(409);
    // The same page on the install that does serve public pages is there to be seen.
    expect((await visitor()(`/s/${key}/landing`)).status).toBe(200);
  } finally {
    await quiet.stop();
  }
});

// The server's own time for a page, as ceilings a slow machine still passes (a two-core
// CI runner with Postgres beside it). They are there to fail when a visit starts to cost
// what it must not: a render, or a second's wait. What this machine measures is far below
// them (pnpm --filter @repo/server run bench:pages measures it).
const FIRST_VISIT_CEILING_MS = 3000;
const P95_KEPT_CEILING_MS = 250;
const P95_HELD_CEILING_MS = 250;

it('answers a visit to a page that has not changed within its ceiling, from what it kept', async () => {
  const { key, page } = await funnel('Measured');
  await publish(page);
  const url = `/s/${key}/landing`;
  const timed = async (init: RequestInit = {}) => {
    const started = performance.now();
    const response = await visitor()(url, init);
    const body = await response.arrayBuffer();
    return { response, bytes: body.byteLength, ms: performance.now() - started };
  };
  const p95 = (values: number[]): number =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? Number.NaN;

  // The first visit reads the page's rows and renders it.
  const first = await timed({ headers: { 'accept-encoding': 'identity' } });
  expect(first.response.status).toBe(200);
  expect(first.ms).toBeLessThan(FIRST_VISIT_CEILING_MS);
  const etag = first.response.headers.get('etag') ?? '';
  expect(first.response.headers.get('vary')).toBe('Accept-Encoding');

  // Forty more, each a visitor of their own: the same bytes under the same tag.
  const kept: number[] = [];
  for (let visit = 0; visit < 40; visit += 1) {
    const next = await timed({ headers: { 'accept-encoding': 'identity' } });
    expect(next.response.status).toBe(200);
    expect(next.response.headers.get('etag')).toBe(etag);
    expect(next.bytes).toBe(first.bytes);
    kept.push(next.ms);
  }
  expect(p95(kept)).toBeLessThan(P95_KEPT_CEILING_MS);

  // Forty who hold it already: told so, with no bytes.
  const held: number[] = [];
  for (let visit = 0; visit < 40; visit += 1) {
    const next = await timed({ headers: { 'if-none-match': etag } });
    expect(next.response.status).toBe(304);
    expect(next.bytes).toBe(0);
    held.push(next.ms);
  }
  expect(p95(held)).toBeLessThan(P95_HELD_CEILING_MS);

  // A browser that takes Brotli is sent a fraction of the bytes, under a tag of its own,
  // and a visitor who holds either is told so.
  const small = await visitor()(url, { headers: { 'accept-encoding': 'br' } });
  expect(small.headers.get('content-encoding')).toBe('br');
  expect(small.headers.get('etag')).toBe(`${etag.slice(0, -1)}.br"`);
  expect(await small.text()).toContain('>Measured</h1>');
  const heldSmall = await visitor()(url, {
    headers: { 'if-none-match': small.headers.get('etag') ?? '' },
  });
  expect(heldSmall.status).toBe(304);

  // Publishing again shows on the very next visit: what was kept is not sent.
  const edited = await api(sitePage, 'PUT', `/site-pages/${page.id}/draft`, {
    baseVersion: (await api(sitePage, 'GET', `/site-pages/${page.id}`)).currentVersion,
    document: pageSaying('Measured again'),
  });
  await publish(edited);
  const after = await visitor()(url, { headers: { 'if-none-match': etag } });
  expect(after.status).toBe(200);
  expect(await after.text()).toContain('>Measured again</h1>');
  expect(after.headers.get('etag')).not.toBe(etag);
});

// Sites complete, 2026-10-13 -----------------------------------------------------------------

/** The page of pageSaying with a countdown under its headline, and these popups. */
function withCountdown(text: string, endsAt: string, popups: unknown[] = []): PageDocument {
  const page = pageSaying(text);
  if (page.mode !== 'visual') throw new Error('The fixture is a visual page.');
  const countdown = {
    id: 'cd',
    type: 'countdown',
    props: { endsAt, whenOver: { type: 'text', text: 'The offer has ended.' } },
  };
  const sections = JSON.parse(JSON.stringify(page.sections)) as {
    rows: { columns: { children: unknown[] }[] }[];
  }[];
  sections[0]?.rows[0]?.columns[0]?.children.push(countdown);
  return { ...page, sections, popups } as PageDocument;
}

it('serves a page’s small scripts from its own address, only to pages that hold what they are for', async () => {
  const open = visitor();
  // A page of words: no script, and a policy that allows none.
  const plain = await funnel('Only words');
  await publish(plain.page);
  const words = await open(`/s/${plain.key}/landing`);
  expect(await words.text()).not.toContain('<script');
  expect(words.headers.get('content-security-policy')).not.toContain('script-src');

  // A page with a countdown still running and a popup that opens by itself: both scripts.
  const made = await funnel('Counting down');
  const ends = new Date(Date.now() + 3 * 86_400_000 + 30_000).toISOString();
  const saved = await api(sitePage, 'PUT', `/site-pages/${made.page.id}/draft`, {
    baseVersion: made.page.currentVersion,
    document: withCountdown('Counting down', ends, [
      {
        id: 'offer',
        type: 'popup',
        name: 'Offer',
        props: { trigger: 'exit', delaySeconds: 0, width: 'small', frequency: 'session' },
        rows: [],
      },
    ]),
  });
  // Neither is a problem any more: the countdown ticks and the popup opens.
  expect(saved.problems).toEqual([]);
  await publish(saved);
  const url = `/s/${made.key}/landing`;
  const live = await open(url);
  expect(live.status).toBe(200);
  const html = await live.text();
  const named = [...html.matchAll(/<script defer src="([^"]+)"><\/script>/g)].map(
    ([, src]) => src ?? '',
  );
  expect(named).toHaveLength(2);
  expect(named[0]).toMatch(/^\/s\/_js\/countdown\.[0-9a-f]{16}\.js$/);
  expect(named[1]).toMatch(/^\/s\/_js\/popup\.[0-9a-f]{16}\.js$/);
  expect(html.match(/<script/g)).toHaveLength(2);
  expect(html).toContain('<span role="timer">3d 00h 00m</span> left, ends <time datetime="');
  expect(html).toContain(' data-pt="exit">');
  // Scripts from this address, and nothing they could call.
  const policy = live.headers.get('content-security-policy') ?? '';
  expect(policy).toMatch(/^default-src 'none'; script-src 'self'; style-src 'sha256-/);
  expect(policy).not.toContain('connect-src');
  expect(policy).not.toContain('unsafe');

  // Each script is there, as JavaScript, to be kept for good; its name is its digest.
  for (const src of named) {
    const script = await open(src, { headers: { 'accept-encoding': 'identity' } });
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(script.headers.get('x-content-type-options')).toBe('nosniff');
    expect(script.headers.get('set-cookie')).toBeNull();
    const body = Buffer.from(await script.arrayBuffer());
    expect(body.toString('utf8').startsWith('(function(){')).toBe(true);
    const digest = Buffer.from(await crypto.subtle.digest('SHA-256', body)).toString('hex');
    expect(src).toContain(`.${digest.slice(0, 16)}.js`);
    expect(script.headers.get('etag')).toBe(`"${digest}"`);
    const held = await open(src, { headers: { 'if-none-match': `"${digest}"` } });
    expect(held.status).toBe(304);
  }
  // A script of another release is not there, and says nothing else.
  const old = await open('/s/_js/countdown.0000000000000000.js');
  expect(old.status).toBe(404);
  expect(await old.text()).toBe(NOT_FOUND_PAGE);

  // The page is still validated by its tag: the same within the countdown's minute, and
  // another once the minute has turned.
  const etag = live.headers.get('etag') ?? '';
  const again = await open(url, { headers: { 'if-none-match': etag } });
  expect([200, 304]).toContain(again.status);
  if (again.status === 200) expect(again.headers.get('etag')).not.toBe(etag);
});

it('tells the editor whether public pages are served, and keeps autosaves out of the versions', async () => {
  const status = await api(sitePublicStatus, 'GET', '/site-public-status');
  expect(status).toEqual({
    enabled: true,
    code: 'enabled',
    reason: null,
    baseUrl: `${PUBLIC_URL}/s`,
    scripts: { countdown: true, popup: true },
  });

  const { page } = await funnel('First words');
  let current = page;
  for (let n = 0; n < 12; n += 1)
    current = await api(sitePage, 'PUT', `/site-pages/${page.id}/draft`, {
      baseVersion: current.currentVersion,
      revision: current.revision,
      autosave: true,
      document: pageSaying(`Autosave ${String(n)}`),
    });
  // Version 1 as created, version 2 saved by the fixture, version 3 the working draft.
  expect(current.currentVersion).toBe(3);
  expect(current.autosavedAt).toEqual(expect.any(String));
  const list = await api(sitePageVersionList, 'GET', `/site-pages/${page.id}/versions`);
  expect(list.items.map((each) => [each.number, each.kind])).toEqual([
    [3, 'draft'],
    [2, 'saved'],
    [1, 'saved'],
  ]);
  // A stale revision is refused as a conflict, over HTTP too.
  const stale = await fetch(`${app.address}/api/v1/site-pages/${page.id}/draft`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseVersion: current.currentVersion,
      revision: current.revision - 1,
      autosave: true,
      document: pageSaying('Stale'),
    }),
  });
  expect(stale.status).toBe(409);
  // "Save a version", by name.
  const kept = await api(sitePage, 'PUT', `/site-pages/${page.id}/draft`, {
    baseVersion: current.currentVersion,
    document: pageSaying('Kept'),
    name: 'Before the launch',
  });
  expect(kept).toMatchObject({ currentVersion: 3, autosavedAt: null });
  const after = await api(sitePageVersionList, 'GET', `/site-pages/${page.id}/versions`);
  expect(after.items[0]).toMatchObject({ number: 3, kind: 'saved', name: 'Before the launch' });
});

it('says so before anyone publishes, on an install that serves no public page', async () => {
  const { publicIntake: _off, ...without } = config;
  const quiet = await start(without, apiRoutes, []);
  try {
    const status = await api(sitePublicStatus, 'GET', '/site-public-status', undefined, quiet);
    expect(status).toMatchObject({
      enabled: false,
      code: 'no_public_secret',
      baseUrl: null,
      scripts: { countdown: false, popup: false },
    });
    expect(status.reason).toContain('Public pages are switched off on this install');
    // And no script address answers there.
    const script = await visitor(quiet)('/s/_js/countdown.0000000000000000.js');
    expect(script.status).toBe(404);
  } finally {
    await quiet.stop();
  }
});
