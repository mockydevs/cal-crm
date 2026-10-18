// Web chat through the production start, over real HTTP, on real Postgres with the real
// shared limiter: what an unsigned visitor's browser can reach, and what it never can. A
// widget key of one business reads and writes nothing of another; a visitor's token opens
// that visitor's own chat and no other; and the team's reply, sent through the Inbox's own
// route, reaches the visitor who wrote.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { allowEveryone, type ApiRoute, type Invocation } from '@repo/commands';
import {
  conversation,
  conversationList,
  publicWebchatConfig,
  publicWebchatMessage,
  publicWebchatMessages,
  publicWebchatSession,
  threadMessage,
  webchatWidget,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { createWebchatRoutes } from '@repo/module-messaging';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { apiRoutes } from './api-routes.js';
import type { Config } from './config.js';
import { start, type Running } from './start.js';

const PUBLIC_URL = 'https://crm.example.test';

let database: TestDatabase;
let db: Database;
let app: Running;
let routes: readonly ApiRoute[];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
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
    publicUrl: PUBLIC_URL,
    publicIntake: { secret: 'webchat-http-fixture-key-with-at-least-32-bytes' },
    authentication: undefined,
    mail: undefined,
    // Each visitor below is a client of its own to the limiter, named by this test as a
    // proxy in front of the server would name them.
    trustProxy: ['loopback'],
    files: undefined,
    vault: undefined,
  };
  app = await start(config, apiRoutes, []);
  routes = [...apiRoutes(), ...createWebchatRoutes(PUBLIC_URL)];
});
afterAll(async () => {
  await app.stop();
  await db.destroy();
  await database.close();
});

let clients = 0;
/** A visitor's browser: its own address, and the website it is on. */
function browserOn(origin: string | null, key: string) {
  const address = `203.0.113.${String((clients += 1))}`;
  return async (
    method: 'GET' | 'POST' | 'OPTIONS',
    path: string,
    options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> =>
    fetch(`${app.address}/api/v1/public/webchat/${key}${path}`, {
      method,
      headers: {
        'x-forwarded-for': address,
        ...(origin === null ? {} : { origin }),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
}

/** Runs one of the signed-in API's routes as a member of the business, as the server would. */
async function asTeam(
  invocation: Invocation,
  operationId: string,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
): Promise<unknown> {
  const route = routes.find((each) => each.endpoint.operationId === operationId);
  if (route === undefined) throw new Error(`No route for ${operationId}.`);
  return route.run(
    {
      invocation: {
        ...invocation,
        context: { ...invocation.context, correlationId: randomUUID() },
      },
      params: request.params ?? {},
      query: request.query ?? {},
      body: request.body,
    },
    { db, authorize: allowEveryone },
  );
}

/** A business with one person on its team and a widget made through the admin route. */
async function business(website: string) {
  const agency = await database.fixtures.agency();
  const owner = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user({ name: 'Dana Brooks' });
  const invocation: Invocation = {
    context: {
      ...owner.context,
      actorKind: 'user',
      actorId: user.id,
      userId: user.id,
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };
  const widget = webchatWidget.parse(
    await asTeam(invocation, 'createWebchatWidget', {
      body: {
        name: 'Main site',
        allowedOrigins: [website],
        enabled: true,
        settings: {
          title: 'Chat with us',
          greeting: 'Hello.',
          emailRequired: true,
          marketingConsentWording: null,
        },
      },
    }),
  );
  const rows = <Row extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(owner.context, (sql) => sql.query<Row>(text, values));
  return { id: owner.id, invocation, widget, website, rows };
}
type Business = Awaited<ReturnType<typeof business>>;

/** A visitor on the business's website who started a chat and wrote once. */
async function visitor(b: Business, email: string, text: string) {
  const browser = browserOn(b.website, b.widget.publicKey);
  const started = await browser('POST', '/sessions', {
    body: { name: 'Maya Thompson', email, marketingConsent: false },
  });
  expect(started.status).toBe(201);
  const { token } = publicWebchatSession.parse(await started.json());
  const sent = await browser('POST', '/messages', {
    token,
    body: { clientMessageId: randomUUID(), text },
  });
  expect(sent.status).toBe(200);
  expect(publicWebchatMessage.parse(await sent.json())).toMatchObject({ seq: 1, text });
  const reads = async (): Promise<string[]> => {
    const answer = await browser('GET', '/messages?after=0', { token });
    expect(answer.status).toBe(200);
    return publicWebchatMessages
      .parse(await answer.json())
      .messages.map((each) => `${each.from}: ${each.text}`);
  };
  return { browser, token, reads };
}

it('carries a chat from a website to the Inbox and the reply back, to that visitor alone', async () => {
  const b = await business('https://shop.example');
  const browser = browserOn(b.website, b.widget.publicKey);
  const config = await browser('GET', '');
  expect(config.status).toBe(200);
  expect(config.headers.get('access-control-allow-origin')).toBe('https://shop.example');
  expect(config.headers.get('cache-control')).toBe('no-store');
  expect(publicWebchatConfig.parse(await config.json())).toMatchObject({ title: 'Chat with us' });

  const maya = await visitor(b, 'maya@example.test', 'Do you deliver on Sundays?');
  const sam = await visitor(b, 'sam@example.test', 'Are you open today?');

  // Two conversations in the Inbox, each from someone nobody verified.
  const list = conversationList.parse(await asTeam(b.invocation, 'listConversations'));
  expect(list.items.map((each) => [each.lastMessage?.preview, each.unverified]).sort()).toEqual([
    ['Are you open today?', true],
    ['Do you deliver on Sundays?', true],
  ]);
  const mayas = list.items.find((each) => each.lastMessage?.preview.startsWith('Do you'));
  if (mayas === undefined) throw new Error('No conversation for the first visitor.');
  const reply = threadMessage.parse(
    await asTeam(b.invocation, 'sendConversationReply', {
      params: { id: mayas.id },
      body: {
        channel: 'webchat',
        accountId: widgetAccount(b),
        text: 'Yes, until noon.',
        idempotencyKey: randomUUID().replaceAll('-', ''),
      },
    }),
  );
  expect(reply).toMatchObject({ channel: 'webchat', direction: 'outbound', status: 'sent' });
  expect(await maya.reads()).toEqual([
    'visitor: Do you deliver on Sundays?',
    'team: Yes, until noon.',
  ]);
  expect(await sam.reads()).toEqual(['visitor: Are you open today?']);
  expect(
    conversation.parse(await asTeam(b.invocation, 'getConversation', { params: { id: mayas.id } })),
  ).toMatchObject({ needsReply: false, unverified: true });
});

/** The widget as the Inbox's composer names it: its channel account. */
const widgetAccount = (b: Business): string => {
  const id = parsePublicId('webchat_widget', b.widget.id);
  if (id === undefined) throw new Error('Not a widget id.');
  return toPublicId('channel_account', id);
};

it("gives a visitor's token nothing of another visitor's chat, in the same widget", async () => {
  const b = await business('https://shop.example');
  const maya = await visitor(b, 'maya@example.test', 'My order number is 1234.');
  const other = await visitor(b, 'maya@example.test', 'What did I order?');
  // The same address typed twice: two chats, and neither token reads the other's words.
  expect(await other.reads()).toEqual(['visitor: What did I order?']);
  expect(await maya.reads()).toEqual(['visitor: My order number is 1234.']);
  expect(await b.rows('select 1 from messaging.conversations')).toHaveLength(2);
  // One visitor's browser with the other's token gets the other's chat only by holding it;
  // a token that is nobody's, or cut short, opens nothing.
  // The last character changed to another: one token in sixteen ends in "A" already.
  const altered = `${maya.token.slice(0, 42)}${maya.token.endsWith('A') ? 'E' : 'A'}`;
  for (const token of [altered, 'x'.repeat(43), maya.token.slice(1)]) {
    const answer = await other.browser('GET', '/messages?after=0', { token });
    expect(answer.status).toBe(401);
    expect(JSON.stringify(await answer.json())).not.toContain('1234');
  }
  const none = await other.browser('GET', '/messages?after=0');
  expect(none.status).toBe(401);
});

it('keeps a widget key of one business from reading or writing anything of another', async () => {
  const a = await business('https://a.example');
  const b = await business('https://b.example');
  const inB = await visitor(b, 'maya@example.test', 'Only for business B.');
  const before = await b.rows<{ n: number }>(
    `select (select count(*) from messaging.messages)::int + (select count(*) from messaging.webchat_sessions)::int
       + (select count(*) from crm.contacts)::int as n`,
  );

  // A's key from A's own website, holding B's visitor's token: it is no session of A's.
  const fromA = browserOn(a.website, a.widget.publicKey);
  for (const [method, path, body] of [
    ['GET', '/messages?after=0', undefined],
    ['POST', '/messages', { clientMessageId: randomUUID(), text: 'Written into B from A.' }],
    ['POST', '/session/end', undefined],
  ] as const) {
    const answer = await fromA(method, path, {
      token: inB.token,
      ...(body === undefined ? {} : { body }),
    });
    expect(answer.status, `${method} ${path}`).toBe(401);
    expect(JSON.stringify(await answer.json())).not.toContain('Only for business B.');
  }
  // B's key from A's website, and A's key from B's website: the gate refuses both, with no
  // CORS header, before any handler.
  for (const browser of [
    browserOn(a.website, b.widget.publicKey),
    browserOn(b.website, a.widget.publicKey),
    browserOn(null, b.widget.publicKey),
  ]) {
    for (const [method, path, body] of [
      ['GET', '', undefined],
      ['GET', '/messages?after=0', undefined],
      ['POST', '/sessions', { email: 'x@example.test', marketingConsent: false }],
      ['POST', '/messages', { clientMessageId: randomUUID(), text: 'Written from elsewhere.' }],
    ] as const) {
      const answer = await browser(method, path, {
        token: inB.token,
        ...(body === undefined ? {} : { body }),
      });
      expect(answer.status, `${method} ${path}`).toBe(403);
      expect(answer.headers.get('access-control-allow-origin')).toBeNull();
      expect(await answer.json()).toEqual({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'This chat cannot be used here.',
      });
    }
  }
  // Nothing was added to B, nothing at all was written to A, and B's visitor is undisturbed.
  expect(
    await b.rows(
      `select (select count(*) from messaging.messages)::int + (select count(*) from messaging.webchat_sessions)::int
         + (select count(*) from crm.contacts)::int as n`,
    ),
  ).toEqual(before);
  expect(
    await a.rows(
      `select (select count(*) from messaging.messages)::int + (select count(*) from messaging.webchat_sessions)::int
         + (select count(*) from crm.contacts)::int + (select count(*) from messaging.conversations)::int as n`,
    ),
  ).toEqual([{ n: 0 }]);
  expect(await inB.reads()).toEqual(['visitor: Only for business B.']);
  // And A's team sees no conversation, while B's sees its own.
  expect(conversationList.parse(await asTeam(a.invocation, 'listConversations')).items).toEqual([]);
  expect(
    conversationList.parse(await asTeam(b.invocation, 'listConversations')).items,
  ).toHaveLength(1);
});

it('stops answering the moment the widget is turned off or its key is replaced', async () => {
  const b = await business('https://shop.example');
  const maya = await visitor(b, 'maya@example.test', 'Hello');
  const settings = {
    name: b.widget.name,
    allowedOrigins: b.widget.allowedOrigins,
    settings: b.widget.settings,
  };
  await asTeam(b.invocation, 'updateWebchatWidget', {
    params: { id: b.widget.id },
    body: { ...settings, enabled: false },
  });
  expect((await maya.browser('GET', '')).status).toBe(403);
  expect((await maya.browser('GET', '/messages?after=0', { token: maya.token })).status).toBe(403);
  await asTeam(b.invocation, 'updateWebchatWidget', {
    params: { id: b.widget.id },
    body: { ...settings, enabled: true },
  });
  expect(await maya.reads()).toEqual(['visitor: Hello']);

  const rotated = webchatWidget.parse(
    await asTeam(b.invocation, 'rotateWebchatWidgetKey', { params: { id: b.widget.id } }),
  );
  // The old key is nobody's; under the new key the old chat has ended.
  expect((await maya.browser('GET', '')).status).toBe(403);
  const renewed = browserOn(b.website, rotated.publicKey);
  expect((await renewed('GET', '')).status).toBe(200);
  expect((await renewed('GET', '/messages?after=0', { token: maya.token })).status).toBe(401);
});

it('lets the real limiter stop one address, and tells any website how long to wait', async () => {
  const b = await business('https://shop.example');
  const browser = browserOn(b.website, b.widget.publicKey);
  // The shared limit is ten writes a minute for one address (migration 0042), in minutes of
  // the database's clock. Started too near the end of one, the twelve requests would fall
  // in two minutes; so the test waits for the next minute to begin first.
  const { left } = await database.as('postgres', (sql) =>
    sql.one<{ left: number }>(
      'select (60 - extract(second from clock_timestamp()))::float8 as left',
    ),
  );
  if (left < 10) await sleep((left + 0.5) * 1000);
  const statuses: number[] = [];
  let refused: Response | undefined;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const answer = await browser('POST', '/sessions', {
      body: { email: `visitor-${String(attempt)}@example.test`, marketingConsent: false },
    });
    statuses.push(answer.status);
    if (answer.status === 429) refused ??= answer;
  }
  expect(statuses).toEqual([...Array.from({ length: 10 }, () => 201), 429, 429]);
  if (refused === undefined) throw new Error('The limiter refused nothing.');
  const wait = Number(refused.headers.get('retry-after'));
  expect(wait).toBeGreaterThanOrEqual(1);
  expect(wait).toBeLessThanOrEqual(60);
  // Readable from the website, so the widget waits instead of seeing a network failure.
  expect(refused.headers.get('access-control-allow-origin')).toBe('*');
  expect(refused.headers.get('access-control-expose-headers')).toBe('Retry-After');
  expect(refused.headers.get('access-control-allow-credentials')).toBeNull();
  expect(await refused.json()).toEqual({
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Wait before trying again.',
  });
  expect(await b.rows('select 1 from messaging.webchat_sessions')).toHaveLength(10);
  // Another address is not held back by the first, and a preflight is never counted.
  expect((await browserOn(b.website, b.widget.publicKey)('GET', '')).status).toBe(200);
  const preflight = await browser('OPTIONS', '/sessions', {
    headers: { 'access-control-request-method': 'POST' },
  });
  expect(preflight.status).toBe(204);
});
