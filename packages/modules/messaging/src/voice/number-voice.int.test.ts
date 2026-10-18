// Pointing each voice number at the call handler (V5d): when calling setup turns ready,
// or when a number taking calls is registered on a ready connection, the worker points
// each active voice number's VoiceUrl and StatusCallback at the voice webhooks.
import { randomBytes, randomUUID } from 'node:crypto';

import { allowEveryone, runCommand, type Invocation, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { SMS_CREDENTIALS } from '../sms-connect.js';
import { registerPhoneNumberCommand } from '../sms-numbers.js';
import { newWebhookToken } from '../sms-webhook-url.js';
import type { TwilioResponse } from '../twilio-api.js';
import { createSetUpCallingTask, VOICE_SIGNING_KEY } from '../voice-setup.js';
import type { NumberRequest, NumberTransport } from './number-provider.js';
import { createPointVoiceNumbersTask } from './number-voice.js';

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
const PUBLIC_URL = 'https://crm.example.test';

async function business(
  options: {
    readonly voice?: boolean;
    readonly setup?: 'ready' | 'requested' | 'none';
  } = {},
) {
  const agency = await database.fixtures.agency();
  const tenant = await database.fixtures.business(agency.id);
  const user = await database.fixtures.user();
  const accountSid = `AC${hex(32)}`;
  const authToken = hex(32);
  const webhookToken = newWebhookToken();
  const keySid = `SK${hex(32)}`;
  const keySecret = hex(32);
  const numberRef = `PN${hex(32)}`;
  const setupStatus = options.setup ?? 'ready';

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
      JSON.stringify({ accountSid, authToken, webhookToken }),
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

    if (setupStatus === 'ready') {
      const keySecretId = await vault.store(
        trx,
        { agencyId: agency.id, businessId: tenant.id, purpose: VOICE_SIGNING_KEY },
        JSON.stringify({ sid: keySid, secret: keySecret, type: 'standard' }),
      );
      await trx
        .insertInto('messaging.voice_setups')
        .values({
          business_id: tenant.id,
          connection_id: connection.id,
          status: 'ready',
          key_sid: keySid,
          secret_id: keySecretId,
          finished_at: sql<Date>`now()`,
        })
        .execute();
    } else if (setupStatus === 'requested') {
      await trx
        .insertInto('messaging.voice_setups')
        .values({
          business_id: tenant.id,
          connection_id: connection.id,
          status: 'requested',
        })
        .execute();
    }

    const channel = await trx
      .insertInto('messaging.channel_accounts')
      .values({ business_id: tenant.id, channel: 'sms', name: 'Main line', status: 'active' })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('messaging.phone_numbers')
      .values({
        business_id: tenant.id,
        id: channel.id,
        e164: `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`,
        provider_connection_id: connection.id,
        provider_number_ref: numberRef,
        capabilities: options.voice === false ? ['sms'] : ['sms', 'voice'],
      })
      .execute();

    return connection.id;
  });

  const publicId = toPublicId('sms_connection', connectionId);

  return {
    agency,
    tenant,
    accountSid,
    authToken,
    webhookToken,
    connectionId,
    publicId,
    numberRef,
    invocation,
    job: {
      invocation: {
        context: { ...tenant.context, correlationId: randomUUID() },
        permissions: 'all' as const,
      },
      services,
    },
    pointJobs: () =>
      database.as('postgres', (sqlQuery) =>
        sqlQuery.query<{ n: number }>(
          `select count(*)::int as n from graphile_worker.jobs j join graphile_worker._private_jobs p on p.id=j.id
           where j.task_identifier='messaging.point_voice_numbers' and p.payload->'data'->>'connectionId'=$1`,
          [connectionId],
        ),
      ),
  };
}

function fakeNumbers(...answers: readonly (TwilioResponse | Error)[]) {
  const requests: NumberRequest[] = [];
  const queue = [...answers];
  const transport: NumberTransport = (request) => {
    requests.push(request);
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer === undefined) return Promise.resolve({ status: 200, body: '{}' });
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  };
  return { transport, requests };
}

describe('number-voice task', () => {
  it('points every active voice number of the connection at the call handler', async () => {
    const b = await business();
    const secondRef = `PN${hex(32)}`;
    await withTenant(db, b.tenant.context, async (trx) => {
      const channel = await trx
        .insertInto('messaging.channel_accounts')
        .values({ business_id: b.tenant.id, channel: 'sms', name: 'Second line', status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('messaging.phone_numbers')
        .values({
          business_id: b.tenant.id,
          id: channel.id,
          e164: `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`,
          provider_connection_id: b.connectionId,
          provider_number_ref: secondRef,
          capabilities: ['sms', 'voice'],
        })
        .execute();
    });

    const fake = fakeNumbers();
    const task = createPointVoiceNumbersTask(vault, fake.transport, PUBLIC_URL);
    await task.run({ connectionId: b.connectionId }, b.job);

    expect(fake.requests).toHaveLength(2);
    const paths = fake.requests.map((r) => r.path);
    expect(paths).toContain(
      `/2010-04-01/Accounts/${b.accountSid}/IncomingPhoneNumbers/${b.numberRef}.json`,
    );
    expect(paths).toContain(
      `/2010-04-01/Accounts/${b.accountSid}/IncomingPhoneNumbers/${secondRef}.json`,
    );

    for (const req of fake.requests) {
      expect(req.host).toBe('api');
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toBe('application/x-www-form-urlencoded');
      const form = new URLSearchParams(req.body);
      expect(form.get('VoiceUrl')).toBe(
        `${PUBLIC_URL}/webhooks/twilio/voice/${b.webhookToken}/inbound`,
      );
      expect(form.get('VoiceMethod')).toBe('POST');
      expect(form.get('StatusCallback')).toBe(
        `${PUBLIC_URL}/webhooks/twilio/voice/${b.webhookToken}/ended`,
      );
      expect(form.get('StatusCallbackMethod')).toBe('POST');
    }
  });

  it('leaves numbers that only text, and released numbers, alone', async () => {
    const b = await business(); // active voice number
    const textOnlyRef = `PN${hex(32)}`;
    const releasedRef = `PN${hex(32)}`;

    await withTenant(db, b.tenant.context, async (trx) => {
      // SMS-only number
      const c1 = await trx
        .insertInto('messaging.channel_accounts')
        .values({ business_id: b.tenant.id, channel: 'sms', name: 'Text only', status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('messaging.phone_numbers')
        .values({
          business_id: b.tenant.id,
          id: c1.id,
          e164: '+14155550201',
          provider_connection_id: b.connectionId,
          provider_number_ref: textOnlyRef,
          capabilities: ['sms'],
        })
        .execute();

      // Released voice number
      const c2 = await trx
        .insertInto('messaging.channel_accounts')
        .values({
          business_id: b.tenant.id,
          channel: 'sms',
          name: 'Released',
          status: 'disconnected',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('messaging.phone_numbers')
        .values({
          business_id: b.tenant.id,
          id: c2.id,
          e164: '+14155550202',
          provider_connection_id: b.connectionId,
          provider_number_ref: releasedRef,
          capabilities: ['sms', 'voice'],
        })
        .execute();
    });

    const fake = fakeNumbers();
    const task = createPointVoiceNumbersTask(vault, fake.transport, PUBLIC_URL);
    await task.run({ connectionId: b.connectionId }, b.job);

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.path).toBe(
      `/2010-04-01/Accounts/${b.accountSid}/IncomingPhoneNumbers/${b.numberRef}.json`,
    );
  });

  it('does nothing for a connection whose calling is not set up', async () => {
    const b = await business({ setup: 'requested' });
    const fake = fakeNumbers();
    const task = createPointVoiceNumbersTask(vault, fake.transport, PUBLIC_URL);
    await task.run({ connectionId: b.connectionId }, b.job);
    expect(fake.requests).toHaveLength(0);
  });

  it('does nothing without a public https address', async () => {
    const b = await business();
    const fake = fakeNumbers();
    const task = createPointVoiceNumbersTask(vault, fake.transport, 'http://insecure.test');
    await task.run({ connectionId: b.connectionId }, b.job);
    expect(fake.requests).toHaveLength(0);
  });

  it('goes on to the next number when Twilio refuses one, and retries only lost answers', async () => {
    const b = await business();
    const secondRef = `PN${hex(32)}`;
    await withTenant(db, b.tenant.context, async (trx) => {
      const channel = await trx
        .insertInto('messaging.channel_accounts')
        .values({ business_id: b.tenant.id, channel: 'sms', name: 'Second line', status: 'active' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('messaging.phone_numbers')
        .values({
          business_id: b.tenant.id,
          id: channel.id,
          e164: '+14155550302',
          provider_connection_id: b.connectionId,
          provider_number_ref: secondRef,
          capabilities: ['sms', 'voice'],
        })
        .execute();
    });

    // 1. Refused does not throw, continues to next number
    const fakeRefused = fakeNumbers(
      { status: 400, body: JSON.stringify({ code: 21422 }) },
      { status: 200, body: '{}' },
    );
    const task1 = createPointVoiceNumbersTask(vault, fakeRefused.transport, PUBLIC_URL);
    await expect(task1.run({ connectionId: b.connectionId }, b.job)).resolves.toBeUndefined();
    expect(fakeRefused.requests).toHaveLength(2);

    // 2. Lost answer throws at the end to retry
    const fakeLost = fakeNumbers({ status: 200, body: '{}' }, new Error('network down'));
    const task2 = createPointVoiceNumbersTask(vault, fakeLost.transport, PUBLIC_URL);
    await expect(task2.run({ connectionId: b.connectionId }, b.job)).rejects.toThrow();
    expect(fakeLost.requests).toHaveLength(2);
  });

  it('is queued when calling setup turns ready', async () => {
    const b = await business({ setup: 'requested' });
    const keySid = `SK${hex(32)}`;
    const keySecret = hex(32);
    const fakeKey = {
      transport: () =>
        Promise.resolve({
          status: 201,
          body: JSON.stringify({
            sid: keySid,
            secret: keySecret,
            friendly_name: 'CRM browser calling',
          }),
        }),
    };

    expect((await b.pointJobs())[0]?.n).toBe(0);

    const setupTask = createSetUpCallingTask(vault, fakeKey.transport);
    await setupTask.run({ connectionId: b.connectionId }, b.job);

    expect((await b.pointJobs())[0]?.n).toBe(1);
  });

  it('is queued when a number that takes calls is registered on a ready connection', async () => {
    const b = await business();
    const voiceRef = `PN${hex(32)}`;
    const smsOnlyRef = `PN${hex(32)}`;

    await withTenant(db, b.tenant.context, async (trx) => {
      await trx
        .insertInto('messaging.provider_numbers')
        .values([
          {
            business_id: b.tenant.id,
            connection_id: b.connectionId,
            provider_number_ref: voiceRef,
            e164: '+14155550401',
            friendly_name: 'Voice line',
            capabilities: ['sms', 'voice'],
          },
          {
            business_id: b.tenant.id,
            connection_id: b.connectionId,
            provider_number_ref: smsOnlyRef,
            e164: '+14155550402',
            friendly_name: 'SMS line',
            capabilities: ['sms'],
          },
        ])
        .execute();
    });

    expect((await b.pointJobs())[0]?.n).toBe(0);

    // Registering SMS-only number does not queue pointVoiceNumbers
    await runCommand(
      services,
      registerPhoneNumberCommand,
      {
        connectionId: b.publicId,
        providerNumberRef: smsOnlyRef,
        name: 'SMS only',
      },
      b.invocation,
    );
    expect((await b.pointJobs())[0]?.n).toBe(0);

    // Registering voice number queues pointVoiceNumbers
    await runCommand(
      services,
      registerPhoneNumberCommand,
      {
        connectionId: b.publicId,
        providerNumberRef: voiceRef,
        name: 'Voice line',
      },
      b.invocation,
    );
    expect((await b.pointJobs())[0]?.n).toBe(1);
  });

  it("never touches another business's numbers", async () => {
    const b1 = await business();
    const b2 = await business();

    const fake = fakeNumbers();
    const task = createPointVoiceNumbersTask(vault, fake.transport, PUBLIC_URL);

    // Running as b1 for b2's connectionId
    await task.run({ connectionId: b2.connectionId }, b1.job);

    expect(fake.requests).toHaveLength(0);
  });
});
