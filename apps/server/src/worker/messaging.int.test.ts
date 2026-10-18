// Real HTTP and Graphile queue boundaries, with only provider exchanges replaced by
// sanitized fixtures. No external account is read or message sent.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { allowEveryone } from '@repo/commands';
import { phoneNumber, smsConnectionStarted } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, type TenantContext } from '@repo/kernel';
import type { MailboxSubmitter } from '@repo/mail';
import {
  acceptSmsWebhook,
  createSmsRoutes,
  queueOutboundMessage,
  type TwilioTransport,
} from '@repo/module-messaging';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Config } from '../config.js';
import { buildServer, type Server } from '../server.js';
import { createMessagingDeliveryTasks } from './messaging-tasks.js';
import { startWorker, type Worker } from './worker.js';

const ORIGIN = 'https://crm.example.test';
const AUTH_TOKEN = 'queue-fixture-auth-token';
let database: TestDatabase;
let db: Database;
let vault: Vault;
const servers: Server[] = [];
const workers: Worker[] = [];
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
});
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await Promise.all(servers.splice(0).map((server) => server.close(1000)));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error('The queued messaging effect did not settle.');
    await delay(50);
  }
}

async function fixture(name: string): Promise<Record<string, unknown>> {
  const data: unknown = JSON.parse(
    await readFile(
      new URL(
        `../../../../packages/modules/messaging/src/fixtures/twilio/${name}`,
        import.meta.url,
      ),
      'utf8',
    ),
  );
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Invalid provider fixture.');
  return Object.fromEntries(Object.entries(data));
}

async function setup() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const context: TenantContext = {
    ...business.context,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  const services = { db, authorize: allowEveryone };
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
    devTenantContext: { agencyId: agency.id, businessId: business.id, userId: user.id },
    publicUrl: ORIGIN,
    authentication: undefined,
    trustProxy: [],
    mail: undefined,
    files: undefined,
    vault: undefined,
  };
  const server = await buildServer({
    config,
    logger: pino({ level: 'silent' }),
    serveApi: true,
    routes: createSmsRoutes(vault, ORIGIN),
    services,
    readinessChecks: {},
    smsWebhooks: { accept: (request) => acceptSmsWebhook(db, request) },
  });
  servers.push(server);
  const query = <T extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(context, (client) => client.query<T>(text, values));
  const accountSid = `AC${randomBytes(16).toString('hex')}`;
  const numberSid = `PN${randomBytes(16).toString('hex')}`;
  const messageSid = `SM${randomBytes(16).toString('hex')}`;
  const account = {
    ...(await fixture('account.json')),
    sid: accountSid,
    owner_account_sid: accountSid,
    status: 'active',
    type: 'Full',
  };
  const page = await fixture('incoming-phone-numbers-page-1.json');
  const entries = page['incoming_phone_numbers'];
  const template: unknown = Array.isArray(entries) ? entries[0] : undefined;
  if (template === null || typeof template !== 'object' || Array.isArray(template))
    throw new Error('Missing number fixture.');
  const owned = {
    ...Object.fromEntries(Object.entries(template)),
    sid: numberSid,
    account_sid: accountSid,
    phone_number: '+15017120000',
    capabilities: { sms: true, voice: true, mms: false, fax: false },
  };
  const created = {
    ...(await fixture('message-created.json')),
    sid: messageSid,
    account_sid: accountSid,
  };
  const calls: { method: string; path: string; body: string | undefined }[] = [];
  const transport: TwilioTransport = (request) => {
    calls.push({ method: request.method, path: request.path, body: request.body });
    return Promise.resolve({
      status: request.method === 'POST' ? 201 : 200,
      body: JSON.stringify(
        request.method === 'POST'
          ? created
          : request.path.includes('IncomingPhoneNumbers')
            ? { ...page, incoming_phone_numbers: [owned], next_page_uri: null }
            : account,
      ),
    });
  };
  const smtp: MailboxSubmitter = {
    submit: () => Promise.reject(new Error('This SMS flow must not use SMTP.')),
  };
  const beginWorker = async (delivery = true) => {
    const worker = await startWorker({
      connectionString: database.url('crm_worker'),
      services,
      tasks: delivery ? createMessagingDeliveryTasks(vault, transport, smtp, db, ORIGIN) : [],
      mailboxVault: vault,
      logger: pino({ level: 'silent' }),
      shutdownTimeoutMs: 1000,
    });
    workers.push(worker);
    return worker;
  };
  const connect = async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/sms-connection-attempts',
      payload: { provider: 'twilio', label: 'Queue fixture', accountSid, authToken: AUTH_TOKEN },
    });
    expect(response.statusCode).toBe(201);
    return smsConnectionStarted.parse(response.json());
  };
  return { server, query, context, accountSid, numberSid, messageSid, calls, beginWorker, connect };
}

describe('messaging through the HTTP and worker queue boundaries', () => {
  it('connects, refreshes, sends once, applies a signed callback and processes STOP through registered tasks', async () => {
    const c = await setup();
    const started = await c.connect();
    const inboundUrl = started.inboundWebhookUrl;
    if (inboundUrl === null) throw new Error('Missing one-time inbound URL.');
    await c.beginWorker();
    const attempt = await eventually(async () => {
      const response = await c.server.app.inject({
        url: `/api/v1/sms-connection-attempts/${started.attempt.id}`,
      });
      const parsed = smsConnectionStarted.shape.attempt.parse(response.json());
      return parsed.status === 'connected' ? parsed : undefined;
    });
    const registered = await c.server.app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers',
      payload: {
        connectionId: attempt.connectionId,
        providerNumberRef: c.numberSid,
        name: 'Reception',
      },
    });
    expect(registered.statusCode).toBe(201);
    const number = phoneNumber.parse(registered.json());
    const readsBefore = c.calls.filter((request) => request.method === 'GET').length;
    const refreshed = await c.server.app.inject({
      method: 'POST',
      url: `/api/v1/sms-connections/${attempt.connectionId}/number-refreshes`,
    });
    expect(refreshed.statusCode).toBe(204);
    await eventually(() =>
      Promise.resolve(
        c.calls.filter((request) => request.method === 'GET').length > readsBefore
          ? true
          : undefined,
      ),
    );
    const contact = await database.fixtures.contact(c.context);
    const [identity] = await c.query<{ id: string }>(
      `insert into crm.contact_identities (business_id,contact_id,kind,value,value_normalized,is_primary)
       values (app.business_id(),$1,'phone','+15017120001','+15017120001',true) returning id`,
      [contact.id],
    );
    if (identity === undefined) throw new Error('Missing phone identity.');
    await c.query(
      `insert into messaging.settings (business_id,quiet_hours_enabled,contact_daily_limit) values (app.business_id(),false,1000)`,
    );
    await c.query(
      `insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind)
      values (app.business_id(),$1,'sms','transactional','granted','user','system'),
             (app.business_id(),$1,'sms','marketing','granted','user','system')`,
      [contact.id],
    );
    const messageId = await withTenant(db, c.context, (trx) =>
      queueOutboundMessage(trx, c.context, {
        identityId: identity.id,
        accountId: parsePublicId('phone_number', number.id) ?? '',
        channel: 'sms',
        purpose: 'transactional',
        lane: 'reply',
        idempotencyKey: randomUUID(),
        text: 'Queue boundary message',
      }),
    );
    await eventually(async () => {
      const [row] = await c.query<{ status: string }>(
        'select status from messaging.messages where id=$1',
        [messageId],
      );
      return row?.status === 'sent' ? row : undefined;
    });
    expect(c.calls.filter((request) => request.method === 'POST')).toHaveLength(1);
    const submit = c.calls.find((request) => request.method === 'POST');
    const callbackUrl = new URLSearchParams(submit?.body).get('StatusCallback');
    if (callbackUrl === null) throw new Error('Missing configured callback.');
    const webhook = async (url: string, params: Record<string, string>, authToken = AUTH_TOKEN) => {
      const sorted = Object.entries(params).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      );
      const signature = createHmac('sha1', authToken)
        .update(url + sorted.map(([key, value]) => key + value).join(''))
        .digest('base64');
      const parsed = new URL(url);
      const response = await c.server.app.inject({
        method: 'POST',
        url: parsed.pathname + parsed.search,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature,
        },
        payload: new URLSearchParams(params).toString(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('<Response/>');
    };
    await webhook(callbackUrl, {
      AccountSid: c.accountSid,
      MessageSid: c.messageSid,
      MessageStatus: 'delivered',
    });
    await eventually(async () => {
      const [row] = await c.query<{ delivered: boolean }>(
        'select delivered_at is not null as delivered from messaging.messages where id=$1',
        [messageId],
      );
      return row?.delivered === true ? row : undefined;
    });
    const stop = {
      AccountSid: c.accountSid,
      MessageSid: `SM${randomBytes(16).toString('hex')}`,
      From: '+15017120001',
      To: number.e164,
      Body: 'STOP',
      NumMedia: '0',
    };
    await webhook(inboundUrl, stop, 'incorrect-fixture-token');
    await eventually(async () => {
      const rows = await database.as('crm_owner', (client) =>
        client.query<{ error: string }>(
          'select error from intake.webhooks where provider_connection_id=$1 and error=$2',
          [parsePublicId('sms_connection', attempt.connectionId), 'invalid_signature'],
        ),
      );
      return rows.length === 1 ? true : undefined;
    });
    expect(
      await c.query('select status from messaging.consents where contact_id=$1 order by purpose', [
        contact.id,
      ]),
    ).toEqual([{ status: 'granted' }, { status: 'granted' }]);
    await webhook(inboundUrl, stop);
    await eventually(async () => {
      const rows = await c.query<{ status: string }>(
        `select distinct on (purpose) status from messaging.consents where contact_id=$1
         order by purpose,recorded_at desc,id desc`,
        [contact.id],
      );
      return rows.length === 2 && rows.every((row) => row.status === 'withdrawn')
        ? rows
        : undefined;
    });
    expect(
      await c.query(
        `select message.id from messaging.messages message
       join messaging.conversations conversation on conversation.business_id=message.business_id and conversation.id=message.conversation_id
       where conversation.contact_id=$1 and message.direction=$2`,
        [contact.id, 'inbound'],
      ),
    ).toHaveLength(1);
    expect(c.calls.filter((request) => request.method === 'POST')).toHaveLength(1);
    const connectionId = parsePublicId('sms_connection', attempt.connectionId);
    const [oldWebhook] = await database.as('crm_owner', (client) =>
      client.query<{ id: string }>(
        `update intake.webhooks set received_at=now()-interval '31 days'
       where provider_connection_id=$1 and endpoint='inbound' and signature_valid=true returning id`,
        [connectionId],
      ),
    );
    if (oldWebhook === undefined) throw new Error('Missing retained webhook fixture.');
    await database.as('crm_owner', (client) =>
      client.query('select graphile_worker.add_job($1)', ['sms.maintain']),
    );
    await eventually(async () => {
      const rows = await database.as('crm_owner', (client) =>
        client.query('select id from intake.webhooks where id=$1', [oldWebhook.id]),
      );
      return rows.length === 0 ? true : undefined;
    });
    expect(
      await database.as('crm_owner', (client) =>
        client.query('select id from intake.webhooks where provider_connection_id=$1', [
          connectionId,
        ]),
      ),
    ).toHaveLength(2);
  });

  it('removes web chat sessions that expired without a chat through registered maintenance, and keeps the chats', async () => {
    const c = await setup();
    const contact = await database.fixtures.contact(c.context);
    const session = (digest: string, age: string) =>
      c.query<{ id: string }>(
        `insert into messaging.webchat_sessions
           (business_id, widget_id, token_digest, origin, visitor_name, visitor_email, created_at, expires_at)
         select app.business_id(), id, encode(sha256($1::bytea), 'hex'), 'https://example.com',
                'Maya', 'maya@example.test', now() - interval '40 days', now() - $2::interval
         from messaging.webchat_widgets returning id`,
        [digest, age],
      );
    const [account] = await c.query<{ id: string }>(
      `insert into messaging.channel_accounts (business_id, channel, name)
       values (app.business_id(), 'webchat', 'Main site') returning id`,
    );
    if (account === undefined) throw new Error('Missing widget fixture.');
    await c.query(
      `insert into messaging.webchat_widgets (business_id, id, public_key, allowed_origins)
       values (app.business_id(), $1, $2, '{https://example.com}')`,
      [account.id, randomBytes(24).toString('base64url')],
    );
    const [abandoned] = await session('abandoned', '1 day');
    const [chatted] = await session('chatted', '1 day');
    const [live] = await session('live', '-20 days');
    if (abandoned === undefined || chatted === undefined || live === undefined)
      throw new Error('Missing session fixtures.');
    // The second became a chat: its details went to the contact, as the first message does.
    const [conversation] = await c.query<{ id: string }>(
      'insert into messaging.conversations (business_id, contact_id) values (app.business_id(), $1) returning id',
      [contact.id],
    );
    await c.query(
      `update messaging.webchat_sessions
       set visitor_name = null, visitor_email = null, contact_id = $2, conversation_id = $3
       where id = $1`,
      [chatted.id, contact.id, conversation?.id],
    );
    await c.beginWorker(false);
    await database.as('crm_owner', (client) =>
      client.query('select graphile_worker.add_job($1)', ['webchat.maintain']),
    );
    await eventually(async () => {
      const rows = await c.query('select id from messaging.webchat_sessions where id = $1', [
        abandoned.id,
      ]);
      return rows.length === 0 ? true : undefined;
    });
    expect(
      await c.query<{ id: string }>('select id from messaging.webchat_sessions order by id'),
    ).toEqual([{ id: chatted.id }, { id: live.id }].sort((x, y) => x.id.localeCompare(y.id)));
  });

  it('expires pending SMS credentials through registered maintenance even when no verification job runs', async () => {
    const c = await setup();
    const started = await c.connect();
    const attemptId = parsePublicId('sms_attempt', started.attempt.id);
    const [stored] = await c.query<{ secret_id: string }>(
      'select secret_id from messaging.sms_connection_attempts where id=$1',
      [attemptId],
    );
    if (stored === undefined) throw new Error('Missing pending secret fixture.');
    await c.query(
      "update messaging.sms_connection_attempts set created_at=now()-interval '15 minutes', expires_at=now()-interval '1 second' where id=$1",
      [attemptId],
    );
    await c.beginWorker(false);
    await database.as('crm_owner', (client) =>
      client.query('select graphile_worker.add_job($1)', ['sms.maintain']),
    );
    await eventually(async () => {
      const [row] = await c.query<{ status: string; failure: string | null }>(
        'select status,failure_code as failure from messaging.sms_connection_attempts where id=$1',
        [attemptId],
      );
      return row?.status === 'failed' ? row : undefined;
    });
    expect(
      await c.query(
        'select status,failure_code as failure,secret_id from messaging.sms_connection_attempts where id=$1',
        [attemptId],
      ),
    ).toEqual([{ status: 'failed', failure: 'expired', secret_id: null }]);
    expect(await c.query('select id from vault.secrets where id=$1', [stored.secret_id])).toEqual(
      [],
    );
    expect(c.calls).toEqual([]);
  });
});
