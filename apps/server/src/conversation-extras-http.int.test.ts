// Snippets, trigger links and the manual actions queue over HTTP, and the public address a
// trigger link is opened at: where it sends the browser, what it does with a token nobody
// issued, how it is limited, and that the token never reaches a log.
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { allowEveryone } from '@repo/commands';
import {
  manualActionList,
  problem,
  renderedSnippet,
  snippet,
  snippetFolder,
  snippetList,
  triggerLink,
  triggerLinkClickList,
  triggerLinkList,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { openTriggerLink } from '@repo/module-messaging';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { apiRoutes } from './api-routes.js';
import type { Config, DevTenantContext } from './config.js';
import { loggerOptions } from './logger.js';
import type { PublicBookingRateLimit } from './public-booking.js';
import { createPublicIntakeLimit, databaseAdmission } from './public-intake-limit.js';
import { redactedRequestUrl } from './sensitive-paths.js';
import { buildServer, type Server } from './server.js';

const PUBLIC_URL = 'https://crm.example.test';
const SECRET = 'test-only-public-intake-secret-0123456789';

let database: TestDatabase;
let db: Database;
const servers: Server[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * The server as someone signed in to a business of their own reaches it, with the public
 * address of trigger links mounted as start() mounts it.
 */
async function world(
  options: {
    rateLimit?: PublicBookingRateLimit;
    /** Stands in for the database being down when a link is opened. */
    failing?: boolean;
  } = {},
) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const signedIn: Required<DevTenantContext> = {
    agencyId: agency.id,
    businessId: business.id,
    userId: user.id,
  };
  const config: Config = {
    nodeEnv: 'test',
    role: 'app',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: undefined,
    databasePoolSize: 2,
    shutdownTimeoutMs: 1000,
    dashboardDir: undefined,
    devTenantContext: signedIn,
    publicUrl: PUBLIC_URL,
    authentication: undefined,
    trustProxy: [],
    mail: undefined,
    files: undefined,
    vault: undefined,
  };
  const logs: string[] = [];
  const opened: string[] = [];
  const server = await buildServer({
    config,
    logger: pino(
      loggerOptions({ logLevel: 'info' }),
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          logs.push(chunk.toString());
          done();
        },
      }),
    ),
    serveApi: true,
    routes: apiRoutes(undefined, undefined, false, PUBLIC_URL),
    services: { db, authorize: allowEveryone },
    triggerLinks: {
      open: (token, requestId) => {
        opened.push(token);
        if (options.failing === true)
          return Promise.reject(new Error(`connection refused while reading ${token}`));
        return openTriggerLink(db, token, requestId);
      },
      rateLimit: options.rateLimit,
    },
    readinessChecks: {},
  });
  servers.push(server);
  const call = async (method: Method, path: string, payload?: object) => {
    const response = await server.app.inject({
      method,
      url: `/api/v1${path}`,
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      body: response.body,
      json: response.body === '' ? undefined : response.json<unknown>(),
    };
  };
  const contact = await database.fixtures.contact(business.context, { firstName: 'Ada' });
  /** A link, and the address a snippet that carries it becomes for the contact. */
  const sent = async (url = 'https://harbor.example/offer?utm=spring&next=/thanks') => {
    const madeLink = await call('POST', '/trigger-links', { name: 'Spring offer', url });
    expect(madeLink.status, madeLink.body).toBe(201);
    const link = triggerLink.parse(madeLink.json);
    const madeSnippet = await call('POST', '/snippets', {
      type: 'text',
      name: 'Offer',
      body: `Hi {{contact.firstName}}: {{${link.mergeKey}}}`,
    });
    expect(madeSnippet.status, madeSnippet.body).toBe(201);
    const rendered = await call('POST', `/snippets/${snippet.parse(madeSnippet.json).id}/render`, {
      contactId: toPublicId('contact', contact.id),
    });
    expect(rendered.status, rendered.body).toBe(200);
    const text = renderedSnippet.parse(rendered.json);
    const address = text.ok ? (text.body.split(': ').at(-1) ?? '') : '';
    return { link, url, address, path: address.slice(PUBLIC_URL.length), text };
  };
  return {
    app: server.app,
    business,
    contact,
    call,
    sent,
    logs,
    opened,
    open: (path: string, method: Method = 'GET') => server.app.inject({ method, url: path }),
    clicks: () =>
      database.withTenant(business.context, async (sql) =>
        Number(
          (await sql.one<{ n: string }>(`select count(*) as n from messaging.trigger_link_clicks`))
            .n,
        ),
      ),
  };
}

describe('a trigger link’s public address', () => {
  it('sends the browser to the stored address, records who clicked, and shows it under Analyze', async () => {
    const w = await world();
    const { link, url, address, path, text } = await w.sent();
    expect(text).toMatchObject({ ok: true, type: 'text', subject: null });
    expect(address).toMatch(/^https:\/\/crm\.example\.test\/l\/[A-Za-z0-9_-]{43}$/);

    const response = await w.open(path);
    expect(response.statusCode).toBe(302);
    // Exactly what the member wrote down: nothing added, encoded again or taken away.
    expect(response.headers.location).toBe(url);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(response.headers['set-cookie']).toBeUndefined();

    const analyzed = await w.call('GET', `/trigger-links/${link.id}/clicks`);
    expect(analyzed.status, analyzed.body).toBe(200);
    expect(triggerLinkClickList.parse(analyzed.json)).toMatchObject({
      clicks: 1,
      contacts: 1,
      next: null,
      items: [
        { contact: { id: toPublicId('contact', w.contact.id), name: 'Ada', trashed: false } },
      ],
    });
    const listed = triggerLinkList.parse((await w.call('GET', '/trigger-links?q=spring')).json);
    expect(listed).toMatchObject({ total: 1, canManage: true, items: [{ clicks: 1 }] });
    // On the contact's timeline.
    const timeline = await w.call(
      'GET',
      `/records/${toPublicId('contact', w.contact.id)}/activity`,
    );
    expect(timeline.status, timeline.body).toBe(200);
    expect(timeline.body).toContain('trigger_link.clicked');
  });

  it('goes only where the link says, whatever the request adds', async () => {
    const w = await world();
    const { url, path } = await w.sent();
    for (const extra of [
      '?url=https://evil.example/',
      '?next=//evil.example&redirect=https://evil.example',
      '?to=javascript:alert(1)',
    ]) {
      const response = await w.open(`${path}${extra}`);
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(url);
    }
    const hostile = await w.app.inject({
      method: 'GET',
      url: path,
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        referer: 'https://evil.example/',
      },
    });
    expect(hostile.headers.location).toBe(url);
  });

  it('answers a token nobody issued, and anything that is not a token, with the same 404', async () => {
    const w = await world();
    const { path } = await w.sent();
    const unknown = await w.open(`/l/${'A'.repeat(43)}`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers.location).toBeUndefined();
    expect(unknown.headers['content-type']).toContain('text/plain');
    expect(unknown.body).toBe('This link cannot be used.');
    for (const bad of ['/l/short', `${path}x`, `${path}/more`, '/l/', '/l/%2e%2e%2fapi']) {
      const response = await w.open(bad);
      expect(response.statusCode, bad).toBe(404);
      expect(response.body, bad).toBe(unknown.body);
      expect(response.headers.location).toBeUndefined();
    }
    // Only a GET opens a link.
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const response = await w.open(path, method);
      expect(response.statusCode).toBe(404);
      expect(response.headers.location).toBeUndefined();
    }
    expect(await w.clicks()).toBe(0);
  });

  it('stops working when the link is deleted', async () => {
    const w = await world();
    const { link, path } = await w.sent();
    expect((await w.call('DELETE', `/trigger-links/${link.id}`)).status).toBe(204);
    const response = await w.open(path);
    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
  });

  it('keeps the token out of the log, and off any error it answers with', async () => {
    const w = await world();
    const { path } = await w.sent();
    const token = path.slice('/l/'.length);
    await w.open(path);
    await w.open(`${path}x`);
    await w.open(`/l/${'B'.repeat(43)}`);
    const logged = w.logs.join('');
    expect(logged).toContain('/l/[redacted]');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain('B'.repeat(43));
    expect(redactedRequestUrl(path)).toBe('/l/[redacted]');
    expect(redactedRequestUrl('/l')).toBe('/l/[redacted]');
    // Paths that only start with the same letter are not a link's.
    expect(redactedRequestUrl('/login')).toBe('/login');
    expect(redactedRequestUrl('/leads/1')).toBe('/leads/1');
  });

  it('answers a plain 500 when the click cannot be recorded, and says nothing of why', async () => {
    const w = await world({ failing: true });
    const token = 'C'.repeat(43);
    const response = await w.open(`/l/${token}`);
    expect(response.statusCode).toBe(500);
    expect(response.headers.location).toBeUndefined();
    expect(response.body).toBe('This link could not be opened. Try again later.');
    expect(w.logs.join('')).not.toContain(token);
    expect(w.logs.join('')).not.toContain('connection refused');
  });

  it('is held to the shared public limit: ten a minute for one address, then 429 and nothing opened', async () => {
    const w = await world({
      rateLimit: createPublicIntakeLimit({ admit: databaseAdmission(db), secret: SECRET }),
    });
    const { path } = await w.sent();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1)
      statuses.push((await w.open(path)).statusCode);
    expect(statuses).toEqual([...Array.from({ length: 10 }, () => 302), 429, 429]);
    const refused = await w.open(path);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(refused.headers.location).toBeUndefined();
    // A refused request never reached the link.
    expect(w.opened).toHaveLength(10);
    expect(await w.clicks()).toBe(1);
  });

  it('answers 503, opening nothing, when the limiter cannot decide', async () => {
    const w = await world({ rateLimit: () => Promise.reject(new Error('limiter down')) });
    const { path } = await w.sent();
    const response = await w.open(path);
    expect(response.statusCode).toBe(503);
    expect(response.headers.location).toBeUndefined();
    expect(w.opened).toEqual([]);
    const invalid = await world({
      rateLimit: () => Promise.resolve({ allowed: false, retryAfterSeconds: 0 }),
    });
    expect((await invalid.open((await invalid.sent()).path)).statusCode).toBe(503);
  });
});

describe('snippets over HTTP', () => {
  it('serve folders, snippets in them and the paged list, each answer as its contract says', async () => {
    const w = await world();
    const madeFolder = await w.call('POST', '/snippet-folders', { name: 'Follow-ups' });
    expect(madeFolder.status, madeFolder.body).toBe(201);
    const folder = snippetFolder.parse(madeFolder.json);
    const made = await w.call('POST', '/snippets', {
      type: 'email',
      name: 'Quote',
      subject: 'Your quote, {{contact.firstName}}',
      body: 'Hello {{contact.firstName}}',
      folderId: folder.id,
    });
    expect(made.status, made.body).toBe(201);
    const saved = snippet.parse(made.json);
    const listed = await w.call('GET', `/snippets?type=email&folder=${folder.id}&limit=1`);
    expect(snippetList.parse(listed.json)).toMatchObject({
      total: 1,
      next: null,
      canManage: true,
      items: [
        { id: saved.id, bodyPreview: 'Hello {{contact.firstName}}', folderName: 'Follow-ups' },
      ],
    });
    const rendered = await w.call('POST', `/snippets/${saved.id}/render`, {
      contactId: toPublicId('contact', w.contact.id),
    });
    expect(renderedSnippet.parse(rendered.json)).toEqual({
      ok: true,
      type: 'email',
      subject: 'Your quote, Ada',
      body: 'Hello Ada',
    });
    const stale = await w.call('PUT', `/snippets/${saved.id}`, {
      name: 'Quote',
      subject: 'S',
      body: 'B',
      folderId: null,
      revision: 'f'.repeat(64),
    });
    expect(stale.status).toBe(409);
    const taken = await w.call('POST', '/snippets', { type: 'text', name: 'quote', body: 'x' });
    expect(taken.status).toBe(422);
    expect(problem.parse(taken.json).errors).toMatchObject([{ path: '/name', code: 'taken' }]);
    expect((await w.call('DELETE', `/snippet-folders/${folder.id}`)).status).toBe(204);
    expect(snippet.parse((await w.call('GET', `/snippets/${saved.id}`)).json).folderId).toBeNull();
    expect((await w.call('DELETE', `/snippets/${saved.id}`)).status).toBe(204);
    expect((await w.call('GET', `/snippets/${saved.id}`)).status).toBe(404);
    expect((await w.call('GET', `/snippets/tmpl_${saved.id.slice(5)}`)).status).toBe(422);
  });

  it('refuse a link address that is not a plain web address', async () => {
    const w = await world();
    for (const url of [
      'javascript:alert(1)',
      '//evil.example',
      'https://x.example/{{contact.email}}',
    ]) {
      const refused = await w.call('POST', '/trigger-links', { name: 'Bad', url });
      expect(refused.status, url).toBe(422);
    }
  });
});

describe('the manual actions queue over HTTP', () => {
  it('answers an empty queue as its contract says, and an action that is not there with 404', async () => {
    const w = await world();
    const listed = await w.call('GET', '/manual-actions?status=all&assignee=me&type=call');
    expect(listed.status, listed.body).toBe(200);
    expect(manualActionList.parse(listed.json)).toEqual({
      items: [],
      total: 0,
      next: null,
      canWork: true,
      canAssign: true,
    });
    const missing = toPublicId('manual_action', randomUUID7());
    expect((await w.call('GET', `/manual-actions/${missing}`)).status).toBe(404);
    const closed = await w.call('POST', `/manual-actions/${missing}/complete`, {
      revision: 'f'.repeat(64),
    });
    expect(closed.status).toBe(404);
    expect((await w.call('GET', '/manual-actions?limit=101')).status).toBe(422);
  });
});

/** A UUIDv7 nothing has: the version and variant bits set on a random UUID. */
function randomUUID7(): string {
  const raw = randomUUID().replaceAll('-', '');
  const hex = `${raw.slice(0, 12)}7${raw.slice(13, 16)}8${raw.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
