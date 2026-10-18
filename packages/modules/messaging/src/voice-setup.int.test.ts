// Setting up calling against a migrated database: the worker creates the key once, seals
// its secret where only the worker can open it, records a refusal or a lost answer honestly
// and never asks Twilio twice by itself; the screen and the calling status say where it is.
import { randomBytes, randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  toPublicId,
  type TenantContext,
} from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { readPhoneCalling } from './phone-settings.js';
import { SMS_CREDENTIALS } from './sms-connect.js';
import { newWebhookToken } from './sms-webhook-url.js';
import type { VoiceTransport, VoiceTransportRequest } from './voice/twilio-voice.js';
import {
  createSetUpCallingTask,
  readCallingSetups,
  setUpCallingCommand,
  VOICE_SIGNING_KEY,
} from './voice-setup.js';

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

const hex = (length: number) => randomBytes(length / 2).toString('hex');

/** A business with one connected Twilio account and a number on it that takes calls. */
async function business(options: { readonly voice?: boolean; readonly credentials?: string } = {}) {
  const agency = await database.fixtures.agency();
  const tenant = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const accountSid = `AC${hex(32)}`;
  const authToken = hex(32);
  const context: TenantContext = {
    ...tenant.context,
    actorKind: 'user',
    actorId: user.id,
    userId: user.id,
    correlationId: randomUUID(),
  };
  const invocation: Invocation = { context, permissions: 'all' };
  const connectionId = await withTenant(db, tenant.context, async (trx) => {
    const secretId = await vault.store(
      trx,
      { agencyId: agency.id, businessId: tenant.id, purpose: SMS_CREDENTIALS },
      options.credentials ??
        JSON.stringify({ accountSid, authToken, webhookToken: newWebhookToken() }),
    );
    const connection = await trx
      .insertInto('messaging.provider_connections')
      .values({
        agency_id: agency.id,
        business_id: tenant.id,
        provider: 'twilio',
        label: 'Front desk',
        account_ref: accountSid,
        secret_id: secretId,
        status: 'connected',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const channel = await trx
      .insertInto('messaging.channel_accounts')
      .values({ business_id: tenant.id, channel: 'sms', name: 'Main line' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('messaging.phone_numbers')
      .values({
        business_id: tenant.id,
        id: channel.id,
        e164: `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`,
        provider_connection_id: connection.id,
        provider_number_ref: `PN${hex(32)}`,
        capabilities: options.voice === false ? ['sms'] : ['sms', 'voice'],
      })
      .execute();
    return connection.id;
  });
  const publicId = toPublicId('sms_connection', connectionId);
  const tenantRead = <T>(work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(db, tenant.context, work);
  return {
    agency,
    tenant,
    accountSid,
    authToken,
    connectionId,
    publicId,
    invocation,
    job: {
      invocation: {
        context: { ...tenant.context, correlationId: randomUUID() },
        permissions: 'all' as const,
      },
      services,
    },
    setUp: (as = invocation) => runCommand(services, setUpCallingCommand, { id: publicId }, as),
    list: () => tenantRead((trx) => readCallingSetups(trx)),
    calling: () => tenantRead((trx) => readPhoneCalling(trx)),
    row: () =>
      tenantRead((trx) =>
        trx
          .selectFrom('messaging.voice_setups')
          .selectAll()
          .where('connection_id', '=', connectionId)
          .executeTakeFirst(),
      ),
    jobs: () =>
      database.as('postgres', (sql) =>
        sql.query<{ n: number }>(
          `select count(*)::int as n from graphile_worker.jobs j join graphile_worker._private_jobs p on p.id=j.id
           where j.task_identifier='voice.set_up_calling' and p.payload->'data'->>'connectionId'=$1`,
          [connectionId],
        ),
      ),
    query: (text: string, values: readonly unknown[] = []) =>
      database.withTenant(tenant.context, (sql) => sql.query(text, values)),
  };
}

/** Twilio stand-in for the Keys resource: answers in turn and records every request. */
function twilio(...answers: readonly ({ status: number; body: string } | Error)[]) {
  const requests: VoiceTransportRequest[] = [];
  const transport: VoiceTransport = (request) => {
    requests.push(request);
    const answer = answers[requests.length - 1] ?? new Error('No answer left.');
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { transport, requests };
}
const created = () => {
  const sid = `SK${hex(32)}`;
  const secret = hex(32);
  return {
    sid,
    secret,
    answer: {
      status: 201,
      body: JSON.stringify({ sid, secret, friendly_name: 'CRM browser calling' }),
    },
  };
};

describe('before calling is set up', () => {
  it('lists the account with its number that takes calls, ready to set up', async () => {
    const b = await business();
    expect((await b.list()).data).toEqual([
      {
        connectionId: b.publicId,
        label: 'Front desk',
        connectionStatus: 'connected',
        voiceNumbers: 1,
        setup: null,
        canSetUp: true,
      },
    ]);
    expect((await b.calling()).unavailable?.code).toBe('calling_not_set_up');
  });

  it('asks for a number that takes calls first, when there is none', async () => {
    const b = await business({ voice: false });
    expect((await b.list()).data[0]?.voiceNumbers).toBe(0);
    expect((await b.calling()).unavailable?.code).toBe('no_voice_number');
  });
});

describe('setting up', () => {
  it('creates one Standard key, seals its secret for the worker, and is ready', async () => {
    const b = await business();
    const started = await b.setUp();
    expect(started).toMatchObject({
      setup: { status: 'requested', failure: null },
      canSetUp: false,
    });
    expect((await b.calling()).unavailable?.code).toBe('calling_setup_pending');
    expect((await b.jobs())[0]?.n).toBe(1);

    const key = created();
    const fake = twilio(key.answer);
    await createSetUpCallingTask(vault, fake.transport).run(
      { connectionId: b.connectionId },
      b.job,
    );

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      path: `/2010-04-01/Accounts/${b.accountSid}/Keys.json`,
      headers: {
        authorization: `Basic ${Buffer.from(`${b.accountSid}:${b.authToken}`).toString('base64')}`,
      },
    });
    const row = await b.row();
    expect(row).toMatchObject({ status: 'ready', key_sid: key.sid, failure_code: null });
    const sealed = await withTenant(db, b.tenant.context, (trx) =>
      vault.read(trx, row?.secret_id ?? '', VOICE_SIGNING_KEY),
    );
    expect(JSON.parse(sealed)).toEqual({ sid: key.sid, secret: key.secret, type: 'standard' });
    expect((await b.list()).data[0]).toMatchObject({ setup: { status: 'ready' }, canSetUp: false });
    // Set up, and calling is now available.
    expect(await b.calling()).toEqual({ available: true, unavailable: null });
  });

  it('answers a second ask with the setup under way, and refuses one once it is ready', async () => {
    const b = await business();
    await b.setUp();
    expect(await b.setUp()).toMatchObject({ setup: { status: 'requested' } });
    expect((await b.jobs())[0]?.n).toBe(1);
    await createSetUpCallingTask(vault, twilio(created().answer).transport).run(
      { connectionId: b.connectionId },
      b.job,
    );
    await expect(b.setUp()).rejects.toBeInstanceOf(ConflictError);
  });

  it('records what Twilio refused, creates nothing, and lets the person try again', async () => {
    const b = await business();
    await b.setUp();
    const fake = twilio({
      status: 401,
      body: JSON.stringify({ code: 20003, message: 'Authenticate' }),
    });
    await createSetUpCallingTask(vault, fake.transport).run(
      { connectionId: b.connectionId },
      b.job,
    );
    expect(await b.row()).toMatchObject({
      status: 'failed',
      failure_code: 'provider_rejected',
      provider_error_code: 20003,
      secret_id: null,
    });
    expect((await b.list()).data[0]).toMatchObject({
      setup: { status: 'failed', failure: { code: 'provider_rejected', providerErrorCode: 20003 } },
      canSetUp: true,
    });
    expect((await b.calling()).unavailable?.code).toBe('calling_setup_failed');
    expect(await b.setUp()).toMatchObject({ setup: { status: 'requested', failure: null } });
  });

  it('keeps a lost answer unknown and never asks Twilio again by itself', async () => {
    const b = await business();
    await b.setUp();
    const fake = twilio(new Error('socket hang up'));
    const task = createSetUpCallingTask(vault, fake.transport);
    await task.run({ connectionId: b.connectionId }, b.job);
    expect(await b.row()).toMatchObject({ status: 'unknown', key_sid: null, secret_id: null });
    expect((await b.calling()).unavailable?.code).toBe('calling_setup_unknown');
    await task.run({ connectionId: b.connectionId }, b.job);
    expect(fake.requests).toHaveLength(1);
    expect((await b.list()).data[0]).toMatchObject({
      setup: { status: 'unknown' },
      canSetUp: true,
    });
  });

  it('treats a run that finds the setup still creating as unknown, without asking', async () => {
    const b = await business();
    await b.setUp();
    await b.query("update messaging.voice_setups set status='creating'");
    const fake = twilio(created().answer);
    await createSetUpCallingTask(vault, fake.transport).run(
      { connectionId: b.connectionId },
      b.job,
    );
    expect(fake.requests).toEqual([]);
    expect(await b.row()).toMatchObject({ status: 'unknown' });
  });

  it('fails without asking Twilio when the account was disconnected or its credentials cannot be read', async () => {
    const gone = await business();
    await gone.setUp();
    await gone.query("update messaging.provider_connections set status='disconnected'");
    const unreadable = await business({ credentials: '{"accountSid":"nope"}' });
    await unreadable.setUp();
    const fake = twilio(created().answer, created().answer);
    for (const b of [gone, unreadable])
      await createSetUpCallingTask(vault, fake.transport).run(
        { connectionId: b.connectionId },
        b.job,
      );
    expect(fake.requests).toEqual([]);
    expect(await gone.row()).toMatchObject({
      status: 'failed',
      failure_code: 'connection_unavailable',
    });
    expect(await unreadable.row()).toMatchObject({
      status: 'failed',
      failure_code: 'credentials_unreadable',
    });
    await expect(gone.setUp()).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('who may set up, and where', () => {
  it('needs phone.manage', async () => {
    const b = await business();
    await expect(
      b.setUp({ ...b.invocation, permissions: new Set(['calls.place']) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await b.row()).toBeUndefined();
  });

  it("never sets up or lists another business's account", async () => {
    const mine = await business();
    const theirs = await business();
    await expect(
      runCommand(services, setUpCallingCommand, { id: theirs.publicId }, mine.invocation),
    ).rejects.toBeInstanceOf(NotFoundError);
    await theirs.setUp();
    expect((await mine.list()).data.map((each) => each.connectionId)).toEqual([mine.publicId]);
    await createSetUpCallingTask(vault, twilio(created().answer).transport).run(
      { connectionId: theirs.connectionId },
      mine.job,
    );
    expect(await theirs.row()).toMatchObject({ status: 'requested' });
  });
});
