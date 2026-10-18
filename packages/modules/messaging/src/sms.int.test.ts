// SMS on real Postgres with no network: callbacks with an
// invalid signature are rejected; statuses update messages in order; STOP blocks marketing
// sends immediately; stored raw payloads can be replayed.
//
// Twilio is an injected transport answering with fixtures built from its OpenAPI schemas
// (fixtures/twilio); webhooks are built from its documented parameters and signed here
// with the test connection's own token. Nothing in this file reaches Twilio.
//
// Uses canonical SMS migration 0044 and the public SMS contracts and permission.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  type TenantContext,
} from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import type { MailboxSubmitter } from '@repo/mail';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { ingestInboundCommand } from './inbound.js';
import { createDispatchOutboundTask, queueOutboundMessage } from './outbound.js';
import {
  applySmsStatusCommand,
  createApplySmsWebhookTask,
  type SmsWebhookResult,
} from './sms-callbacks.js';
import {
  createConnectSmsCommand,
  createSyncSmsNumbersTask,
  createVerifySmsConnectionTask,
  expireSmsConnectionAttempts,
  readSmsConnectionAttempt,
  readSmsConnections,
} from './sms-connect.js';
import { inboundDoNotDisturbFrom } from './inbound-dnd.js';
import { receiveSmsCommand } from './sms-inbound.js';
import { acceptSmsWebhook, expireSmsWebhooks, replaySmsWebhook } from './sms-intake.js';
import {
  hasActiveSmsNumber,
  readPhoneNumbers,
  readSmsProviderNumbers,
  registerPhoneNumberCommand,
} from './sms-numbers.js';
import { createTwilioOutbound, routeOutboundByChannel } from './sms-send.js';
import { createSmtpOutbound } from './index.js';
import {
  inboundWebhookUrl,
  statusCallbackUrl,
  webhookDigest,
  type WebhookEndpoint,
} from './sms-webhook-url.js';
import type { TwilioRequest, TwilioResponse, TwilioTransport } from './twilio-api.js';
import { expectedSignature } from './twilio-signature.js';

const PUBLIC_URL = 'https://crm.example.test';
const AUTH_TOKEN = 'fixture-auth-token-0123456789abcdef';

let database: TestDatabase;
let db: Database;
let services: Services;
let vault: Vault;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const fixtureJson = async (name: string): Promise<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(
    await readFile(new URL(`./fixtures/twilio/${name}`, import.meta.url), 'utf8'),
  );
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${name} is not an object`);
  return { ...parsed };
};
const objectOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? { ...value } : {};
const hex = (length: number) => randomBytes(length).toString('hex').slice(0, length);
// Made-up numbers in ranges the CRM accepts as possible; never dialled.
const usNumber = () => `+1501${String(randomInt(2_000_000, 9_999_999))}`;

type Answer = TwilioResponse | Error | 'created';

/** A Twilio account that exists only in this process. */
async function fakeTwilio(options: { status?: string; type?: string; smsNumbers?: number } = {}) {
  const accountSid = `AC${hex(32)}`;
  const account = {
    ...(await fixtureJson('account.json')),
    sid: accountSid,
    owner_account_sid: accountSid,
    status: options.status ?? 'active',
    type: options.type ?? 'Full',
  };
  const page = await fixtureJson('incoming-phone-numbers-page-1.json');
  const templates: readonly unknown[] = Array.isArray(page['incoming_phone_numbers'])
    ? page['incoming_phone_numbers']
    : [];
  const template = templates[0];
  const number = (capabilities: Record<string, boolean>) => ({
    ...objectOf(template),
    sid: `PN${hex(32)}`,
    account_sid: accountSid,
    phone_number: usNumber(),
    capabilities,
  });
  const numbers = [
    ...Array.from({ length: options.smsNumbers ?? 1 }, () =>
      number({ sms: true, mms: true, voice: true, fax: false }),
    ),
    number({ sms: false, mms: false, voice: true, fax: false }),
  ];
  const created = await fixtureJson('message-created.json');
  const sent: TwilioRequest[] = [];
  const state: { reads: Answer | null; create: Answer } = { reads: null, create: 'created' };
  const answer = (given: Answer, ok: () => TwilioResponse): Promise<TwilioResponse> =>
    given instanceof Error
      ? Promise.reject(given)
      : Promise.resolve(given === 'created' ? ok() : given);
  const transport: TwilioTransport = (request) => {
    sent.push(request);
    if (request.method === 'POST')
      return answer(state.create, () => ({
        status: 201,
        body: JSON.stringify({ ...created, sid: `SM${hex(32)}`, account_sid: accountSid }),
      }));
    if (state.reads !== null) return answer(state.reads, () => ({ status: 500, body: '' }));
    return Promise.resolve({
      status: 200,
      body: request.path.includes('IncomingPhoneNumbers')
        ? JSON.stringify({ ...page, incoming_phone_numbers: numbers, next_page_uri: null })
        : JSON.stringify(account),
    });
  };
  return {
    accountSid,
    transport,
    sent,
    state,
    numbers: numbers.map((each) => ({ sid: each.sid, e164: each.phone_number })),
    creates: () => sent.filter((each) => each.method === 'POST'),
  };
}

const tokenOf = (inboundUrl: string | null) => {
  const token = /\/webhooks\/twilio\/([A-Za-z0-9_-]{43})\/inbound$/.exec(inboundUrl ?? '')?.[1];
  if (token === undefined) throw new Error('The connect answer had no inbound webhook URL.');
  return token;
};

/** A business with a contact who has a phone number and SMS consent. Nothing connected. */
async function business() {
  const agency = await database.fixtures.agency();
  const created = await database.fixtures.business(agency.id);
  const context: TenantContext = { ...created.context, correlationId: randomUUID() };
  const contact = await database.fixtures.contact(context);
  const phone = usNumber();
  const identity = await database.withTenant(context, async (sql) => {
    await sql.query(
      'insert into messaging.settings (business_id,quiet_hours_enabled,contact_daily_limit) values (app.business_id(),false,1000)',
    );
    for (const purpose of ['marketing', 'transactional'])
      await sql.query(
        "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,recorded_by_kind) values (app.business_id(),$1,'sms',$2,'granted','user','system')",
        [contact.id, purpose],
      );
    return sql.one<{ id: string }>(
      "insert into crm.contact_identities (business_id,contact_id,kind,value,value_normalized,is_primary) values (app.business_id(),$1,'phone',$2,$2,true) returning id",
      [contact.id, phone],
    );
  });
  const invocation = { context, permissions: 'all' as const };
  const job = { invocation, services };
  const query = <T extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(context, (sql) => sql.query<T>(text, values));
  return {
    agency,
    id: created.id,
    context,
    contact,
    phone,
    identityId: identity.id,
    invocation,
    job,
    query,
  };
}

/** A business with a verified Twilio connection and one registered SMS number. */
async function connected(twilioOptions: Parameters<typeof fakeTwilio>[0] = {}) {
  const b = await business();
  const twilio = await fakeTwilio(twilioOptions);
  const started = await runCommand(
    services,
    createConnectSmsCommand(vault, PUBLIC_URL),
    {
      provider: 'twilio',
      label: 'Fixture account',
      accountSid: twilio.accountSid,
      authToken: AUTH_TOKEN,
    },
    b.invocation,
  );
  const token = tokenOf(started.inboundWebhookUrl);
  const [attempt] = await b.query<{ id: string }>(
    'select id from messaging.sms_connection_attempts',
  );
  if (attempt === undefined) throw new Error('No attempt was stored.');
  await createVerifySmsConnectionTask(vault, twilio.transport).run(
    { attemptId: attempt.id },
    b.job,
  );
  const [connection] = await readSmsConnections0(b.context, b.id);
  if (connection === undefined) throw new Error('The connection was not saved.');
  const [first] = twilio.numbers;
  if (first === undefined) throw new Error('The fake account has no number.');
  const number = await runCommand(
    services,
    registerPhoneNumberCommand,
    { connectionId: connection.id, providerNumberRef: first.sid, name: 'Front desk' },
    b.invocation,
  );
  const [row] = await b.query<{ id: string; provider_connection_id: string }>(
    'select id, provider_connection_id from messaging.phone_numbers',
  );
  if (row === undefined) throw new Error('The number was not registered.');
  twilio.sent.length = 0;

  const outbound = createTwilioOutbound(vault, twilio.transport, db, PUBLIC_URL, {
    create: { retryDelaysMs: [1, 1], sleep: () => Promise.resolve() },
  });
  const dispatch = () => createDispatchOutboundTask(outbound.sender, outbound.admission);
  const queue = (purpose: 'marketing' | 'transactional' = 'transactional', text = 'Hello there') =>
    withTenant(db, b.context, (trx) =>
      queueOutboundMessage(trx, b.context, {
        identityId: b.identityId,
        accountId: row.id,
        channel: 'sms',
        purpose,
        lane: purpose === 'marketing' ? 'campaign' : 'transactional',
        idempotencyKey: randomUUID(),
        text,
      }),
    );
  /** Queues a message and takes it through dispatch with Twilio's prepared answer. */
  const send = async (purpose: 'marketing' | 'transactional' = 'transactional') => {
    const messageId = await queue(purpose);
    await dispatch().run({ messageId }, b.job);
    return messageId;
  };
  const message = async (id: string) => {
    const [found] = await b.query<{
      status: string;
      provider_message_id: string | null;
      error_code: string | null;
      error_detail: string | null;
      delivered: boolean;
      failed: boolean;
    }>(
      'select status,provider_message_id,error_code,error_detail,delivered_at is not null as delivered,failed_at is not null as failed from messaging.messages where id=$1',
      [id],
    );
    if (found === undefined) throw new Error('The message is gone.');
    return found;
  };
  const delivery = async (id: string) =>
    (
      await b.query<{
        provider_status: string;
        status_rank: number;
        provider_error_code: number | null;
        segments: number | null;
        conflicts: number;
      }>(
        'select provider_status,status_rank,provider_error_code,segments,conflicts from messaging.sms_deliveries where message_id=$1',
        [id],
      )
    )[0];

  const results: SmsWebhookResult[] = [];
  const apply = (webhookId: string) =>
    createApplySmsWebhookTask(vault, PUBLIC_URL, {
      onResult: (result) => results.push(result),
    }).run({ webhookId }, b.job);
  /** Stores a webhook as the public route would; signed with `authToken` for this connection. */
  const receive = async (
    endpoint: WebhookEndpoint,
    params: Record<string, string>,
    signing: { authToken?: string; token?: string } = {},
  ) => {
    const url =
      endpoint.kind === 'inbound'
        ? inboundWebhookUrl(PUBLIC_URL, token)
        : statusCallbackUrl(PUBLIC_URL, token, endpoint.messageId);
    const accepted = await acceptSmsWebhook(db, {
      token: signing.token ?? token,
      endpoint,
      headers: {
        'x-twilio-signature': expectedSignature(signing.authToken ?? AUTH_TOKEN, url, params),
        'content-type': 'application/x-www-form-urlencoded',
        cookie: 'session=must-not-be-stored',
      },
      body: Buffer.from(new URLSearchParams(params).toString()),
    });
    if (accepted.outcome !== 'accepted') throw new Error(`Not accepted: ${accepted.outcome}`);
    return accepted.webhookId;
  };
  /** A status callback for one of our messages, stored and then verified and applied. */
  const callback = async (
    messageId: string,
    status: string,
    extra: Record<string, string> = {},
    signing: { authToken?: string } = {},
  ) => {
    // The message may be another business's, which this one can't read.
    const [known] = await b.query<{ provider_message_id: string | null }>(
      'select provider_message_id from messaging.messages where id=$1',
      [messageId],
    );
    const sid = known?.provider_message_id ?? `SM${hex(32)}`;
    const webhookId = await receive(
      { kind: 'status', messageId },
      {
        AccountSid: twilio.accountSid,
        ApiVersion: '2010-04-01',
        From: first.e164,
        To: b.phone,
        MessageSid: sid,
        SmsSid: sid,
        MessageStatus: status,
        SmsStatus: status,
        ...extra,
      },
      signing,
    );
    await apply(webhookId);
    return webhookId;
  };
  /** An inbound message to our number, stored and then verified and applied. */
  const inbound = async (
    body: string,
    extra: Record<string, string> = {},
    signing: { authToken?: string } = {},
  ) => {
    const sid = `SM${hex(32)}`;
    const webhookId = await receive(
      { kind: 'inbound' },
      {
        AccountSid: twilio.accountSid,
        ApiVersion: '2010-04-01',
        Body: body,
        From: b.phone,
        To: first.e164,
        MessageSid: sid,
        SmsSid: sid,
        SmsMessageSid: sid,
        NumMedia: '0',
        NumSegments: '1',
        ...extra,
      },
      signing,
    );
    await apply(webhookId);
    return { webhookId, sid };
  };
  const webhook = async (id: string) => {
    const [found] = await database.as('postgres', (sql) =>
      sql.query<{
        signature_valid: boolean | null;
        processed: boolean;
        error: string | null;
        endpoint: string;
        headers: Record<string, string>;
        body: Buffer;
        business_id: string;
      }>(
        'select signature_valid,processed_at is not null as processed,error,endpoint,headers,body,business_id from intake.webhooks where id=$1',
        [id],
      ),
    );
    if (found === undefined) throw new Error('The webhook was not stored.');
    return found;
  };
  const consents = () =>
    b.query<{
      purpose: string;
      status: string;
      source: string;
      proof: Record<string, string>;
      address_normalized: string | null;
    }>(
      "select purpose,status,source,proof,address_normalized from messaging.consents where channel='sms' order by recorded_at,id",
    );
  /** Everything a webhook could change, to compare before and after. */
  const snapshot = async () => ({
    messages: await b.query<Record<string, unknown>>(
      'select id,status,provider_message_id,error_code,error_detail,sent_at,delivered_at,failed_at,read_at,direction,body_text from messaging.messages order by id',
    ),
    deliveries: await b.query('select * from messaging.sms_deliveries order by message_id'),
    dispatch: await b.query(
      'select id,reserved_at,finished_at from messaging.outbound_dispatch order by id',
    ),
    consents: await b.query('select * from messaging.consents order by id'),
    connections: await b.query('select * from messaging.provider_connections order by id'),
    conversations: await b.query('select * from messaging.conversations order by id'),
    contacts: await b.query('select id from crm.contacts order by id'),
    events: await b.query('select id,type from events.events order by id'),
  });
  return {
    ...b,
    twilio,
    token,
    connectionId: connection.id,
    connectionUuid: row.provider_connection_id,
    number: { ...first, id: row.id, publicId: number.id },
    dispatch,
    queue,
    send,
    message,
    delivery,
    results,
    apply,
    receive,
    callback,
    inbound,
    webhook,
    consents,
    snapshot,
  };
}

const readSmsConnections0 = (context: TenantContext, businessId: string) =>
  withTenant(db, context, (trx) => readSmsConnections(trx, businessId));

async function pendingConnection() {
  const b = await business();
  const twilio = await fakeTwilio();
  const started = await runCommand(
    services,
    createConnectSmsCommand(vault, PUBLIC_URL),
    { provider: 'twilio', label: 'Main', accountSid: twilio.accountSid, authToken: AUTH_TOKEN },
    b.invocation,
  );
  const [attempt] = await b.query<{ id: string; secret_id: string }>(
    'select id,secret_id from messaging.sms_connection_attempts',
  );
  if (attempt === undefined) throw new Error('No pending connection attempt.');
  const read = () =>
    withTenant(db, b.context, (trx) => readSmsConnectionAttempt(trx, started.attempt.id));
  return { ...b, twilio, started, attempt, read };
}

describe('connection verification boundaries', () => {
  it('does not connect an account when the successful provider answer names another account', async () => {
    const c = await pendingConnection();
    const transport: TwilioTransport = async (request) => {
      const response = await c.twilio.transport(request);
      const answer: unknown = JSON.parse(response.body);
      return { ...response, body: JSON.stringify({ ...objectOf(answer), sid: `AC${hex(32)}` }) };
    };
    await createVerifySmsConnectionTask(vault, transport).run({ attemptId: c.attempt.id }, c.job);
    expect(await c.read()).toMatchObject({ status: 'failed', failure: 'provider_unavailable' });
    expect(c.twilio.sent).toHaveLength(1);
    expect(await readSmsConnections0(c.context, c.id)).toEqual([]);
    expect(await c.query('select id from vault.secrets')).toEqual([]);
  });

  it('connects a valid account with no owned numbers without advertising an SMS sender', async () => {
    const c = await pendingConnection();
    const transport: TwilioTransport = (request) =>
      request.path.includes('IncomingPhoneNumbers')
        ? Promise.resolve({
            status: 200,
            body: JSON.stringify({ incoming_phone_numbers: [], next_page_uri: null }),
          })
        : c.twilio.transport(request);
    await createVerifySmsConnectionTask(vault, transport).run({ attemptId: c.attempt.id }, c.job);
    expect(await c.read()).toMatchObject({ status: 'connected', result: { numbersFound: 0 } });
    expect(await readSmsConnections0(c.context, c.id)).toHaveLength(1);
    expect(await c.query('select provider_number_ref from messaging.provider_numbers')).toEqual([]);
    expect(await withTenant(db, c.context, hasActiveSmsNumber)).toBe(false);
  });

  it.each([
    [401, 'authentication'],
    [503, 'provider_unavailable'],
    [200, 'provider_unavailable'],
  ] as const)(
    'removes credentials when number enumeration answers %i unusably',
    async (status, failure) => {
      const c = await pendingConnection();
      const transport: TwilioTransport = (request) =>
        request.path.includes('IncomingPhoneNumbers')
          ? Promise.resolve({ status, body: 'unusable provider response' })
          : c.twilio.transport(request);
      await createVerifySmsConnectionTask(vault, transport).run({ attemptId: c.attempt.id }, c.job);
      expect(await c.read()).toMatchObject({ status: 'failed', failure });
      expect(await readSmsConnections0(c.context, c.id)).toEqual([]);
      expect(await c.query('select id from vault.secrets')).toEqual([]);
      expect(await c.query('select provider_number_ref from messaging.provider_numbers')).toEqual(
        [],
      );
    },
  );

  it.each(['before_reads', 'during_reads'] as const)(
    'does not connect credentials that expired %s',
    async (when) => {
      const c = await pendingConnection();
      const expire = () =>
        c.query(
          "update messaging.sms_connection_attempts set created_at=now()-interval '1 hour',expires_at=now()-interval '50 minutes' where id=$1",
          [c.attempt.id],
        );
      if (when === 'before_reads') await expire();
      const transport: TwilioTransport = async (request) => {
        if (when === 'during_reads' && request.path.includes('IncomingPhoneNumbers'))
          await expire();
        return c.twilio.transport(request);
      };
      await createVerifySmsConnectionTask(vault, transport).run({ attemptId: c.attempt.id }, c.job);
      expect(await c.read()).toMatchObject({ status: 'failed', failure: 'expired' });
      expect(await readSmsConnections0(c.context, c.id)).toEqual([]);
      expect(await c.query('select id from vault.secrets')).toEqual([]);
      if (when === 'before_reads') expect(c.twilio.sent).toEqual([]);
    },
  );

  it.each(['invalid_json', 'invalid_fields', 'wrong_account', 'unreadable_key'] as const)(
    'refuses %s sealed credentials before any provider read',
    async (fault) => {
      const c = await pendingConnection();
      if (fault !== 'unreadable_key')
        await withTenant(db, c.context, async (trx) => {
          const original: unknown = JSON.parse(
            await vault.read(trx, c.attempt.secret_id, 'sms.twilio.credentials'),
          );
          await vault.replace(
            trx,
            c.attempt.secret_id,
            fault === 'invalid_json'
              ? '{'
              : fault === 'invalid_fields'
                ? JSON.stringify({ authToken: AUTH_TOKEN })
                : JSON.stringify({ ...objectOf(original), accountSid: `AC${hex(32)}` }),
          );
        });
      const workerVault =
        fault === 'unreadable_key'
          ? await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey))
          : vault;
      await createVerifySmsConnectionTask(workerVault, c.twilio.transport).run(
        { attemptId: c.attempt.id },
        c.job,
      );
      expect(await c.read()).toMatchObject({ status: 'failed', failure: 'credentials_unreadable' });
      expect(c.twilio.sent).toEqual([]);
      expect(await c.query('select id from vault.secrets')).toEqual([]);
      expect(await readSmsConnections0(c.context, c.id)).toEqual([]);
    },
  );

  it('does not repeat provider reads for a terminal or missing attempt', async () => {
    const c = await pendingConnection();
    const worker = createVerifySmsConnectionTask(vault, c.twilio.transport);
    await worker.run({ attemptId: c.attempt.id }, c.job);
    expect(await c.read()).toMatchObject({ status: 'connected' });
    c.twilio.sent.length = 0;
    await worker.run({ attemptId: c.attempt.id }, c.job);
    await worker.run({ attemptId: randomUUID() }, c.job);
    expect(c.twilio.sent).toEqual([]);
    expect(await readSmsConnections0(c.context, c.id)).toHaveLength(1);
  });

  it('replaces an expired pending connection and prevents its old queued job from reading credentials', async () => {
    const c = await pendingConnection();
    await c.query(
      "update messaging.sms_connection_attempts set created_at=now()-interval '1 hour',expires_at=now()-interval '50 minutes' where id=$1",
      [c.attempt.id],
    );
    const replacement = await runCommand(
      services,
      createConnectSmsCommand(vault, PUBLIC_URL),
      {
        provider: 'twilio',
        label: 'Replacement',
        accountSid: c.twilio.accountSid,
        authToken: AUTH_TOKEN,
      },
      c.invocation,
    );
    expect(replacement.attempt.id).not.toBe(c.started.attempt.id);
    expect(replacement.inboundWebhookUrl).not.toBe(c.started.inboundWebhookUrl);
    expect(await c.read()).toMatchObject({ status: 'failed', failure: 'expired' });
    expect(
      await c.query('select id from vault.secrets where id=$1', [c.attempt.secret_id]),
    ).toEqual([]);
    expect(await c.query('select id from vault.secrets')).toHaveLength(1);
    const worker = createVerifySmsConnectionTask(vault, c.twilio.transport);
    await worker.run({ attemptId: c.attempt.id }, c.job);
    expect(c.twilio.sent).toEqual([]);
    const [pending] = await c.query<{ id: string }>(
      "select id from messaging.sms_connection_attempts where status='pending'",
    );
    if (pending === undefined) throw new Error('No replacement pending attempt.');
    await worker.run({ attemptId: pending.id }, c.job);
    expect(await readSmsConnections0(c.context, c.id)).toEqual([
      expect.objectContaining({ label: 'Replacement', status: 'connected' }),
    ]);
  });

  it('refuses malformed and unknown public attempt identifiers', async () => {
    const c = await pendingConnection();
    const [unknown] = await c.query<{ id: string }>('select uuidv7() as id');
    if (unknown === undefined) throw new Error('No fresh unknown attempt identifier.');
    for (const id of ['not-an-attempt', toPublicId('sms_attempt', unknown.id)])
      await expect(
        withTenant(db, c.context, (trx) => readSmsConnectionAttempt(trx, id)),
      ).rejects.toBeInstanceOf(NotFoundError);
    expect(await c.read()).toMatchObject({ status: 'pending' });
  });
});

describe('connecting a Twilio account', () => {
  it('seals the credentials, verifies them in the worker and saves the connection', async () => {
    const b = await business();
    const twilio = await fakeTwilio({ type: 'Trial' });
    const started = await runCommand(
      services,
      createConnectSmsCommand(vault, PUBLIC_URL),
      {
        provider: 'twilio',
        label: 'Main',
        accountSid: twilio.accountSid,
        authToken: AUTH_TOKEN,
        apiKey: { sid: `SK${hex(32)}`, secret: 'fixture-key-secret-zyxwvu' },
      },
      b.invocation,
    );
    expect(started.attempt).toMatchObject({ status: 'pending', connectionId: null, result: null });
    const token = tokenOf(started.inboundWebhookUrl);
    expect(started.inboundWebhookUrl).toBe(`${PUBLIC_URL}/webhooks/twilio/${token}/inbound`);
    // Pending: nothing is connected, and nothing has asked Twilio anything.
    expect(await readSmsConnections0(b.context, b.id)).toEqual([]);
    expect(twilio.sent).toEqual([]);
    const [attempt] = await b.query<{ id: string; secret_id: string }>(
      'select id, secret_id from messaging.sms_connection_attempts',
    );
    if (attempt === undefined) throw new Error('No attempt.');

    await createVerifySmsConnectionTask(vault, twilio.transport).run(
      { attemptId: attempt.id },
      b.job,
    );
    // Two kinds of read and nothing else: the account, and the numbers it owns.
    expect(twilio.sent.map((each) => `${each.method} ${each.path.split('?')[0] ?? ''}`)).toEqual([
      `GET /2010-04-01/Accounts/${twilio.accountSid}.json`,
      `GET /2010-04-01/Accounts/${twilio.accountSid}/IncomingPhoneNumbers.json`,
    ]);
    const read = await withTenant(db, b.context, (trx) =>
      readSmsConnectionAttempt(trx, started.attempt.id),
    );
    expect(read).toMatchObject({
      status: 'connected',
      result: { accountType: 'trial', accountStatus: 'active', subaccount: false, numbersFound: 2 },
    });
    const [connection] = await readSmsConnections0(b.context, b.id);
    expect(connection).toMatchObject({
      provider: 'twilio',
      label: 'Main',
      accountSid: twilio.accountSid,
      status: 'connected',
      accountType: 'trial',
      warnings: ['trial_account'],
    });
    const [stored] = await b.query<{ webhook_digest: string; secret_id: string }>(
      'select webhook_digest, secret_id from messaging.provider_connections',
    );
    // The token is findable only by its digest; the secret moved from the attempt.
    expect(stored).toEqual({ webhook_digest: webhookDigest(token), secret_id: attempt.secret_id });
    expect(
      await b.query(
        'select secret_id from messaging.sms_connection_attempts where secret_id is not null',
      ),
    ).toEqual([]);

    // The initial answer intentionally reveals the webhook URL once. Its other fields,
    // stored records and subsequent readers must not reveal credentials or that token.
    const { inboundWebhookUrl: revealedOnce, ...startedWithoutUrl } = started;
    expect(revealedOnce).toBe(inboundWebhookUrl(PUBLIC_URL, token));
    const readable = JSON.stringify([
      await b.query('select * from messaging.sms_connection_attempts'),
      await b.query('select * from messaging.provider_connections'),
      await b.query('select * from messaging.provider_numbers'),
      await b.query("select input from audit.commands where command like 'sms.%'"),
      await b.query('select type, payload from events.events'),
      await database.as('postgres', (sql) =>
        sql.query('select payload::text from graphile_worker._private_jobs'),
      ),
      startedWithoutUrl,
      read,
      connection,
    ]);
    for (const secret of [
      AUTH_TOKEN,
      'fixture-key-secret-zyxwvu',
      token,
      'fixture-auth-token-never-log-me',
    ])
      expect(readable).not.toContain(secret);
    const audits = await b.query<{ input: unknown }>(
      "select input from audit.commands where command = 'sms.connect'",
    );
    expect(audits).toEqual([
      { input: { provider: 'twilio', label: 'Main', accountSid: twilio.accountSid } },
    ]);
  });

  it.each([
    ['refused credentials', { reads: { status: 401, body: '{"code":20003}' } }, 'authentication'],
    ['a Twilio outage', { reads: { status: 503, body: '' } }, 'provider_unavailable'],
    ['no answer', { reads: new Error(`socket hang up ${AUTH_TOKEN}`) }, 'provider_unavailable'],
    ['a suspended account', { status: 'suspended' }, 'account_inactive'],
    ['a closed account', { status: 'closed' }, 'account_inactive'],
  ] as const)(
    'fails the attempt on %s and removes the sealed credentials',
    async (_what, setup, failure) => {
      const b = await business();
      const twilio = await fakeTwilio('status' in setup ? { status: setup.status } : {});
      if ('reads' in setup) twilio.state.reads = setup.reads;
      const started = await runCommand(
        services,
        createConnectSmsCommand(vault, PUBLIC_URL),
        { provider: 'twilio', label: 'Main', accountSid: twilio.accountSid, authToken: AUTH_TOKEN },
        b.invocation,
      );
      const [attempt] = await b.query<{ id: string }>(
        'select id from messaging.sms_connection_attempts',
      );
      await createVerifySmsConnectionTask(vault, twilio.transport).run(
        { attemptId: attempt?.id ?? '' },
        b.job,
      );
      expect(
        await withTenant(db, b.context, (trx) => readSmsConnectionAttempt(trx, started.attempt.id)),
      ).toMatchObject({ status: 'failed', failure, connectionId: null, result: null });
      expect(await readSmsConnections0(b.context, b.id)).toEqual([]);
      expect(await b.query('select id from vault.secrets')).toEqual([]);
      expect(
        JSON.stringify(await b.query('select * from messaging.sms_connection_attempts')),
      ).not.toContain(AUTH_TOKEN);
    },
  );

  it('refuses the same account twice, pending or connected', async () => {
    const c = await connected();
    const again = () =>
      runCommand(
        services,
        createConnectSmsCommand(vault, PUBLIC_URL),
        {
          provider: 'twilio',
          label: 'Again',
          accountSid: c.twilio.accountSid,
          authToken: AUTH_TOKEN,
        },
        c.invocation,
      );
    await expect(again()).rejects.toBeInstanceOf(ConflictError);
    const b = await business();
    const twilio = await fakeTwilio();
    const input = {
      provider: 'twilio',
      label: 'Main',
      accountSid: twilio.accountSid,
      authToken: AUTH_TOKEN,
    };
    await runCommand(services, createConnectSmsCommand(vault, PUBLIC_URL), input, b.invocation);
    await expect(
      runCommand(services, createConnectSmsCommand(vault, PUBLIC_URL), input, b.invocation),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await b.query('select id from vault.secrets')).toHaveLength(1);
  });

  it('expires an attempt nobody finished, with its credentials', async () => {
    const b = await business();
    const twilio = await fakeTwilio();
    await runCommand(
      services,
      createConnectSmsCommand(vault, PUBLIC_URL),
      { provider: 'twilio', label: 'Main', accountSid: twilio.accountSid, authToken: AUTH_TOKEN },
      b.invocation,
    );
    await database.as('postgres', (sql) =>
      sql.query(
        "update messaging.sms_connection_attempts set created_at = now() - interval '1 hour', expires_at = now() - interval '50 minutes' where business_id = $1",
        [b.id],
      ),
    );
    expect(await expireSmsConnectionAttempts(services, vault)).toBeGreaterThanOrEqual(1);
    expect(
      await b.query('select status, failure_code from messaging.sms_connection_attempts'),
    ).toEqual([{ status: 'failed', failure_code: 'expired' }]);
    expect(await b.query('select id from vault.secrets')).toEqual([]);
  });

  it('answers without a webhook address when the install has no public HTTPS address', async () => {
    const b = await business();
    const twilio = await fakeTwilio();
    const started = await runCommand(
      services,
      createConnectSmsCommand(vault, 'http://localhost:3000'),
      { provider: 'twilio', label: 'Main', accountSid: twilio.accountSid, authToken: AUTH_TOKEN },
      b.invocation,
    );
    expect(started.inboundWebhookUrl).toBeNull();
  });
});

describe('phone numbers', () => {
  it.each(['another_provider', 'agency_shared'] as const)(
    'does not advertise an active SMS sender for a connection the sender cannot use: %s',
    async (scope) => {
      const c = await connected();
      await database.as('postgres', (sql) =>
        sql.query(
          scope === 'another_provider'
            ? "update messaging.provider_connections set provider='telnyx' where id=$1"
            : 'update messaging.provider_connections set business_id=null where id=$1',
          [c.connectionUuid],
        ),
      );
      expect(await withTenant(db, c.context, hasActiveSmsNumber)).toBe(false);
    },
  );

  it('registers a listed number with the facts read from Twilio, and never calls Twilio', async () => {
    const c = await connected();
    expect(await withTenant(db, c.context, (trx) => readPhoneNumbers(trx))).toEqual([
      expect.objectContaining({
        id: c.number.publicId,
        name: 'Front desk',
        e164: c.number.e164,
        connectionId: c.connectionId,
        capabilities: ['sms', 'mms', 'voice'],
        status: 'active',
      }),
    ]);
    const listed = await withTenant(db, c.context, (trx) =>
      readSmsProviderNumbers(trx, c.id, c.connectionId),
    );
    expect(listed.map((each) => [each.providerNumberRef, each.registeredAs])).toEqual(
      expect.arrayContaining([
        [c.number.sid, c.number.publicId],
        [c.twilio.numbers[1]?.sid, null],
      ]),
    );
    expect(await withTenant(db, c.context, (trx) => hasActiveSmsNumber(trx))).toBe(true);
    // Registering asked Twilio nothing and changed nothing there.
    expect(c.twilio.sent).toEqual([]);
  });

  it('refuses a number twice, a number that cannot do SMS, and one that is not listed', async () => {
    const c = await connected();
    const register = (providerNumberRef: string) =>
      runCommand(
        services,
        registerPhoneNumberCommand,
        { connectionId: c.connectionId, providerNumberRef, name: 'Second' },
        c.invocation,
      );
    await expect(register(c.number.sid)).rejects.toBeInstanceOf(ConflictError);
    await expect(register(c.twilio.numbers[1]?.sid ?? '')).rejects.toBeInstanceOf(ConflictError);
    await expect(register(`PN${hex(32)}`)).rejects.toBeInstanceOf(NotFoundError);
    expect(await c.query('select id from messaging.phone_numbers')).toHaveLength(1);
    expect(
      await c.query("select id from messaging.channel_accounts where channel='sms'"),
    ).toHaveLength(1);
  });

  it('reads the account’s numbers again without touching registered ones', async () => {
    const c = await connected();
    await createSyncSmsNumbersTask(vault, c.twilio.transport).run(
      { connectionId: c.connectionUuid },
      c.job,
    );
    expect(c.twilio.sent.every((each) => each.method === 'GET')).toBe(true);
    expect(await c.query('select id from messaging.phone_numbers')).toHaveLength(1);
    // A read that fails leaves the list as it was.
    c.twilio.state.reads = { status: 503, body: '' };
    const before = await c.query(
      'select * from messaging.provider_numbers order by provider_number_ref',
    );
    await createSyncSmsNumbersTask(vault, c.twilio.transport).run(
      { connectionId: c.connectionUuid },
      c.job,
    );
    expect(
      await c.query('select * from messaging.provider_numbers order by provider_number_ref'),
    ).toEqual(before);
  });
});

describe('tenant isolation', () => {
  it('shows another business none of a connection, its numbers, attempts or deliveries', async () => {
    const a = await connected();
    await a.send();
    const other = await business();
    for (const table of [
      'messaging.provider_connections',
      'messaging.provider_numbers',
      'messaging.phone_numbers',
      'messaging.sms_connection_attempts',
      'messaging.sms_deliveries',
    ])
      expect(await other.query(`select * from ${table}`), table).toEqual([]);
    expect(await readSmsConnections0(other.context, other.id)).toEqual([]);
    expect(await withTenant(db, other.context, (trx) => hasActiveSmsNumber(trx))).toBe(false);
    await expect(
      withTenant(db, other.context, (trx) => readSmsProviderNumbers(trx, other.id, a.connectionId)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses to register a number against another business’s connection', async () => {
    const a = await connected({ smsNumbers: 2 });
    const other = await business();
    await expect(
      runCommand(
        services,
        registerPhoneNumberCommand,
        {
          connectionId: a.connectionId,
          providerNumberRef: a.twilio.numbers[1]?.sid ?? '',
          name: 'Stolen',
        },
        other.invocation,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await other.query('select id from messaging.phone_numbers')).toEqual([]);
    expect(await other.query('select id from messaging.channel_accounts')).toEqual([]);
  });

  it('applies no callback that names another business’s message', async () => {
    const a = await connected();
    const b = await connected();
    const theirs = await b.send();
    const before = await b.snapshot();
    // Signed correctly by A's own connection, but about B's message.
    const webhookId = await a.callback(theirs, 'delivered');
    expect(await b.snapshot()).toEqual(before);
    expect(await a.webhook(webhookId)).toMatchObject({
      signature_valid: true,
      processed: true,
      error: 'message_not_found',
    });
  });

  it('sends nothing for a number whose connection belongs to another business', async () => {
    const a = await connected();
    const b = await connected();
    // The database allows this reference (the foreign key has no tenant); the code must not.
    await database.as('postgres', (sql) =>
      sql.query('update messaging.phone_numbers set provider_connection_id = $1 where id = $2', [
        a.connectionUuid,
        b.number.id,
      ]),
    );
    const messageId = await b.queue();
    await b.dispatch().run({ messageId }, b.job);
    expect(await b.message(messageId)).toMatchObject({
      status: 'failed',
      error_code: 'sms_number_unavailable',
    });
    expect(a.twilio.creates()).toEqual([]);
    expect(b.twilio.creates()).toEqual([]);
  });
});

describe('sending', () => {
  it('dispatches email and SMS once through their own real channel ports using one task', async () => {
    const c = await connected();
    const email = 'combined-recipient@example.test';
    const mailbox = await withTenant(db, c.context, async (trx) => {
      const secretId = await vault.store(
        trx,
        { agencyId: c.agency.id, businessId: c.id, purpose: 'mailbox.credentials' },
        JSON.stringify({
          name: 'Combined mailbox',
          email: 'combined-sender@example.test',
          displayName: 'Combined sender',
          smtp: {
            host: 'smtp.example.test',
            port: 465,
            security: 'tls',
            username: 'combined',
            password: 'fixture-mail-password',
          },
          imap: {
            host: 'imap.example.test',
            port: 993,
            security: 'tls',
            username: 'combined',
            password: 'fixture-mail-password',
          },
        }),
      );
      const account = await trx
        .insertInto('messaging.channel_accounts')
        .values({ business_id: c.id, channel: 'email', name: 'Combined mailbox' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('messaging.mailboxes')
        .values({
          business_id: c.id,
          id: account.id,
          email_address: 'combined-sender@example.test',
          display_name: 'Combined sender',
          auth_method: 'password',
          smtp_host: 'smtp.example.test',
          smtp_port: 465,
          smtp_security: 'tls',
          smtp_username: 'combined',
          secret_id: secretId,
        })
        .execute();
      const identity = await trx
        .insertInto('crm.contact_identities')
        .values({
          business_id: c.id,
          contact_id: c.contact.id,
          kind: 'email',
          value: email,
          value_normalized: email,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('messaging.consents')
        .values({
          business_id: c.id,
          contact_id: c.contact.id,
          channel: 'email',
          purpose: 'transactional',
          status: 'granted',
          source: 'user',
          recorded_by_kind: 'system',
        })
        .execute();
      return { accountId: account.id, identityId: identity.id };
    });
    const submitted: { readonly to: string; readonly text: string }[] = [];
    const submitter: MailboxSubmitter = {
      submit(_login, _from, message) {
        submitted.push(message);
        return Promise.resolve({ outcome: 'accepted', messageId: 'combined-smtp-message' });
      },
    };
    const ports = routeOutboundByChannel({
      email: createSmtpOutbound(vault, submitter, db, PUBLIC_URL),
      sms: createTwilioOutbound(vault, c.twilio.transport, db, PUBLIC_URL),
    });
    const task = createDispatchOutboundTask(ports.sender, ports.admission);
    const smsId = await c.queue();
    const emailId = await withTenant(db, c.context, (trx) =>
      queueOutboundMessage(trx, c.context, {
        ...mailbox,
        channel: 'email',
        purpose: 'transactional',
        lane: 'reply',
        idempotencyKey: randomUUID(),
        text: 'Combined email',
      }),
    );
    for (const messageId of [smsId, emailId, smsId, emailId]) await task.run({ messageId }, c.job);
    expect(c.twilio.creates()).toHaveLength(1);
    expect(submitted).toEqual([expect.objectContaining({ to: email, text: 'Combined email' })]);
    const sentSms = await c.message(smsId);
    expect(sentSms.status).toBe('sent');
    expect(sentSms.provider_message_id).toMatch(/^SM/);
    expect(await c.message(emailId)).toMatchObject({
      status: 'sent',
      provider_message_id: 'combined-smtp-message',
    });
    expect(
      await c.query('select id from messaging.outbound_dispatch where id in($1,$2)', [
        smsId,
        emailId,
      ]),
    ).toHaveLength(2);
  });

  it('sends once through the outbound pipeline and records what Twilio said', async () => {
    const c = await connected();
    const messageId = await c.queue('marketing', 'Sale & more = 100% + fun');
    await c.dispatch().run({ messageId }, c.job);
    // The job running again, as a queue may do, sends nothing more.
    await c.dispatch().run({ messageId }, c.job);
    expect(c.twilio.creates()).toHaveLength(1);
    const [request] = c.twilio.creates();
    expect(request?.path).toBe(`/2010-04-01/Accounts/${c.twilio.accountSid}/Messages.json`);
    expect(Object.fromEntries(new URLSearchParams(request?.body))).toEqual({
      To: c.phone,
      From: c.number.e164,
      Body: 'Sale & more = 100% + fun',
      // Our message id rides in the callback URL.
      StatusCallback: `${PUBLIC_URL}/webhooks/twilio/${c.token}/status?m=${messageId}`,
    });
    const stored = await c.message(messageId);
    expect(stored).toMatchObject({ status: 'sent', error_code: null });
    expect(stored.provider_message_id).toMatch(/^SM[0-9a-f]{32}$/);
    expect(await c.delivery(messageId)).toEqual({
      provider_status: 'queued',
      status_rank: 1,
      provider_error_code: null,
      segments: 1,
      conflicts: 0,
    });
  });

  it('queues one message for one idempotency key', async () => {
    const c = await connected();
    const input = {
      identityId: c.identityId,
      accountId: c.number.id,
      channel: 'sms',
      purpose: 'transactional',
      lane: 'transactional',
      idempotencyKey: randomUUID(),
      text: 'Once',
    } as const;
    const first = await withTenant(db, c.context, (trx) =>
      queueOutboundMessage(trx, c.context, input),
    );
    const second = await withTenant(db, c.context, (trx) =>
      queueOutboundMessage(trx, c.context, input),
    );
    expect(second).toBe(first);
    await c.dispatch().run({ messageId: first }, c.job);
    await c.dispatch().run({ messageId: second }, c.job);
    expect(c.twilio.creates()).toHaveLength(1);
  });

  it.each([
    ['a timeout', new DOMException('The operation timed out.', 'TimeoutError')],
    ['a server error', { status: 503, body: '' }],
    ['a success it cannot read', { status: 201, body: '<html>' }],
  ] as const)('leaves a send unknown after %s, and never sends it again', async (_what, answer) => {
    const c = await connected();
    c.twilio.state.create = answer;
    const messageId = await c.send();
    expect(await c.message(messageId)).toMatchObject({
      status: 'unknown',
      error_code: 'delivery_unknown',
      provider_message_id: null,
    });
    expect(c.twilio.creates()).toHaveLength(1);
    // Twilio is healthy again; the job is run again and again. Nothing is sent.
    c.twilio.state.create = 'created';
    await c.dispatch().run({ messageId }, c.job);
    await c.dispatch().run({ messageId }, c.job);
    expect(c.twilio.creates()).toHaveLength(1);
    expect(await c.message(messageId)).toMatchObject({ status: 'unknown' });
    expect(await c.delivery(messageId)).toBeUndefined();
  });

  it('does not send again when the worker died between the request and its record', async () => {
    const c = await connected();
    const messageId = await c.queue();
    // The state a crash leaves: reserved, "sending", never finished.
    await c.query('update messaging.outbound_dispatch set reserved_at = now() where id = $1', [
      messageId,
    ]);
    await c.query("update messaging.messages set status = 'sending' where id = $1", [messageId]);
    await c.dispatch().run({ messageId }, c.job);
    expect(c.twilio.creates()).toEqual([]);
    expect(await c.message(messageId)).toMatchObject({ status: 'unknown' });
  });

  it('records Twilio’s refusal with its error code', async () => {
    const c = await connected();
    c.twilio.state.create = {
      status: 400,
      body: JSON.stringify(await fixtureJson('error-21211.json')),
    };
    const messageId = await c.send();
    expect(await c.message(messageId)).toMatchObject({
      status: 'failed',
      error_code: 'delivery_rejected',
      failed: true,
    });
    expect(await c.delivery(messageId)).toMatchObject({
      provider_status: 'rejected',
      status_rank: 4,
      provider_error_code: 21211,
    });
    expect(c.twilio.creates()).toHaveLength(1);
  });

  it('applies the existing policy and the SMS limits before anything reaches Twilio', async () => {
    const c = await connected();
    const tooLong = await c.queue('transactional', 'x'.repeat(1601));
    await c.dispatch().run({ messageId: tooLong }, c.job);
    expect(await c.message(tooLong)).toMatchObject({
      status: 'failed',
      error_code: 'sms_body_too_long',
    });
    await c.query(
      "insert into messaging.suppressions (business_id,channel,address_normalized,reason) values (app.business_id(),'sms',$1,'manual')",
      [c.phone],
    );
    const suppressed = await c.queue();
    expect(await c.message(suppressed)).toMatchObject({
      status: 'failed',
      error_code: 'suppressed',
    });
    expect(c.twilio.creates()).toEqual([]);
  });

  it('refuses to send when the install has no public HTTPS address for callbacks', async () => {
    const c = await connected();
    const local = createTwilioOutbound(vault, c.twilio.transport, db, 'http://localhost:3000');
    const messageId = await c.queue();
    await createDispatchOutboundTask(local.sender, local.admission).run({ messageId }, c.job);
    expect(await c.message(messageId)).toMatchObject({
      status: 'failed',
      error_code: 'status_callback_unavailable',
    });
    expect(c.twilio.creates()).toEqual([]);
  });
});

describe('receiving a webhook (stage one: stored, not yet verified)', () => {
  it('stores the raw request exactly and queues its verification, believing nothing', async () => {
    const c = await connected();
    const messageId = await c.send();
    const before = await c.snapshot();
    const params = {
      AccountSid: c.twilio.accountSid,
      MessageSid: `SM${hex(32)}`,
      MessageStatus: 'delivered',
      Odd: '  spaced + plus  ',
    };
    const webhookId = await c.receive({ kind: 'status', messageId }, params);
    const stored = await c.webhook(webhookId);
    expect(stored).toMatchObject({
      signature_valid: null,
      processed: false,
      error: null,
      endpoint: `status?m=${messageId}`,
      business_id: c.id,
    });
    expect(Buffer.from(stored.body).toString('utf8')).toBe(new URLSearchParams(params).toString());
    // Only the headers verification needs; never a cookie, and never the URL's token.
    expect(Object.keys(stored.headers).sort()).toEqual(['content-type', 'x-twilio-signature']);
    expect(JSON.stringify(stored)).not.toContain(c.token);
    // Stored is not applied: nothing has changed until a worker verifies it.
    expect(await c.snapshot()).toEqual(before);
    const jobs = await database.as('postgres', (sql) =>
      sql.query<{ payload: { businessId: string; data: { webhookId: string } } }>(
        `select p.payload from graphile_worker.jobs j
         join graphile_worker._private_jobs p on p.id = j.id
         where j.task_identifier = 'sms.apply_webhook' and p.payload->'data'->>'webhookId' = $1`,
        [webhookId],
      ),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({ businessId: c.id, agencyId: c.agency.id });
  });

  it('stores nothing for an unknown token, a missing signature or an oversized body', async () => {
    const c = await connected();
    const count = async () =>
      (await database.as('postgres', (sql) => sql.query('select id from intake.webhooks'))).length;
    const before = await count();
    const good = {
      token: c.token,
      endpoint: { kind: 'inbound' } as const,
      headers: { 'x-twilio-signature': 'A'.repeat(27) + '=' },
      body: Buffer.from('Body=hi'),
    };
    expect(await acceptSmsWebhook(db, { ...good, token: 'Z'.repeat(43) })).toEqual({
      outcome: 'unknown',
    });
    expect(await acceptSmsWebhook(db, { ...good, token: 'short' })).toEqual({ outcome: 'unknown' });
    expect(await acceptSmsWebhook(db, { ...good, headers: {} })).toEqual({ outcome: 'refused' });
    expect(
      await acceptSmsWebhook(db, { ...good, headers: { 'x-twilio-signature': 'not-a-signature' } }),
    ).toEqual({ outcome: 'refused' });
    expect(await acceptSmsWebhook(db, { ...good, body: Buffer.alloc(65_537, 0x61) })).toEqual({
      outcome: 'refused',
    });
    expect(
      await acceptSmsWebhook(db, {
        ...good,
        endpoint: { kind: 'status', messageId: 'not-a-uuid' },
      }),
    ).toEqual({ outcome: 'refused' });
    expect(await count()).toBe(before);
    expect((await acceptSmsWebhook(db, good)).outcome).toBe('accepted');
    expect(await count()).toBe(before + 1);
  });

  it('refuses more once a connection has 500 requests waiting, and recovers when they are handled', async () => {
    const c = await connected();
    await database.as('postgres', (sql) =>
      sql.query(
        // Historical backlog isolates the waiting-row cap from the rolling-minute cap.
        `insert into intake.webhooks (provider, endpoint, headers, body, signature_valid, business_id, provider_connection_id, received_at)
         select 'twilio', 'inbound', '{}', ''::bytea, null, $1, $2, clock_timestamp() - interval '2 minutes'
         from generate_series(1, 500)`,
        [c.id, c.connectionUuid],
      ),
    );
    const request = {
      token: c.token,
      endpoint: { kind: 'inbound' } as const,
      headers: { 'x-twilio-signature': 'A'.repeat(27) + '=' },
      body: Buffer.from('Body=hi'),
    };
    expect(await acceptSmsWebhook(db, request)).toEqual({ outcome: 'over_capacity' });
    // Another connection is not affected by this one's backlog.
    const other = await connected();
    expect((await acceptSmsWebhook(db, { ...request, token: other.token })).outcome).toBe(
      'accepted',
    );
    await database.as('postgres', (sql) =>
      sql.query(
        'update intake.webhooks set processed_at = now() where provider_connection_id = $1',
        [c.connectionUuid],
      ),
    );
    expect((await acceptSmsWebhook(db, request)).outcome).toBe('accepted');
  });

  it('stores nothing for a disconnected connection', async () => {
    const c = await connected();
    await database.as('postgres', (sql) =>
      sql.query("update messaging.provider_connections set status = 'disconnected' where id = $1", [
        c.connectionUuid,
      ]),
    );
    expect(
      await acceptSmsWebhook(db, {
        token: c.token,
        endpoint: { kind: 'inbound' },
        headers: { 'x-twilio-signature': 'A'.repeat(27) + '=' },
        body: Buffer.from('Body=hi'),
      }),
    ).toEqual({ outcome: 'unknown' });
  });

  it('removes stored webhooks past their retention, and only those', async () => {
    const c = await connected();
    const kept = await c.callback(await c.send(), 'delivered');
    const bad = await c.callback(await c.send(), 'delivered', {}, { authToken: 'wrong-token' });
    const old = await c.callback(await c.send(), 'delivered');
    await database.as('postgres', async (sql) => {
      await sql.query(
        "update intake.webhooks set received_at = now() - interval '2 days' where id = any($1)",
        [[kept, bad]],
      );
      await sql.query(
        "update intake.webhooks set received_at = now() - interval '31 days' where id = $1",
        [old],
      );
    });
    expect(await expireSmsWebhooks(services)).toBeGreaterThanOrEqual(2);
    const left = await database.as('postgres', (sql) =>
      sql.query<{ id: string }>('select id from intake.webhooks where id = any($1)', [
        [kept, bad, old],
      ]),
    );
    expect(left).toEqual([{ id: kept }]);
  });
});

describe('status callbacks (stage two: verified, then applied)', () => {
  it('waits at the business before locking a message that a concurrent dispatch writer can change', async () => {
    const c = await connected();
    const messageId = await c.send();
    const sent = await c.message(messageId);
    if (sent.provider_message_id === null) throw new Error('The send has no provider SID.');
    const webhookId = await c.receive(
      { kind: 'status', messageId },
      {
        AccountSid: c.twilio.accountSid,
        MessageSid: sent.provider_message_id,
        MessageStatus: 'delivered',
      },
    );
    let callback: Promise<PromiseSettledResult<unknown>[]> | undefined;
    const [writer] = await Promise.allSettled([
      database.withTenant(c.context, async (held) => {
        await held.query('select id from tenancy.businesses where id=$1 for update', [c.id]);
        const owner = await held.one<{ pid: number }>('select pg_backend_pid() as pid');
        callback = Promise.allSettled([c.apply(webhookId)]);
        const deadline = Date.now() + 3000;
        let blocked = false;
        while (Date.now() < deadline) {
          const observed = await database.as('postgres', (sql) =>
            sql.one<{ waiting: boolean }>(
              'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as waiting',
              [owner.pid],
            ),
          );
          if (observed.waiting) {
            blocked = true;
            break;
          }
          await delay(5);
        }
        expect(blocked).toBe(true);
        // A writer using the dispatcher's business-first order must still acquire the
        // message. Otherwise the callback holds it while waiting on the writer's FK.
        await held.query(
          'select id from messaging.messages where business_id=$1 and id=$2 for update nowait',
          [c.id, messageId],
        );
      }),
    ]);
    if (callback === undefined) throw new Error('The callback did not start.');
    const [applied] = await callback;
    const outcome = (result: PromiseSettledResult<unknown> | undefined) =>
      result?.status === 'fulfilled' ? 'ok' : String(result?.reason);
    expect([outcome(writer), outcome(applied)]).toEqual(['ok', 'ok']);
    expect(await c.message(messageId)).toMatchObject({ status: 'delivered' });
  });

  it('applies a callback signed with the connection’s Auth Token', async () => {
    const c = await connected();
    const messageId = await c.send();
    const webhookId = await c.callback(messageId, 'delivered', {
      BrandNewProperty: 'ignored but signed',
    });
    expect(await c.message(messageId)).toMatchObject({
      status: 'delivered',
      delivered: true,
      failed: false,
    });
    expect(await c.delivery(messageId)).toMatchObject({
      provider_status: 'delivered',
      status_rank: 4,
    });
    expect(await c.webhook(webhookId)).toMatchObject({
      signature_valid: true,
      processed: true,
      error: null,
    });
    expect(c.results).toEqual(['applied']);
    expect(
      await c.query("select type from events.events where type = 'message.delivered'"),
    ).toHaveLength(1);
    const audits = await c.query<{ input: unknown }>(
      "select input from audit.commands where command = 'sms.apply_status'",
    );
    expect(audits).toEqual([{ input: { webhookId, messageId } }]);
  });

  it('rejects a callback with an invalid signature: nothing changes anywhere', async () => {
    const c = await connected();
    const messageId = await c.send();
    const before = await c.snapshot();
    // Whoever sent this knows the URL and the message, but not the Auth Token.
    const webhookId = await c.callback(
      messageId,
      'failed',
      { ErrorCode: '30003' },
      { authToken: 'guessed-token' },
    );
    expect(await c.snapshot()).toEqual(before);
    expect(await c.message(messageId)).toMatchObject({ status: 'sent' });
    expect(await c.webhook(webhookId)).toMatchObject({
      signature_valid: false,
      processed: true,
      error: 'invalid_signature',
    });
    expect(c.results).toEqual(['invalid_signature']);
    // Many forged requests do not mark the connection as failing or change it at all.
    for (let round = 0; round < 5; round += 1)
      await c.callback(messageId, 'failed', {}, { authToken: 'guessed-token' });
    expect(await c.snapshot()).toEqual(before);
    // The genuine callback still applies afterwards.
    await c.callback(messageId, 'delivered');
    expect(await c.message(messageId)).toMatchObject({ status: 'delivered' });
  });

  it('applies nothing for an unverified webhook, even when the command is run directly', async () => {
    const c = await connected();
    const messageId = await c.send();
    const sid = (await c.message(messageId)).provider_message_id ?? '';
    const webhookId = await c.receive(
      { kind: 'status', messageId },
      { AccountSid: c.twilio.accountSid, MessageSid: sid, MessageStatus: 'delivered' },
    );
    const before = await c.snapshot();
    const input = {
      webhookId,
      messageId,
      accountSid: c.twilio.accountSid,
      messageSid: sid,
      status: 'delivered',
      errorCode: null,
    };
    expect(await runCommand(services, applySmsStatusCommand, input, c.invocation)).toBe('ignored');
    expect(await c.snapshot()).toEqual(before);
    // And never for anyone but the worker's system actor.
    await expect(
      runCommand(services, applySmsStatusCommand, input, {
        context: { ...c.context, actorKind: 'user', actorId: randomUUID() },
        permissions: 'all',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('ignores a signed callback about another account, another SID, or a message never sent', async () => {
    const c = await connected();
    const messageId = await c.send();
    const before = await c.snapshot();
    const first = await c.callback(messageId, 'delivered', { AccountSid: `AC${hex(32)}` });
    expect(await c.webhook(first)).toMatchObject({
      signature_valid: true,
      error: 'account_mismatch',
    });
    const second = await c.callback(messageId, 'delivered', { MessageSid: `SM${hex(32)}` });
    expect(await c.webhook(second)).toMatchObject({ signature_valid: true, error: 'sid_mismatch' });
    const queued = await c.queue();
    const third = await c.callback(queued, 'delivered');
    expect(await c.webhook(third)).toMatchObject({
      signature_valid: true,
      error: 'message_not_sent',
    });
    const fourth = await c.callback(messageId, 'something_new');
    expect(await c.webhook(fourth)).toMatchObject({
      signature_valid: true,
      error: 'status_not_used',
    });
    const after = await c.snapshot();
    // Queueing added a message; nothing else differs.
    expect(after.deliveries).toEqual(before.deliveries);
    expect(after.messages.filter((each) => each['id'] === messageId)).toEqual(
      before.messages.filter((each) => each['id'] === messageId),
    );
    expect(await c.message(queued)).toMatchObject({ status: 'queued' });
  });

  const permutations = <T>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
            item,
            ...rest,
          ]),
        );

  it.each([
    [
      ['sending', 'sent', 'delivered'],
      { status: 'delivered', error_code: null, delivered: true, failed: false },
    ],
    [
      ['sent', 'undelivered'],
      {
        status: 'failed',
        error_code: 'twilio_30003',
        error_detail: 'undelivered',
        delivered: false,
        failed: true,
      },
    ],
  ] as const)(
    'ends the same for every arrival order of %j, and for repeats',
    async (sequence, end) => {
      const c = await connected();
      const extra = (status: string): Record<string, string> =>
        status === 'undelivered' ? { ErrorCode: '30003' } : {};
      for (const order of permutations<string>(sequence)) {
        const messageId = await c.send();
        // Every callback twice: the second of each must change nothing.
        for (const status of [...order, ...order])
          await c.callback(messageId, status, extra(status));
        expect(await c.message(messageId), order.join(' > ')).toMatchObject(end);
        expect((await c.delivery(messageId))?.provider_status, order.join(' > ')).toBe(
          sequence.at(-1),
        );
      }
    },
  );

  it('never moves a message backwards: a late "sent" does not undo "delivered"', async () => {
    const c = await connected();
    const messageId = await c.send();
    await c.callback(messageId, 'delivered');
    const before = await c.snapshot();
    for (const late of ['queued', 'sending', 'sent', 'delivered'])
      await c.callback(messageId, late);
    expect(await c.snapshot()).toEqual(before);
    expect(c.results).toEqual(['applied', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);
  });

  it('keeps the first final status and counts the contradiction', async () => {
    const c = await connected();
    const delivered = await c.send();
    await c.callback(delivered, 'delivered');
    await c.callback(delivered, 'failed', { ErrorCode: '30008' });
    expect(await c.message(delivered)).toMatchObject({
      status: 'delivered',
      error_code: null,
      failed: false,
    });
    expect(await c.delivery(delivered)).toMatchObject({
      provider_status: 'delivered',
      conflicts: 1,
    });
    const failed = await c.send();
    await c.callback(failed, 'failed', { ErrorCode: '30008' });
    await c.callback(failed, 'delivered');
    expect(await c.message(failed)).toMatchObject({
      status: 'failed',
      error_code: 'twilio_30008',
      delivered: false,
    });
    expect(await c.delivery(failed)).toMatchObject({ provider_status: 'failed', conflicts: 1 });
  });

  it('settles an unknown send from its callback, filling in the SID', async () => {
    const c = await connected();
    c.twilio.state.create = new Error('socket hang up');
    const messageId = await c.send();
    expect(await c.message(messageId)).toMatchObject({
      status: 'unknown',
      provider_message_id: null,
    });
    const sid = `SM${hex(32)}`;
    await c.callback(messageId, 'sent', { MessageSid: sid });
    expect(await c.message(messageId)).toEqual({
      status: 'sent',
      provider_message_id: sid,
      error_code: null,
      error_detail: null,
      delivered: false,
      failed: false,
    });
    await c.callback(messageId, 'delivered', { MessageSid: sid });
    expect(await c.message(messageId)).toMatchObject({ status: 'delivered' });
    // Still exactly one request to Twilio.
    expect(c.twilio.creates()).toHaveLength(1);
  });

  it('waits for a send still being recorded, then applies, and is not overwritten by it', async () => {
    const c = await connected();
    const messageId = await c.queue();
    // The moment between Twilio's answer and the dispatcher's record of it.
    await c.query('update messaging.outbound_dispatch set reserved_at = now() where id = $1', [
      messageId,
    ]);
    await c.query("update messaging.messages set status = 'sending' where id = $1", [messageId]);
    const webhookId = await c.callback(messageId, 'delivered');
    expect(c.results).toEqual(['waiting']);
    expect(await c.message(messageId)).toMatchObject({ status: 'sending' });
    expect(await c.webhook(webhookId)).toMatchObject({ signature_valid: true, processed: false });
    // Queued again for later, under the same key: one job, not two.
    const jobs = await database.as('postgres', (sql) =>
      sql.query<{ later: boolean }>(
        'select run_at > now() as later from graphile_worker.jobs where key = $1',
        [`sms-webhook:${webhookId}`],
      ),
    );
    expect(jobs).toEqual([{ later: true }]);
    // The dispatcher never comes back. Past the wait, the callback is the record.
    await database.as('postgres', (sql) =>
      sql.query(
        "update intake.webhooks set received_at = now() - interval '3 minutes' where id = $1",
        [webhookId],
      ),
    );
    await c.apply(webhookId);
    expect(await c.message(messageId)).toMatchObject({ status: 'delivered' });
    expect(
      await c.query(
        'select finished_at is not null as finished from messaging.outbound_dispatch where id = $1',
        [messageId],
      ),
    ).toEqual([{ finished: true }]);
    // The dispatch job retried later must not put the message back to "unknown".
    await c.dispatch().run({ messageId }, c.job);
    expect(await c.message(messageId)).toMatchObject({ status: 'delivered' });
    expect(c.twilio.creates()).toEqual([]);
  });

  it('applies a stored callback once, however often it is replayed', async () => {
    const c = await connected();
    const messageId = await c.send();
    const webhookId = await c.callback(messageId, 'undelivered', { ErrorCode: '30005' });
    const before = await c.snapshot();
    const stored = await c.webhook(webhookId);
    await c.apply(webhookId);
    await withTenant(db, c.context, (trx) => replaySmsWebhook(trx, webhookId));
    await c.apply(webhookId);
    expect(await c.snapshot()).toEqual(before);
    expect(await c.webhook(webhookId)).toEqual(stored);
    expect(c.results).toEqual(['applied', 'unchanged', 'unchanged']);
    // Another business can't queue it.
    const other = await business();
    await expect(
      withTenant(db, other.context, (trx) => replaySmsWebhook(trx, webhookId)),
    ).rejects.toThrow();
  });

  it('does nothing when run in another business than the webhook’s own', async () => {
    const c = await connected();
    const other = await business();
    const messageId = await c.send();
    const sid = (await c.message(messageId)).provider_message_id ?? '';
    const webhookId = await c.receive(
      { kind: 'status', messageId },
      { AccountSid: c.twilio.accountSid, MessageSid: sid, MessageStatus: 'delivered' },
    );
    const before = await c.snapshot();
    await createApplySmsWebhookTask(vault, PUBLIC_URL).run({ webhookId }, other.job);
    expect(await c.snapshot()).toEqual(before);
    expect(await c.webhook(webhookId)).toMatchObject({ signature_valid: null, processed: false });
  });
});

describe('inbound messages, STOP, START and HELP', () => {
  it('stores an ordinary message in the sender’s conversation and changes no consent', async () => {
    const c = await connected();
    const consents = await c.consents();
    const { webhookId, sid } = await c.inbound('Please stop by the office when you can');
    const messages = await c.query(
      "select channel,direction,status,body_text,from_address,to_addresses,provider_message_id,author_kind,author_id,channel_account_id from messaging.messages where direction='inbound'",
    );
    expect(messages).toEqual([
      {
        channel: 'sms',
        direction: 'inbound',
        status: 'received',
        body_text: 'Please stop by the office when you can',
        from_address: c.phone,
        to_addresses: [c.number.e164],
        provider_message_id: sid,
        author_kind: 'contact',
        author_id: c.contact.id,
        channel_account_id: c.number.id,
      },
    ]);
    expect(
      await c.query(
        'select contact_id,needs_reply,unread_count,status from messaging.conversations',
      ),
    ).toEqual([{ contact_id: c.contact.id, needs_reply: true, unread_count: 1, status: 'open' }]);
    // A sentence containing "stop" unsubscribes nobody.
    expect(await c.consents()).toEqual(consents);
    expect(await c.webhook(webhookId)).toMatchObject({
      signature_valid: true,
      processed: true,
      error: null,
    });
    const audits = await c.query<{ input: unknown }>(
      "select input from audit.commands where command = 'sms.receive'",
    );
    expect(audits).toEqual([{ input: { webhookId, messageSid: sid } }]);
    expect(JSON.stringify(audits)).not.toContain(c.phone);
  });

  it('says of a contact it makes that it came from a text message', async () => {
    const c = await connected();
    await c.inbound('Hello from a new number', { From: '+254799000111' });
    expect(
      await c.query(
        `select c.created_by_kind, c.created_source from crm.contacts c
         join crm.contact_identities i on i.contact_id = c.id
         where i.value_normalized = '+254799000111'`,
      ),
    ).toEqual([{ created_by_kind: 'system', created_source: 'sms' }]);
  });

  it('files a message from a contact’s additional number under that contact, and makes no new one', async () => {
    const c = await connected();
    // A second, labelled number that is not the primary one, as the contact page adds it.
    await database.as('crm_owner', (sql) =>
      sql.query(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized, label)
         select business_id, id, 'phone', '+254799123456', '+254799123456', 'work'
         from crm.contacts where id = $1`,
        [c.contact.id],
      ),
    );
    await c.inbound('From my work phone', { From: '+254799123456' });
    expect(
      await c.query(
        `select m.from_address, m.author_id, v.contact_id from messaging.messages m
         join messaging.conversations v on v.id = m.conversation_id where m.direction = 'inbound'`,
      ),
    ).toEqual([
      { from_address: '+254799123456', author_id: c.contact.id, contact_id: c.contact.id },
    ]);
    expect(await c.query('select id from crm.contacts')).toHaveLength(1);
  });

  it('blocks a message from a contact with inbound do not disturb: nothing is kept, told or started, and a keyword only changes consent', async () => {
    const c = await connected();
    await c.query('update crm.contacts set dnd_inbound = true where id = $1', [c.contact.id]);
    const consents = await c.consents();
    const { webhookId } = await c.inbound('Are you open on Sunday?');
    expect(await c.query("select id from messaging.messages where direction='inbound'")).toEqual(
      [],
    );
    expect(await c.query('select id from messaging.conversations')).toEqual([]);
    expect(await c.query("select type from events.events where type = 'message.received'")).toEqual(
      [],
    );
    expect(await c.consents()).toEqual(consents);
    // Handled, and why it went no further, as a webhook that was ignored says it.
    expect(await c.webhook(webhookId)).toMatchObject({
      signature_valid: true,
      processed: true,
      error: 'inbound_dnd',
    });
    // A keyword does only what compliance needs: STOP withdraws consent, with the message's
    // SID as its proof. No message is stored for it, nobody is told, nothing starts, and
    // nothing is sent back from here (Twilio answers the keywords itself).
    const stop = await c.inbound('STOP');
    const withdrawn = await c.consents();
    expect(withdrawn.slice(-2).map((each) => [each.status, each.source, each.proof])).toEqual([
      ['withdrawn', 'keyword', { keyword: 'STOP', providerMessageId: stop.sid }],
      ['withdrawn', 'keyword', { keyword: 'STOP', providerMessageId: stop.sid }],
    ]);
    // Twilio delivering the same STOP again is the same withdrawal: nothing more is kept.
    await c.inbound('STOP', { MessageSid: stop.sid, SmsSid: stop.sid, SmsMessageSid: stop.sid });
    expect(await c.consents()).toEqual(withdrawn);
    // HELP changes no consent, so nothing at all is kept of it.
    await c.inbound('HELP');
    expect(await c.consents()).toEqual(withdrawn);
    // START gives back what the STOP took, as it does for anyone.
    await c.inbound('START');
    expect((await c.consents()).slice(-2).map((each) => [each.status, each.source])).toEqual([
      ['granted', 'keyword'],
      ['granted', 'keyword'],
    ]);
    expect(await c.query("select id from messaging.messages where direction='inbound'")).toEqual(
      [],
    );
    expect(await c.query('select id from messaging.conversations')).toEqual([]);
    expect(
      await c.query(
        "select type from events.events where type in ('message.received', 'sms.help_requested')",
      ),
    ).toEqual([]);
    expect(c.twilio.creates()).toEqual([]);
    // Inbound do not disturb stops nothing sent, and turned off, messages arrive again.
    await c.query('update crm.contacts set dnd_inbound = false where id = $1', [c.contact.id]);
    await c.inbound('Thanks, see you then');
    expect(
      await c.query<{ body_text: string }>(
        "select body_text from messaging.messages where direction='inbound' order by id",
      ),
    ).toEqual([{ body_text: 'Thanks, see you then' }]);
  });

  it('blocks by number: a number a contact with inbound do not disturb has is blocked, and only in that business', async () => {
    const c = await connected();
    await c.query('update crm.contacts set dnd_inbound = true where id = $1', [c.contact.id]);
    expect(
      await withTenant(db, c.context, (trx) => inboundDoNotDisturbFrom(trx, c.id, c.phone)),
    ).toBe(true);
    expect(
      await withTenant(db, c.context, (trx) => inboundDoNotDisturbFrom(trx, c.id, '+254799000222')),
    ).toBe(false);
    // Another business with a contact of the same number sees only its own setting.
    const other = await connected();
    await other.query(
      "insert into crm.contact_identities (business_id,contact_id,kind,value,value_normalized) values (app.business_id(),$1,'phone',$2,$2)",
      [other.contact.id, c.phone],
    );
    expect(
      await withTenant(db, other.context, (trx) => inboundDoNotDisturbFrom(trx, other.id, c.phone)),
    ).toBe(false);
    await c.query('update crm.contacts set dnd_inbound = false where id = $1', [c.contact.id]);
    await other.query('update crm.contacts set dnd_inbound = true where id = $1', [
      other.contact.id,
    ]);
    expect(
      await withTenant(db, c.context, (trx) => inboundDoNotDisturbFrom(trx, c.id, c.phone)),
    ).toBe(false);
  });

  it('STOP blocks marketing sends immediately, including one already queued', async () => {
    const c = await connected();
    // Sending works before the STOP.
    await c.send('marketing');
    expect(c.twilio.creates()).toHaveLength(1);
    // Queued before the STOP, dispatched after it.
    const waiting = await c.queue('marketing');

    const { sid } = await c.inbound(' stop ');
    const ledger = await c.consents();
    expect(ledger.slice(-2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ purpose: 'marketing', status: 'withdrawn', source: 'keyword' }),
        expect.objectContaining({
          purpose: 'transactional',
          status: 'withdrawn',
          source: 'keyword',
        }),
      ]),
    );
    expect(ledger.at(-1)?.proof).toMatchObject({ keyword: 'STOP', providerMessageId: sid });

    await c.dispatch().run({ messageId: waiting }, c.job);
    expect(await c.message(waiting)).toMatchObject({
      status: 'failed',
      error_code: 'consent_withdrawn',
    });
    const next = await c.queue('marketing');
    expect(await c.message(next)).toMatchObject({
      status: 'failed',
      error_code: 'consent_withdrawn',
    });
    const transactional = await c.queue('transactional');
    expect(await c.message(transactional)).toMatchObject({
      status: 'failed',
      error_code: 'consent_withdrawn',
    });
    // Nothing more reached Twilio after the STOP.
    expect(c.twilio.creates()).toHaveLength(1);
    expect(
      await c.query("select type from events.events where type = 'consent.withdrawn'"),
    ).toHaveLength(2);
  });

  it.each([
    'STOP',
    'Unsubscribe',
    'END',
    'quit',
    'STOPALL',
    'revoke',
    'OPTOUT',
    'cancel',
    'Stop.',
    // 47 CFR 64.1200(a)(10): "opt out" in any spelling, and plain words a reasonable person
    // reads as revoking consent.
    'OPT OUT',
    'opt-out',
    'Opt out',
    'STOP ALL',
    'Please stop texting me',
  ])('reads %j as an opt-out, for the number it came from', async (body) => {
    const c = await connected();
    await c.inbound(body);
    const withdrawn = (await c.consents()).filter((each) => each.status === 'withdrawn');
    expect(withdrawn).toHaveLength(2);
    expect(withdrawn.map((each) => each.address_normalized)).toEqual([c.phone, c.phone]);
  });

  it('trusts Twilio’s own verdict (OptOutType) over the text', async () => {
    const c = await connected();
    await c.inbound('ARRET', { OptOutType: 'STOP' });
    const withdrawn = (await c.consents()).filter((each) => each.status === 'withdrawn');
    expect(withdrawn).toHaveLength(2);
    expect(withdrawn[0]?.proof).toMatchObject({ keyword: 'STOP' });
  });

  it('START gives back what STOP took, and nothing a keyword did not take', async () => {
    const c = await connected();
    // Nobody stopped: START grants nothing new.
    const before = await c.consents();
    await c.inbound('START');
    expect(await c.consents()).toEqual(before);
    await c.inbound('STOP');
    await c.inbound('start');
    const ledger = await c.consents();
    expect(ledger.slice(-2).map((each) => [each.status, each.source])).toEqual([
      ['granted', 'keyword'],
      ['granted', 'keyword'],
    ]);
    await c.send('marketing');
    expect(c.twilio.creates()).toHaveLength(1);
    // A withdrawal a person recorded is not undone by a keyword.
    await c.query(
      "insert into messaging.consents (business_id,contact_id,channel,purpose,status,source,proof,recorded_by_kind) values (app.business_id(),$1,'sms','marketing','withdrawn','user','{\"note\":\"asked by phone\"}','system')",
      [c.contact.id],
    );
    await c.inbound('START');
    const refused = await c.queue('marketing');
    expect(await c.message(refused)).toMatchObject({
      status: 'failed',
      error_code: 'consent_withdrawn',
    });
  });

  it('does not take "yes" for consent', async () => {
    const c = await connected();
    await c.inbound('STOP');
    const after = await c.consents();
    await c.inbound('YES');
    expect(await c.consents()).toEqual(after);
  });

  it('HELP changes no consent and reports the request', async () => {
    const c = await connected();
    const before = await c.consents();
    await c.inbound('help');
    expect(await c.consents()).toEqual(before);
    expect(
      await c.query("select type from events.events where type = 'sms.help_requested'"),
    ).toHaveLength(1);
    // No reply is sent from here.
    expect(c.twilio.creates()).toEqual([]);
  });

  it('applies a stored STOP once, however often it is replayed or redelivered', async () => {
    const c = await connected();
    const { webhookId, sid } = await c.inbound('STOP');
    const before = await c.snapshot();
    await c.apply(webhookId);
    await withTenant(db, c.context, (trx) => replaySmsWebhook(trx, webhookId));
    await c.apply(webhookId);
    // Twilio delivering the same message again is a second stored webhook with the same SID.
    await c.inbound('STOP', { MessageSid: sid, SmsSid: sid, SmsMessageSid: sid });
    expect(await c.snapshot()).toEqual(before);
    expect(
      await c.query("select id from messaging.messages where direction='inbound'"),
    ).toHaveLength(1);
  });

  it('rejects an inbound STOP with an invalid signature: nobody is unsubscribed', async () => {
    const c = await connected();
    const before = await c.snapshot();
    const { webhookId } = await c.inbound('STOP', {}, { authToken: 'guessed-token' });
    expect(await c.snapshot()).toEqual(before);
    expect(await c.webhook(webhookId)).toMatchObject({
      signature_valid: false,
      error: 'invalid_signature',
    });
    await c.send('marketing');
    expect(c.twilio.creates()).toHaveLength(1);
  });

  it('creates a contact for a number nobody has, and honours its STOP', async () => {
    const c = await connected();
    const stranger = usNumber();
    await c.inbound('STOP', { From: stranger });
    const [identity] = await c.query<{ contact_id: string }>(
      "select contact_id from crm.contact_identities where kind='phone' and value_normalized=$1",
      [stranger],
    );
    expect(identity).toBeDefined();
    expect(
      await c.query(
        'select purpose,status from messaging.consents where contact_id=$1 order by purpose',
        [identity?.contact_id],
      ),
    ).toEqual([
      { purpose: 'marketing', status: 'withdrawn' },
      { purpose: 'transactional', status: 'withdrawn' },
    ]);
  });

  it('keeps a STOP from a contact in the trash', async () => {
    const c = await connected();
    await database.as('postgres', (sql) =>
      sql.query('update crm.contacts set deleted_at = now() where id = $1', [c.contact.id]),
    );
    await c.inbound('STOP');
    expect((await c.consents()).filter((each) => each.status === 'withdrawn')).toHaveLength(2);
  });

  it('ignores a message for a number this business has not registered, or from no usable number', async () => {
    const c = await connected();
    const before = await c.snapshot();
    const first = await c.inbound('STOP', { To: usNumber() });
    expect(await c.webhook(first.webhookId)).toMatchObject({
      signature_valid: true,
      error: 'number_not_registered',
    });
    const second = await c.inbound('STOP', { From: 'ACME' });
    expect(await c.webhook(second.webhookId)).toMatchObject({
      signature_valid: true,
      error: 'sender_unresolved',
    });
    expect(await c.snapshot()).toEqual(before);
  });

  it('records inbound messages only for the worker’s system actor', async () => {
    const c = await connected();
    await expect(
      runCommand(
        services,
        receiveSmsCommand,
        {
          webhookId: randomUUID(),
          accountSid: c.twilio.accountSid,
          messageSid: `SM${hex(32)}`,
          from: c.phone,
          to: c.number.e164,
          body: 'STOP',
          optOutType: null,
        },
        { context: { ...c.context, actorKind: 'user', actorId: randomUUID() }, permissions: 'all' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('inbound email and inbound SMS of one business at once', () => {
  /** Resolves once exactly `count` sessions of this database wait for a lock. */
  async function lockWaits(count: number): Promise<void> {
    let seen = -1;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      // Another role's wait events are hidden from crm_app, so the superuser watches.
      const row = await database.as('postgres', (sql) =>
        sql.one<{ waiting: number }>(
          `select count(*)::int as waiting from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'`,
        ),
      );
      seen = row.waiting;
      if (seen === count) return;
      await delay(50);
    }
    throw new Error(
      `Expected ${String(count)} session(s) waiting for a lock, saw ${String(seen)}.`,
    );
  }

  // Both look up and create unknown senders under the business's `inbound-senders` advisory
  // lock, and both need the business row: the mailbox sync FOR SHARE, the SMS command FOR
  // UPDATE. Every writer takes the business first. A sync that took the advisory lock first
  // held it while it waited for the business, which an SMS command held while it waited for
  // the advisory lock: PostgreSQL ended one of them as a deadlock (40P01). Here the sync is
  // stopped at its mailbox row, after its first locks, until the SMS command is waiting
  // too; then both must finish.
  it('finish one after the other, whichever asks for the business first', async () => {
    const c = await connected();
    const mailbox = await database.withTenant(c.context, async (sql) => {
      const secret = await sql.one<{ id: string }>(
        `insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
         values (app.agency_id(), app.business_id(), 'mailbox.credentials', 1,
                 decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'))
         returning id`,
      );
      const account = await sql.one<{ id: string }>(
        `insert into messaging.channel_accounts (business_id, channel, name)
         values (app.business_id(), 'email', 'Inbox') returning id`,
      );
      await sql.query(
        `insert into messaging.mailboxes
           (business_id, id, email_address, auth_method, smtp_host, smtp_port, smtp_security,
            smtp_username, secret_id, use_for_conversations)
         values (app.business_id(), $1, 'inbox@example.test', 'password', 'localhost', 1025, 'none',
                 'fixture', $2, true)`,
        [account.id, secret.id],
      );
      return { id: account.id, secretId: secret.id };
    });
    const sid = `SM${hex(32)}`;
    const webhookId = await c.receive(
      { kind: 'inbound' },
      {
        AccountSid: c.twilio.accountSid,
        ApiVersion: '2010-04-01',
        Body: 'Is the 14th free?',
        From: c.phone,
        To: c.number.e164,
        MessageSid: sid,
        SmsSid: sid,
        SmsMessageSid: sid,
        NumMedia: '0',
        NumSegments: '1',
      },
    );

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    // Stands for anything that keeps the sync at its mailbox for a moment.
    const holder = database.withTenant(c.context, async (sql) => {
      await sql.query('select 1 from messaging.mailboxes where id = $1 for update', [mailbox.id]);
      held();
      await gate;
    });
    await holding;
    // An empty batch: it takes every lock a batch takes, and stores nothing.
    const sync = runCommand(
      services,
      ingestInboundCommand,
      {
        mailboxId: mailbox.id,
        expected: null,
        credentials: { secretId: mailbox.secretId, sha256: '0'.repeat(64) },
        next: { uidValidity: '1', lastUid: 0 },
        startedAt: null,
        items: [],
      },
      {
        context: { ...c.context, actorKind: 'system', correlationId: randomUUID() },
        permissions: 'all',
      },
    );
    await lockWaits(1);
    const sms = c.apply(webhookId);
    await lockWaits(2);
    release();
    await holder;
    const [synced, received] = await Promise.allSettled([sync, sms]);
    // On a failure the reason is shown: a deadlock reads "deadlock detected" (40P01).
    const ended = (result: PromiseSettledResult<unknown>): unknown =>
      result.status === 'rejected' ? result.reason : 'finished';
    expect(ended(synced), 'the mailbox sync').toBe('finished');
    expect(ended(received), 'the SMS webhook').toBe('finished');
    expect(await c.webhook(webhookId)).toMatchObject({ processed: true, error: null });
    expect(await c.query("select body_text from messaging.messages where channel = 'sms'")).toEqual(
      [{ body_text: 'Is the 14th free?' }],
    );
  });
});
