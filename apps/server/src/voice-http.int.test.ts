// Actual startup, HTTP parsing, split-role relay, worker vault, commands and migrated
// ledger. Every provider identity is synthetic; no provider request leaves the machine.
import { createHash, randomBytes } from 'node:crypto';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { recordInboundCall } from '@repo/module-messaging';
import {
  createVault,
  newSecretsKey,
  parseSecretsKeys,
  parseSecretsPublicKey,
  type Vault,
} from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, afterEach, beforeAll, expect, inject, it } from 'vitest';
import { postTwilioWebhook } from '../test/fake-twilio.js';
import type { Config, VaultKeys } from './config.js';
import { start, type Running } from './start.js';

let database: TestDatabase;
let db: Database;
let vault: Vault;
let privateKeys: VaultKeys;
let publicKeys: VaultKeys;
const running: Running[] = [];
const publicUrl = 'https://crm.example.test';
const sid = (prefix: string) => `${prefix}${randomBytes(16).toString('hex')}`;
let numberSequence = 100;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const keys = await newSecretsKey(1);
  privateKeys = { holds: 'private', keys: parseSecretsKeys(keys.secretsKey) };
  publicKeys = { holds: 'public', publicKey: parseSecretsPublicKey(keys.publicKey) };
  vault = await createVault(privateKeys.keys);
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.stop()));
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

const config = (role: Config['role'], keys: VaultKeys): Config => ({
  nodeEnv: 'test',
  role,
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  databaseAppUrl: database.url('crm_app'),
  databaseWorkerUrl: undefined,
  databasePoolSize: 4,
  shutdownTimeoutMs: 1000,
  dashboardDir: undefined,
  devTenantContext: undefined,
  publicUrl,
  authentication: undefined,
  trustProxy: [],
  mail: undefined,
  files: undefined,
  vault: keys,
});

it.each(['all', 'split'] as const)(
  'applies signed voice callbacks through %s startup and refuses forged requests',
  async (mode) => {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const accountSid = sid('AC');
    const callSid = sid('CA');
    const token = randomBytes(32).toString('base64url');
    const authToken = 'synthetic-voice-http-auth';
    const from = '+12025550199';
    const to = `+1202555${String(numberSequence++).padStart(4, '0')}`;
    const first = await withTenant(db, business.context, async (trx) => {
      const secretId = await vault.store(
        trx,
        { agencyId: agency.id, businessId: business.id, purpose: 'sms.twilio.credentials' },
        JSON.stringify({ accountSid, authToken, webhookToken: token }),
      );
      const connection = await trx
        .insertInto('messaging.provider_connections')
        .values({
          agency_id: agency.id,
          business_id: business.id,
          provider: 'twilio',
          label: 'Synthetic',
          account_ref: accountSid,
          secret_id: secretId,
          webhook_digest: createHash('sha256').update(token).digest('hex'),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const channel = await trx
        .insertInto('messaging.channel_accounts')
        .values({ business_id: business.id, channel: 'sms', name: 'Synthetic' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('messaging.phone_numbers')
        .values({
          id: channel.id,
          business_id: business.id,
          e164: to,
          provider_connection_id: connection.id,
          provider_number_ref: sid('PN'),
          capabilities: ['voice'],
        })
        .execute();
      return recordInboundCall(trx, business.context, {
        phoneNumberId: channel.id,
        connectionId: connection.id,
        providerCallId: callSid,
        from,
        to,
      });
    });
    if (first === null) throw new Error('Call not recorded.');
    const worker = await start(config(mode === 'all' ? 'all' : 'worker', privateKeys), [], []);
    running.push(worker);
    const app =
      mode === 'all'
        ? worker
        : await start({ ...config('app', publicKeys), voiceWorkerOrigin: worker.address }, [], []);
    if (app !== worker) running.push(app);
    if (mode === 'split')
      expect((await fetch(`${worker.address}/api/v1/openapi.json`)).status).toBe(404);
    const params = {
      AccountSid: accountSid,
      CallSid: callSid,
      From: from,
      To: to,
      Direction: 'inbound',
      CallStatus: 'ringing',
      CallbackSource: 'call-progress-events',
      SequenceNumber: '1',
    };
    const url = `${publicUrl}/webhooks/twilio/voice/${token}/progress?step=${first.legId}`;
    const post = (value = params, signingKey = authToken, target = url) =>
      postTwilioWebhook({
        url: target,
        deliverTo: app.address,
        authToken: signingKey,
        params: value,
      });
    expect((await post(params, 'forged')).status).toBe(403);
    expect(await post()).toEqual({ status: 204, body: '' });
    expect(await post()).toEqual({ status: 204, body: '' });
    const final = {
      AccountSid: accountSid,
      CallSid: callSid,
      From: from,
      To: to,
      Direction: 'inbound',
      CallStatus: 'completed',
      CallDuration: '8',
    };
    expect(
      await postTwilioWebhook({
        url: `${publicUrl}/webhooks/twilio/voice/${token}/ended`,
        deliverTo: app.address,
        authToken,
        params: final,
      }),
    ).toEqual({ status: 204, body: '' });
    const rows = await database.withTenant(business.context, (sql) =>
      sql.query('select state,outcome from messaging.calls where id=$1', [first.callId]),
    );
    expect(rows).toEqual([{ state: 'ended', outcome: 'no_answer' }]);
    const events = await database.withTenant(business.context, (sql) =>
      sql.query('select type from events.events where subject_id=$1', [first.callId]),
    );
    expect(events).toHaveLength(2);
    if (mode === 'split') {
      await worker.stop();
      running.splice(running.indexOf(worker), 1);
      expect((await post()).status).toBe(503);
    }
  },
);
