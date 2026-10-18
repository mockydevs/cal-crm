// Text messages are offered only where the install can send one. Every send names a status
// callback, and Twilio calls back only on a secure public address, so on an install whose
// PUBLIC_URL is http the Inbox says the channel is unavailable, refuses a reply by text
// before anything is stored, and Settings says why. On an https install the same account
// and number send.
//
// What an install runs: start() with the server's own routes and the worker's own tasks,
// over HTTP, the queue and PostgreSQL, with the Twilio stand-in of the other SMS tests.
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  contact as contactSchema,
  conversationComposer,
  conversationThread,
  phoneNumber,
  smsConnectionList,
  smsConnectionStarted,
  threadMessage,
} from '@repo/contracts';
import { parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import { newSecretsKey, parseSecretsKeys } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, afterEach, beforeAll, expect, inject, it } from 'vitest';

import { fetchFromFakeTwilio, startFakeTwilio, type FakeTwilio } from '../../test/fake-twilio.js';
import { apiRoutes } from '../api-routes.js';
import type { Config, VaultKeys } from '../config.js';
import { start, type Running } from '../start.js';
import { workerTasks } from '../worker-tasks.js';

let database: TestDatabase;
let vault: VaultKeys;
let twilio: FakeTwilio;
const running: Running[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  vault = { holds: 'private', keys: parseSecretsKeys((await newSecretsKey(1)).secretsKey) };
  twilio = await startFakeTwilio();
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((each) => each.stop()));
});
afterAll(async () => {
  await twilio.stop();
  await database.close();
});

async function eventually<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error(`Did not settle: ${what}.`);
    await delay(50);
  }
}

/**
 * An install at this public address, with a Twilio account connected, its number
 * registered, and a contact who agreed to text messages and has a conversation.
 */
async function install(publicUrl: string) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const context: TenantContext = {
    ...business.context,
    actorKind: 'system',
    correlationId: randomUUID(),
  };
  const config: Config = {
    nodeEnv: 'test',
    role: 'all',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    databaseAppUrl: database.url('crm_app'),
    databaseWorkerUrl: database.url('crm_worker'),
    databasePoolSize: 4,
    shutdownTimeoutMs: 1000,
    dashboardDir: undefined,
    devTenantContext: { agencyId: agency.id, businessId: business.id, userId: user.id },
    publicUrl,
    authentication: undefined,
    trustProxy: [],
    mail: undefined,
    files: undefined,
    vault,
  };
  // The composition main.ts runs: the routes are given the install's own public address.
  const app = await start(config, apiRoutes, workerTasks, {
    twilioFetch: fetchFromFakeTwilio(twilio.origin),
  });
  running.push(app);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${app.address}/api/v1${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
  };
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const answer = await call(method, path, body);
    if (answer.status >= 400)
      throw new Error(`${method} ${path} answered ${String(answer.status)}.`);
    return answer.body;
  };
  const query = <T extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(context, (client) => client.query<T>(text, values));
  await query(
    'insert into messaging.settings (business_id, quiet_hours_enabled, contact_daily_limit) values (app.business_id(), false, 1000)',
  );

  // A number belongs to one business in the whole install, so each install has its own.
  const account = twilio.addAccount({
    number: `+1501${String(randomBytes(4).readUInt32BE() % 10_000_000).padStart(7, '0')}`,
  });
  const started = smsConnectionStarted.parse(
    await api('POST', '/sms-connection-attempts', {
      provider: 'twilio',
      label: 'Front desk line',
      accountSid: account.accountSid,
      authToken: account.authToken,
    }),
  );
  const attempt = await eventually('the connection is verified', async () => {
    const parsed = smsConnectionStarted.shape.attempt.parse(
      await api('GET', `/sms-connection-attempts/${started.attempt.id}`),
    );
    return parsed.status === 'connected' ? parsed : undefined;
  });
  const number = phoneNumber.parse(
    await api('POST', '/phone-numbers', {
      connectionId: attempt.connectionId,
      providerNumberRef: account.numberSid,
      name: 'Front desk line',
    }),
  );
  const maya = contactSchema.parse(
    await api('POST', '/contacts', { firstName: 'Maya', phones: ['+254700000042'] }),
  );
  await api('POST', `/contacts/${maya.id}/consent`, {
    channel: 'sms',
    purpose: 'transactional',
    status: 'granted',
    note: 'Asked at the front desk on 9 October.',
  });
  const [conversation] = await query<{ id: string }>(
    `insert into messaging.conversations (business_id, contact_id)
     values (app.business_id(), $1) returning id`,
    [parsePublicId('contact', maya.id)],
  );
  if (conversation === undefined) throw new Error('No conversation.');
  const conversationId = toPublicId('conversation', conversation.id);
  const sms = async () => {
    const composer = conversationComposer.parse(
      await api('GET', `/conversations/${conversationId}/composer`),
    );
    const channel = composer.channels.find((each) => each.channel === 'sms');
    if (channel === undefined) throw new Error('The composer lists no text messages.');
    return { channel, suggested: composer.suggestedChannel };
  };
  const [identity] = await query<{ id: string }>(
    "select id from crm.contact_identities where contact_id = $1 and kind = 'phone'",
    [parsePublicId('contact', maya.id)],
  );
  const reply = () =>
    call('POST', `/conversations/${conversationId}/replies`, {
      channel: 'sms',
      accountId: toPublicId('channel_account', parsePublicId('phone_number', number.id) ?? ''),
      to: toPublicId('contact_identity', identity?.id ?? ''),
      text: 'See you at ten.',
      idempotencyKey: randomUUID(),
    });
  /** The CreateMessage requests Twilio got for this install's account. */
  const sentToTwilio = () =>
    twilio.state().messages.filter((message) => message.accountSid === account.accountSid);
  return { api, query, started, number, conversationId, sms, reply, sentToTwilio };
}

it('offers no text message on an install whose public address is http, and says why in Settings', async () => {
  const w = await install('http://crm.example.test');
  // The account connected and the number registered: only the address is in the way.
  expect(w.number.status).toBe('active');
  expect(w.started.inboundWebhookUrl).toBeNull();

  const { channel, suggested } = await w.sms();
  expect(channel).toEqual({
    channel: 'sms',
    available: false,
    unavailable: {
      code: 'channel_unavailable',
      message: "Text messages can't be sent: this install isn't set up to deliver them.",
    },
    accounts: [],
    recipients: [expect.objectContaining({ address: '+254700000042' })],
  });
  expect(suggested).toBeNull();

  // Asked for anyway, a reply by text is refused at once: nothing is stored to fail later.
  const refused = await w.reply();
  expect(refused.status).toBe(422);
  expect(refused.body).toMatchObject({
    errors: [{ path: '/channel', code: 'channel_unavailable' }],
  });
  expect(await w.query('select id from messaging.messages')).toEqual([]);
  expect(w.sentToTwilio()).toEqual([]);

  // Settings > SMS is told the reason with the connections.
  const list = smsConnectionList.parse(await w.api('GET', '/sms-connections'));
  expect(list.data).toHaveLength(1);
  expect(list.unavailable).toMatchObject({ code: 'public_address_unsuitable' });
});

it('offers and sends a text message on an install whose public address is https', async () => {
  const w = await install('https://crm.example.test');
  expect(w.started.inboundWebhookUrl).toMatch(/^https:\/\/crm\.example\.test\/webhooks\/twilio\//);
  expect(smsConnectionList.parse(await w.api('GET', '/sms-connections')).unavailable).toBeNull();

  const { channel, suggested } = await w.sms();
  expect(channel).toMatchObject({
    channel: 'sms',
    available: true,
    unavailable: null,
    accounts: [{ name: 'Front desk line', address: w.number.e164 }],
    recipients: [{ address: '+254700000042' }],
  });
  expect(suggested).toBe('sms');

  const accepted = await w.reply();
  expect(accepted.status).toBe(201);
  const queued = threadMessage.parse(accepted.body);
  expect(queued).toMatchObject({ channel: 'sms', status: 'queued', problem: null });
  // The worker hands it to Twilio once, with the address Twilio reports its delivery to.
  const sent = await eventually('the reply is sent', async () => {
    const thread = conversationThread.parse(
      await w.api('GET', `/conversations/${w.conversationId}/messages`),
    );
    const item = thread.items.find((each) => each.id === queued.id);
    return item?.kind === 'message' && item.status !== 'queued' && item.status !== 'sending'
      ? item
      : undefined;
  });
  expect(sent).toMatchObject({ status: 'sent', problem: null });
  const [request, ...more] = w.sentToTwilio();
  expect(more).toEqual([]);
  expect(new Map(request?.form).get('StatusCallback')).toMatch(
    /^https:\/\/crm\.example\.test\/webhooks\/twilio\/[A-Za-z0-9_-]{43}\/status\?m=[0-9a-f-]{36}$/,
  );
});
