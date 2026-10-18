// SMS end to end on the real boundaries: what an install runs,
// started by start with the server's own routes and the worker's own task list, over HTTP,
// the Graphile queue and PostgreSQL. The real Twilio adapter and transport talk HTTP to a
// local stand-in (test/fake-twilio.ts) that answers with the recorded fixtures. No request
// leaves this machine and no Twilio account exists.
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  contact as contactSchema,
  conversationComposer,
  conversationList,
  conversationThread,
  phoneNumber,
  smsConnectionStarted,
  threadMessage,
  type ThreadMessage,
} from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { parsePublicId, toPublicId, type TenantContext } from '@repo/kernel';
import { queueOutboundMessage } from '@repo/module-messaging';
import { newSecretsKey, parseSecretsKeys } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  fetchFromFakeTwilio,
  postTwilioWebhook,
  startFakeTwilio,
  type FakeTwilio,
  type FakeTwilioAccount,
} from '../../test/fake-twilio.js';
import { apiRoutes } from '../api-routes.js';
import type { Config, VaultKeys } from '../config.js';
import { start, type Running } from '../start.js';
import { workerTasks } from '../worker-tasks.js';
import { MAINTAIN_SMS } from './worker.js';

const ORIGIN = 'https://crm.example.test';
let database: TestDatabase;
let db: Database;
let vault: VaultKeys;
let twilio: FakeTwilio;
const running: Running[] = [];

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  vault = { holds: 'private', keys: parseSecretsKeys((await newSecretsKey(1)).secretsKey) };
  twilio = await startFakeTwilio();
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((each) => each.stop()));
});
afterAll(async () => {
  await twilio.stop();
  await db.destroy();
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

/** A business, and the install running for it: the API, the public webhooks and the worker. */
async function world() {
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
    publicUrl: ORIGIN,
    authentication: undefined,
    trustProxy: [],
    mail: undefined,
    files: undefined,
    vault,
  };
  // start() is the composition main.ts runs. Only the transport's fetch is given: it sends
  // the requests the real transport built for Twilio's host to the stand-in instead.
  let app: Running | undefined;
  const begin = async (): Promise<void> => {
    app = await start(config, apiRoutes, workerTasks, {
      twilioFetch: fetchFromFakeTwilio(twilio.origin),
    });
    running.push(app);
  };
  const stop = async (): Promise<void> => {
    await Promise.all(running.splice(0).map((each) => each.stop()));
    app = undefined;
  };
  const address = (): string => {
    if (app === undefined) throw new Error('The install is not running.');
    return app.address;
  };
  await begin();

  const query = <T extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(context, (client) => client.query<T>(text, values));
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${address()}/api/v1${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${method} ${path} answered ${String(response.status)}: ${text}`);
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  };
  /** Connects a made-up account through the API and registers its number. */
  const connect = async () => {
    // A number belongs to one business in the whole install, so each test has its own.
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
    if (started.inboundWebhookUrl === null) throw new Error('No inbound webhook address.');
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
    return {
      account,
      number,
      inboundUrl: started.inboundWebhookUrl,
      connectionId: parsePublicId('sms_connection', attempt.connectionId) ?? '',
    };
  };

  /** A contact with a mobile number who agreed to text messages of both kinds. */
  const contactWith = async (
    phone: string,
    consents: readonly string[] = ['transactional', 'marketing'],
  ) => {
    const created = contactSchema.parse(
      await api('POST', '/contacts', { firstName: 'Maya', phones: [phone] }),
    );
    for (const purpose of consents)
      await api('POST', `/contacts/${created.id}/consent`, {
        channel: 'sms',
        purpose,
        status: 'granted',
        note: 'Asked at the front desk on 9 October.',
      });
    return created;
  };

  const webhook = async (
    account: FakeTwilioAccount,
    url: string,
    params: Record<string, string>,
    authToken = account.authToken,
  ): Promise<void> => {
    const answer = await postTwilioWebhook({ url, deliverTo: address(), authToken, params });
    expect(answer).toEqual({ status: 200, body: '<Response/>' });
  };
  /** Every stored webhook of a connection has been handled by the worker. */
  const webhooksSettled = (connectionId: string, count: number) =>
    eventually(`${String(count)} webhooks are handled`, async () => {
      const rows = await database.as('crm_owner', (client) =>
        client.query<{ id: string; endpoint: string; valid: boolean | null; error: string | null }>(
          `select id, endpoint, signature_valid as valid, error from intake.webhooks
           where provider_connection_id = $1 and (processed_at is not null or signature_valid is false)
           order by received_at, id`,
          [connectionId],
        ),
      );
      return rows.length === count ? rows : undefined;
    });
  /** No job of sending, of a webhook or of the connection is waiting or running. */
  const queueIsEmpty = () =>
    eventually('the SMS jobs are done', async () => {
      const rows = await database.as('crm_owner', (client) =>
        client.query(
          `select id from graphile_worker.jobs
           where task_identifier in ('messaging.dispatch', 'sms.apply_webhook',
             'sms.apply_status', 'sms.verify_connection', 'sms.sync_numbers') limit 1`,
        ),
      );
      return rows.length === 0 ? true : undefined;
    });

  await query(
    'insert into messaging.settings (business_id, quiet_hours_enabled, contact_daily_limit) values (app.business_id(), false, 1000)',
  );
  return {
    api,
    query,
    context,
    begin,
    stop,
    connect,
    contactWith,
    webhook,
    webhooksSettled,
    queueIsEmpty,
  };
}

type World = Awaited<ReturnType<typeof world>>;
type Line = Awaited<ReturnType<World['connect']>>;

/** The contact texts the business: the signed inbound webhook, as Twilio posts it. */
async function texts(w: World, line: Line, from: string, body: string): Promise<string> {
  const sid = `SM${randomBytes(16).toString('hex')}`;
  await w.webhook(line.account, line.inboundUrl, {
    AccountSid: line.account.accountSid,
    ApiVersion: '2010-04-01',
    MessageSid: sid,
    SmsSid: sid,
    From: from,
    To: line.number.e164,
    Body: body,
    NumMedia: '0',
    NumSegments: '1',
  });
  return sid;
}

/** The conversation of a contact, once the worker has stored their message. */
const conversationOf = (w: World, contactId: string) =>
  eventually('the conversation is in the inbox', async () => {
    const list = conversationList.parse(await w.api('GET', '/conversations'));
    return list.items.find((item) => item.contact.id === contactId);
  });

/** Replies by text message from the Inbox, as the composer does. */
async function replyByText(
  w: World,
  conversationId: string,
  text: string,
  idempotencyKey: string = randomUUID(),
): Promise<ThreadMessage> {
  const composer = conversationComposer.parse(
    await w.api('GET', `/conversations/${conversationId}/composer`),
  );
  const sms = composer.channels.find((each) => each.channel === 'sms');
  const account = sms?.accounts[0];
  const recipient = sms?.recipients[0];
  if (sms?.available !== true || account === undefined || recipient === undefined)
    throw new Error(`The composer offers no text message: ${JSON.stringify(sms)}`);
  return threadMessage.parse(
    await w.api('POST', `/conversations/${conversationId}/replies`, {
      channel: 'sms',
      accountId: account.id,
      to: recipient.id,
      text,
      idempotencyKey,
    }),
  );
}

/** Queues a marketing text message to the contact's number, as a campaign would. */
async function queueMarketing(w: World, line: Line, contactId: string): Promise<string> {
  const [identity] = await w.query<{ id: string }>(
    "select id from crm.contact_identities where contact_id = $1 and kind = 'phone'",
    [parsePublicId('contact', contactId)],
  );
  if (identity === undefined) throw new Error('The contact has no phone number.');
  const id = await withTenant(db, w.context, (trx) =>
    queueOutboundMessage(trx, w.context, {
      identityId: identity.id,
      accountId: parsePublicId('phone_number', line.number.id) ?? '',
      channel: 'sms',
      purpose: 'marketing',
      lane: 'campaign',
      idempotencyKey: randomUUID(),
      text: 'Ten percent off in July.',
    }),
  );
  return toPublicId('message', id);
}

/**
 * Queues the dispatch job of a message once more, with the payload and the queue
 * private.enqueue_outbound gives it: what a retry or a duplicate job runs.
 */
async function dispatchAgain(w: World, messageId: string): Promise<void> {
  await database.as('crm_owner', (client) =>
    client.query(
      `select graphile_worker.add_job('messaging.dispatch', payload := $1::json, queue_name := $2)`,
      [
        JSON.stringify({
          agencyId: w.context.agencyId,
          businessId: w.context.businessId,
          correlationId: randomUUID(),
          data: { messageId },
        }),
        `outbound:${w.context.businessId ?? ''}`,
      ],
    ),
  );
}

const stored = (w: World, messageId: string) =>
  w.query<{ status: string; error_code: string | null; sid: string | null }>(
    'select status, error_code, provider_message_id as sid from messaging.messages where id = $1',
    [parsePublicId('message', messageId)],
  );
const until = (w: World, messageId: string, status: string) =>
  eventually(`the message is ${status}`, async () => {
    const [row] = await stored(w, messageId);
    return row?.status === status ? row : undefined;
  });
const createsFor = (line: Line) =>
  twilio.state().messages.filter((each) => each.accountSid === line.account.accountSid);

describe('text messages through the API, the queue and the Twilio adapter over HTTP', () => {
  it('delivers an Inbox reply to the provider once, as one CreateMessage request, and keeps delivery reports in order', async () => {
    const w = await world();
    const line = await w.connect();
    // Connecting read the account and its numbers, and nothing else.
    expect(
      twilio.state().reads.filter((each) => each.path.includes(line.account.accountSid)),
    ).toEqual([
      { method: 'GET', path: `/2010-04-01/Accounts/${line.account.accountSid}.json` },
      {
        method: 'GET',
        path: `/2010-04-01/Accounts/${line.account.accountSid}/IncomingPhoneNumbers.json?PageSize=1000`,
      },
    ]);
    const maya = await w.contactWith('+15558675310');
    await texts(w, line, '+15558675310', 'Is June 13 still open?');
    const conversation = await conversationOf(w, maya.id);
    expect(conversation).toMatchObject({
      needsReply: true,
      unreadCount: 1,
      lastMessage: { preview: 'Is June 13 still open?', direction: 'inbound', channel: 'sms' },
    });

    const key = randomUUID();
    const reply = await replyByText(w, conversation.id, 'Yes, June 13 is open.', key);
    expect(reply).toMatchObject({ channel: 'sms', status: 'queued', to: ['+15558675310'] });
    const sent = await until(w, reply.id, 'sent');
    // The same reply again (a retry, a double click) is the same message, not a second send.
    expect((await replyByText(w, conversation.id, 'Yes, June 13 is open.', key)).id).toBe(reply.id);
    await w.queueIsEmpty();
    // And the dispatch job itself, run again after the send, sends nothing.
    await dispatchAgain(w, parsePublicId('message', reply.id) ?? '');
    await w.queueIsEmpty();

    const creates = createsFor(line);
    expect(creates).toHaveLength(1);
    const [create] = creates;
    expect(create?.sid).toBe(sent.sid);
    expect(create?.contentType).toBe('application/x-www-form-urlencoded');
    expect(create?.authorization).toBe(
      `Basic ${Buffer.from(`${line.account.accountSid}:${line.account.authToken}`).toString('base64')}`,
    );
    const form = new Map(create?.form);
    expect([...form.keys()].sort()).toEqual(['Body', 'From', 'StatusCallback', 'To']);
    expect(form.get('To')).toBe('+15558675310');
    expect(form.get('From')).toBe(line.number.e164);
    expect(form.get('Body')).toBe('Yes, June 13 is open.');
    const callbackUrl = form.get('StatusCallback') ?? '';
    expect(callbackUrl).toMatch(
      new RegExp(
        `^${ORIGIN}/webhooks/twilio/[A-Za-z0-9_-]{43}/status\\?m=${parsePublicId('message', reply.id) ?? 'none'}$`,
      ),
    );

    // Twilio does not promise the order of its reports: "delivered" first, a late "sent" after.
    const report = (status: string) =>
      w.webhook(line.account, callbackUrl, {
        AccountSid: line.account.accountSid,
        ApiVersion: '2010-04-01',
        MessageSid: sent.sid ?? '',
        SmsSid: sent.sid ?? '',
        MessageStatus: status,
        SmsStatus: status,
        From: line.number.e164,
        To: '+15558675310',
      });
    await report('delivered');
    await until(w, reply.id, 'delivered');
    await report('sent');
    // One inbound and two reports, each handled.
    await w.webhooksSettled(line.connectionId, 3);
    await w.queueIsEmpty();
    expect(await stored(w, reply.id)).toEqual([
      { status: 'delivered', error_code: null, sid: sent.sid },
    ]);
    expect(
      await w.query(
        'select provider_status, conflicts from messaging.sms_deliveries where message_id = $1',
        [parsePublicId('message', reply.id)],
      ),
    ).toEqual([{ provider_status: 'delivered', conflicts: 0 }]);
    const thread = conversationThread.parse(
      await w.api('GET', `/conversations/${conversation.id}/messages`),
    );
    expect(
      thread.items.map((item) => (item.kind === 'message' ? [item.direction, item.status] : [])),
    ).toEqual([
      ['outbound', 'delivered'],
      ['inbound', 'received'],
    ]);
    expect(createsFor(line)).toHaveLength(1);
    expect(twilio.state().unexpected).toEqual([]);
  });

  it('rejects a forged delivery report and a forged STOP: nothing changes', async () => {
    const w = await world();
    const line = await w.connect();
    const maya = await w.contactWith('+15558675311');
    await texts(w, line, '+15558675311', 'Hello');
    const conversation = await conversationOf(w, maya.id);
    const reply = await replyByText(w, conversation.id, 'Hello Maya.');
    const sent = await until(w, reply.id, 'sent');
    const callbackUrl = new Map(createsFor(line)[0]?.form).get('StatusCallback') ?? '';

    await w.webhook(
      line.account,
      callbackUrl,
      {
        AccountSid: line.account.accountSid,
        MessageSid: sent.sid ?? '',
        MessageStatus: 'failed',
        ErrorCode: '30005',
      },
      'not-the-auth-token',
    );
    const sid = `SM${randomBytes(16).toString('hex')}`;
    await w.webhook(
      line.account,
      line.inboundUrl,
      {
        AccountSid: line.account.accountSid,
        MessageSid: sid,
        From: '+15558675311',
        To: line.number.e164,
        Body: 'STOP',
        NumMedia: '0',
      },
      'not-the-auth-token',
    );
    const handled = await w.webhooksSettled(line.connectionId, 3);
    expect(handled.map((row) => [row.endpoint.split('?')[0], row.valid, row.error])).toEqual([
      ['inbound', true, null],
      ['status', false, 'invalid_signature'],
      ['inbound', false, 'invalid_signature'],
    ]);
    await w.queueIsEmpty();
    expect(await stored(w, reply.id)).toEqual([
      { status: 'sent', error_code: null, sid: sent.sid },
    ]);
    expect(
      await w.query(
        "select purpose, status from messaging.consents where channel = 'sms' order by purpose, recorded_at",
      ),
    ).toEqual([
      { purpose: 'marketing', status: 'granted' },
      { purpose: 'transactional', status: 'granted' },
    ]);
    // The forged STOP stored no message, and the connection is not marked failing by it.
    expect(
      await w.query(
        "select direction from messaging.messages where channel = 'sms' order by created_at",
      ),
    ).toEqual([{ direction: 'inbound' }, { direction: 'outbound' }]);
    expect(await w.query('select status from messaging.provider_connections')).toEqual([
      { status: 'connected' },
    ]);
  });

  it('STOP blocks the next reply and the next marketing message at once, and replaying the stored STOP changes nothing', async () => {
    const w = await world();
    const line = await w.connect();
    const maya = await w.contactWith('+15558675312');
    await texts(w, line, '+15558675312', 'What time on Saturday?');
    const conversation = await conversationOf(w, maya.id);
    const first = await replyByText(w, conversation.id, 'Doors open at six.');
    await until(w, first.id, 'sent');
    expect(createsFor(line)).toHaveLength(1);

    await texts(w, line, '+15558675312', 'STOP');
    const [, stop] = await w.webhooksSettled(line.connectionId, 2);
    if (stop === undefined) throw new Error('The STOP was not stored.');
    const ledger = () =>
      w.query<{ purpose: string; status: string; source: string }>(
        "select purpose, status, source from messaging.consents where channel = 'sms' order by recorded_at, purpose",
      );
    const afterStop = await ledger();
    expect(afterStop.slice(-2)).toEqual([
      { purpose: 'marketing', status: 'withdrawn', source: 'keyword' },
      { purpose: 'transactional', status: 'withdrawn', source: 'keyword' },
    ]);

    // The very next reply from the Inbox is refused, and says why.
    const refused = await replyByText(w, conversation.id, 'See you then.');
    expect(refused).toMatchObject({ status: 'failed', problem: { code: 'consent_withdrawn' } });
    // So is a marketing message queued for the same number.
    const marketing = await queueMarketing(w, line, maya.id);
    expect(await stored(w, marketing)).toEqual([
      { status: 'failed', error_code: 'consent_withdrawn', sid: null },
    ]);

    // The stored raw payload is replayed through the queue: verified again, applied once.
    const jobs = await w.query<{ job: string }>(
      'select private.enqueue_sms_webhook($1::uuid, 0)::text as job',
      [stop.id],
    );
    expect(jobs).toHaveLength(1);
    await w.queueIsEmpty();
    expect(await ledger()).toEqual(afterStop);
    expect(
      await w.query(
        "select body_text from messaging.messages where direction = 'inbound' order by created_at",
      ),
    ).toEqual([{ body_text: 'What time on Saturday?' }, { body_text: 'STOP' }]);
    // Nothing reached the provider after the STOP.
    expect(createsFor(line)).toHaveLength(1);
  });

  it('sends nothing to a contact marked do not contact: the Inbox reply and a marketing message are both refused', async () => {
    const w = await world();
    const line = await w.connect();
    const maya = await w.contactWith('+15558675313');
    await texts(w, line, '+15558675313', 'Please call me instead.');
    const conversation = await conversationOf(w, maya.id);
    // Do not contact, turned on through the contact's own API.
    const shown = contactSchema.parse(await w.api('GET', `/contacts/${maya.id}`));
    await w.api('PATCH', `/contacts/${maya.id}`, {
      doNotContact: true,
      doNotContactReason: 'Asked by phone not to be written to.',
      preferencesRevision: shown.preferencesRevision,
    });

    const refused = await replyByText(w, conversation.id, 'Of course, calling now.');
    expect(refused).toMatchObject({ status: 'failed', problem: { code: 'do_not_contact' } });
    const marketing = await queueMarketing(w, line, maya.id);
    expect(await stored(w, marketing)).toEqual([
      { status: 'failed', error_code: 'do_not_contact', sid: null },
    ]);
    await w.queueIsEmpty();
    expect(createsFor(line)).toEqual([]);

    // Turned off again, the same reply goes out, once.
    const again = contactSchema.parse(await w.api('GET', `/contacts/${maya.id}`));
    await w.api('PATCH', `/contacts/${maya.id}`, {
      doNotContact: false,
      doNotContactReason: 'Asked us to text again.',
      preferencesRevision: again.preferencesRevision,
    });
    const allowed = await replyByText(w, conversation.id, 'Texting is fine again.');
    await until(w, allowed.id, 'sent');
    expect(createsFor(line)).toHaveLength(1);
  });

  it('never sends twice when the provider gives no readable answer, however often the job runs again', async () => {
    const w = await world();
    const line = await w.connect();
    const maya = await w.contactWith('+15558675314');
    await texts(w, line, '+15558675314', 'Are you open on Sunday?');
    const conversation = await conversationOf(w, maya.id);

    // Twilio may or may not have created the message: a 502 from something in between.
    twilio.answerNextCreate({ kind: 'unreadable', status: 502 });
    const reply = await replyByText(w, conversation.id, 'Yes, ten to four.');
    const unknown = await until(w, reply.id, 'unknown');
    expect(unknown).toEqual({ status: 'unknown', error_code: 'delivery_unknown', sid: null });
    expect(createsFor(line)).toHaveLength(1);

    // The dispatch job again, as a retry or a duplicate would run it: no second request.
    const messageId = parsePublicId('message', reply.id) ?? '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await dispatchAgain(w, messageId);
      await w.queueIsEmpty();
    }
    expect(createsFor(line)).toHaveLength(1);
    expect(await stored(w, reply.id)).toEqual([unknown]);
    // An install that restarts with the job still queued finds nothing to send either.
    await w.stop();
    await dispatchAgain(w, messageId);
    await w.begin();
    await w.queueIsEmpty();
    expect(createsFor(line)).toHaveLength(1);

    // The delivery report carries our message id, and settles the send with Twilio's SID.
    const callbackUrl = new Map(createsFor(line)[0]?.form).get('StatusCallback') ?? '';
    const sid = `SM${randomBytes(16).toString('hex')}`;
    await w.webhook(line.account, callbackUrl, {
      AccountSid: line.account.accountSid,
      MessageSid: sid,
      MessageStatus: 'delivered',
    });
    await until(w, reply.id, 'delivered');
    expect(await stored(w, reply.id)).toEqual([{ status: 'delivered', error_code: null, sid }]);
    expect(createsFor(line)).toHaveLength(1);
  });

  it('removes expired webhooks on the schedule itself: a worker that starts late catches up on the missed run', async () => {
    const w = await world();
    const line = await w.connect();
    await w.contactWith('+15558675315');
    await texts(w, line, '+15558675315', 'Hello');
    await texts(w, line, '+15558675315', 'Anyone there?');
    const [old, recent] = await w.webhooksSettled(line.connectionId, 2);
    if (old === undefined || recent === undefined) throw new Error('Missing stored webhooks.');
    await w.queueIsEmpty();
    await w.stop();

    // Thirty-one days on, with the worker down across the last scheduled run.
    await database.as('crm_owner', async (client) => {
      await client.query(
        "update intake.webhooks set received_at = now() - interval '31 days' where id = $1",
        [old.id],
      );
      await client.query(
        `insert into graphile_worker._private_known_crontabs (identifier, known_since, last_execution)
         values ($1, now() - interval '1 hour', null)
         on conflict (identifier) do update set known_since = excluded.known_since, last_execution = null`,
        [MAINTAIN_SMS],
      );
    });
    // Nothing queues the task here: only the worker's own schedule can.
    expect(
      await database.as('crm_owner', (client) =>
        client.query('select id from graphile_worker.jobs where task_identifier = $1', [
          MAINTAIN_SMS,
        ]),
      ),
    ).toEqual([]);
    await w.begin();
    await eventually('the expired webhook is removed', async () => {
      const rows = await database.as('crm_owner', (client) =>
        client.query('select id from intake.webhooks where id = $1', [old.id]),
      );
      return rows.length === 0 ? true : undefined;
    });
    expect(
      await database.as('crm_owner', (client) =>
        client.query<{ id: string }>(
          'select id from intake.webhooks where provider_connection_id = $1',
          [line.connectionId],
        ),
      ),
    ).toEqual([{ id: recent.id }]);
    const [crontab] = await database.as('crm_owner', (client) =>
      client.query<{ ran: boolean }>(
        'select last_execution is not null as ran from graphile_worker._private_known_crontabs where identifier = $1',
        [MAINTAIN_SMS],
      ),
    );
    expect(crontab).toEqual({ ran: true });
  });
});
