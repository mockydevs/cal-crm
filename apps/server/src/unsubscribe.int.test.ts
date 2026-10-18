import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { allowEveryone } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { createUnsubscribeLink, queueOutboundMessage } from '@repo/module-messaging';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { apiRoutes } from './api-routes.js';
import { buildServer, type Server } from './server.js';
import { loggerOptions } from './logger.js';

let database: TestDatabase;
let db: Database;
let server: Server;
const logs: string[] = [];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  server = await buildServer({
    config: {
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
      devTenantContext: undefined,
      publicUrl: 'https://crm.example.test',
      authentication: undefined,
      trustProxy: [],
      mail: undefined,
      files: undefined,
      vault: undefined,
    },
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
    routes: apiRoutes(),
    services: { db, authorize: allowEveryone },
    readinessChecks: {},
  });
});

it('serves the approved Lexend font locally without sign-in or a third-party font request', async () => {
  const response = await server.app.inject({
    method: 'GET',
    url: '/unsubscribe/fonts/lexend-latin.woff2',
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('font/woff2');
  expect(response.rawPayload.subarray(0, 4).toString('ascii')).toBe('wOF2');
  expect(response.headers['set-cookie']).toBeUndefined();
  const page = await server.app.inject({ method: 'GET', url: '/unsubscribe/' + 'A'.repeat(43) });
  expect(page.headers['content-security-policy']).toContain("font-src 'self'");
  expect(page.body).not.toContain('fonts.googleapis.com');
});

it('accepts multipart one-click bodies, and rejects malformed, duplicate, extra, file, JSON and oversized bodies', async () => {
  const f = await fixture();
  const multipart =
    '--test-boundary\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--test-boundary--\r\n';
  const cases = [
    { type: 'application/x-www-form-urlencoded', body: '', status: 400 },
    { type: 'application/x-www-form-urlencoded', body: 'List-Unsubscribe=wrong', status: 400 },
    {
      type: 'application/x-www-form-urlencoded',
      body: 'List-Unsubscribe=One-Click&List-Unsubscribe=One-Click',
      status: 400,
    },
    {
      type: 'application/x-www-form-urlencoded',
      body: 'List-Unsubscribe=One-Click&businessId=foreign',
      status: 400,
    },
    {
      type: 'application/x-www-form-urlencoded',
      body: 'List-Unsubscribe=One-Click' + 'x'.repeat(4096),
      status: 413,
    },
    { type: 'application/json', body: '{"List-Unsubscribe":"One-Click"}', status: 415 },
    { type: 'multipart/form-data', body: multipart, status: 400 },
    { type: 'multipart/form-data; boundary=test-boundary', body: 'malformed', status: 400 },
    {
      type: 'application/x-www-form-urlencoded',
      body: 'List-Unsubscribe=' + 'x'.repeat(64),
      status: 400,
    },
    { type: 'application/x-www-form-urlencoded', body: 'x'.repeat(96) + '=One-Click', status: 400 },
    {
      type: 'multipart/form-data; boundary=test-boundary',
      body: multipart.replace(
        '--test-boundary--',
        '--test-boundary\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--test-boundary\r\nContent-Disposition: form-data; name="extra"\r\n\r\nignored\r\n--test-boundary--',
      ),
      status: 400,
    },
    {
      type: 'multipart/form-data; boundary=test-boundary',
      body: multipart.replace(
        'name="List-Unsubscribe"',
        'name="List-Unsubscribe"; filename="field.txt"',
      ),
      status: 400,
    },
  ];
  for (const input of cases) {
    const response = await server.app.inject({
      method: 'POST',
      url: f.path,
      headers: { 'content-type': input.type },
      payload: input.body,
    });
    expect(response.statusCode, input.type + input.body.slice(0, 80)).toBe(input.status);
    expect(response.headers.location).toBeUndefined();
    expect(await f.withdrawals()).toEqual([]);
  }
  const accepted = await server.app.inject({
    method: 'POST',
    url: f.path,
    headers: {
      'content-type': 'multipart/form-data; boundary=test-boundary',
      authorization: 'Bearer invalid',
      cookie: 'irrelevant=1',
      'business-id': randomUUID(),
      origin: 'https://mail-provider.example.test',
    },
    payload: multipart,
  });
  expect(accepted.statusCode).toBe(200);
  expect(await f.withdrawals()).toHaveLength(1);
  const repeated = await server.app.inject({
    method: 'POST',
    url: f.path,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'List-Unsubscribe=One-Click',
  });
  expect(repeated.statusCode).toBe(200);
  expect(await f.withdrawals()).toHaveLength(1);
});

it('never exposes capability URLs in request logs or errors, including unmatched and oversized paths', async () => {
  const f = await fixture();
  logs.length = 0;
  const token = f.path.split('/').at(-1) ?? '';
  const paths = [
    f.path,
    '/unsubscribe/' + 'A'.repeat(43),
    '/unsubscribe/' + token.repeat(5),
    f.path + '/extra',
    f.path + '/%invalid',
  ];
  for (const path of paths) {
    const response = await server.app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain('A'.repeat(43));
    expect(response.headers.location).toBeUndefined();
  }
  const encoded = logs.join('');
  expect(encoded).not.toContain(token);
  expect(encoded).not.toContain('A'.repeat(43));
  expect(encoded).toContain('request completed');
  expect(encoded).toContain('reqId');
  expect(await f.withdrawals()).toEqual([]);
});
afterAll(async () => {
  await server.close(1000);
  await db.destroy();
  await database.close();
});

async function fixture() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const context = { ...business.context, correlationId: randomUUID() };
  const contact = await database.fixtures.contact(context, { email: 'reader@example.test' });
  const link = await withTenant(db, context, async (trx) => {
    const account = await trx
      .insertInto('messaging.channel_accounts')
      .values({ business_id: business.id, channel: 'email', name: 'Public unsubscribe fixture' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('messaging.consents')
      .values({
        business_id: business.id,
        contact_id: contact.id,
        channel: 'email',
        purpose: 'marketing',
        status: 'granted',
        source: 'user',
        recorded_by_kind: 'system',
      })
      .execute();
    const identity = await trx
      .selectFrom('crm.contact_identities')
      .select('id')
      .where('contact_id', '=', contact.id)
      .executeTakeFirstOrThrow();
    const messageId = await queueOutboundMessage(trx, context, {
      identityId: identity.id,
      accountId: account.id,
      channel: 'email',
      purpose: 'marketing',
      lane: 'campaign',
      idempotencyKey: randomUUID(),
      subject: 'Fixture',
      text: 'Fixture',
    });
    return createUnsubscribeLink(trx, context, messageId, 'https://crm.example.test');
  });
  const withdrawals = () =>
    withTenant(db, context, (trx) =>
      trx
        .selectFrom('messaging.consents')
        .select(['contact_id', 'channel', 'purpose', 'source'])
        .where('status', '=', 'withdrawn')
        .execute(),
    );
  return { path: new URL(link).pathname, contact, withdrawals };
}

it('GET and HEAD only confirm; anonymous form POST withdraws without redirect or weakening API auth', async () => {
  const f = await fixture();
  const get = await server.app.inject({ method: 'GET', url: f.path });
  expect(get.statusCode).toBe(200);
  expect(get.headers['content-type']).toContain('text/html');
  expect(get.body).toContain('Unsubscribe from marketing emails');
  expect(get.body).toContain('name="List-Unsubscribe" value="One-Click"');
  expect(get.headers['referrer-policy']).toBe('no-referrer');
  expect(get.headers['cache-control']).toBe('no-store');
  expect(get.headers['content-security-policy']).toContain("form-action 'self'");
  expect(get.body).not.toContain('reader@example.test');
  const head = await server.app.inject({ method: 'HEAD', url: f.path });
  expect(head.statusCode).toBe(200);
  expect(head.body).toBe('');
  expect(await f.withdrawals()).toEqual([]);
  const post = await server.app.inject({
    method: 'POST',
    url: f.path,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'List-Unsubscribe=One-Click',
  });
  expect(post.statusCode).toBe(200);
  expect(post.headers.location).toBeUndefined();
  expect(post.headers['set-cookie']).toBeUndefined();
  expect(post.body).toContain('You are unsubscribed');
  expect(await f.withdrawals()).toEqual([
    {
      contact_id: f.contact.id,
      channel: 'email',
      purpose: 'marketing',
      source: 'unsubscribe_link',
    },
  ]);
  const protectedRoute = await server.app.inject({ method: 'GET', url: '/api/v1/contacts' });
  expect(protectedRoute.statusCode).toBe(401);
});

it('refuses malformed and unknown capabilities without exposing a recipient', async () => {
  const f = await fixture();
  const malformed = await server.app.inject({ method: 'GET', url: '/unsubscribe/bad-link' });
  expect(malformed.statusCode).toBe(404);
  expect(malformed.body).toContain('This link cannot be used');
  expect(malformed.body).not.toContain('<form');
  for (const token of ['bad-link', 'A'.repeat(43)]) {
    const response = await server.app.inject({
      method: 'POST',
      url: '/unsubscribe/' + token,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('This link cannot be used');
  }
  expect(await f.withdrawals()).toEqual([]);
});

it('shows a safe retry page on a database refusal without claiming withdrawal', async () => {
  const f = await fixture();
  await database.as('crm_owner', (sql) =>
    sql.query('revoke execute on function private.unsubscribe_scope(text) from crm_app'),
  );
  try {
    const response = await server.app.inject({
      method: 'POST',
      url: f.path,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('Could not update your preference');
    expect(response.body).toContain('name="List-Unsubscribe" value="One-Click"');
    expect(response.body).not.toContain('unsubscribe_scope');
    expect(response.body).not.toContain(f.path);
    expect(await f.withdrawals()).toEqual([]);
  } finally {
    await database.as('crm_owner', (sql) =>
      sql.query('grant execute on function private.unsubscribe_scope(text) to crm_app'),
    );
  }
});
