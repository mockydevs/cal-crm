import { randomBytes } from 'node:crypto';
import { allowEveryone, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { recordInboundCall, type ReadCallGrants } from '../call-ledger.js';
import { SMS_CREDENTIALS } from '../sms-connect.js';
import { newWebhookToken, webhookDigest } from '../sms-webhook-url.js';
import { expectedSignature } from '../twilio-signature.js';
import { renderHangup } from './voice-twiml.js';
import { createVoiceCallbackWorker } from './voice-worker.js';

let database: TestDatabase;
let db: Database;
let vault: Vault;
let services: Services;
const allowCalls: ReadCallGrants = () => Promise.resolve(new Set(['calls.place']));
const publicUrl = 'https://crm.example.test';
const sid = (prefix: string) => `${prefix}${randomBytes(16).toString('hex')}`;
let numberSequence = 100;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  services = { db, authorize: allowEveryone };
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function world(matchContact = true) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const contact = await database.fixtures.contact(business.context);
  const token = newWebhookToken();
  const accountSid = sid('AC');
  const authToken = 'synthetic-worker-auth-token';
  const callSid = sid('CA');
  const from = '+12025550199';
  const to = `+1202555${String(numberSequence++).padStart(4, '0')}`;
  const made = await withTenant(db, business.context, async (trx) => {
    const secretId = await vault.store(
      trx,
      {
        agencyId: agency.id,
        businessId: business.id,
        purpose: SMS_CREDENTIALS,
      },
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
        webhook_digest: webhookDigest(token),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const channel = await trx
      .insertInto('messaging.channel_accounts')
      .values({
        business_id: business.id,
        channel: 'sms',
        name: 'Synthetic',
      })
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
    if (matchContact)
      await trx
        .insertInto('crm.contact_identities')
        .values({
          business_id: business.id,
          contact_id: contact.id,
          kind: 'phone',
          value: from,
          value_normalized: from,
        })
        .execute();
    const call = await recordInboundCall(trx, business.context, {
      phoneNumberId: channel.id,
      connectionId: connection.id,
      providerCallId: callSid,
      from,
      to,
    });
    if (call === null) throw new Error('Call not recorded.');
    return { ...call, connectionId: connection.id };
  });
  const base = {
    AccountSid: accountSid,
    CallSid: callSid,
    From: from,
    To: to,
    Direction: 'inbound',
    CallStatus: 'ringing',
  };
  const request = (kind: string, patch: Record<string, string> = {}, legId?: string) => {
    const path = `/webhooks/twilio/voice/${token}/${kind}${legId === undefined ? '' : `?step=${legId}`}`;
    const params = { ...base, ...patch };
    return {
      path,
      body: Buffer.from(new URLSearchParams(params).toString()),
      signature: expectedSignature(authToken, publicUrl + path, params),
    };
  };
  const query = <T extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(business.context, (sql) => sql.query<T>(text, values));
  return { ...made, business, contact, request, query };
}

it('authenticates progress and final notifications before audited, replay-safe ledger updates', async () => {
  const b = await world();
  const worker = createVoiceCallbackWorker(services, vault, publicUrl, allowCalls);
  const report = b.request(
    'progress',
    { CallbackSource: 'call-progress-events', SequenceNumber: '1' },
    b.legId,
  );
  expect((await worker.handle({ ...report, signature: 'forged' })).statusCode).toBe(403);
  expect((await worker.handle(report)).statusCode).toBe(204);
  expect((await worker.handle(report)).statusCode).toBe(204);
  const final = b.request('ended', { CallStatus: 'completed', CallDuration: '9' });
  expect((await worker.handle(final)).statusCode).toBe(204);
  expect((await worker.handle(final)).statusCode).toBe(204);
  expect(
    await b.query('select state,outcome from messaging.calls where id=$1', [b.callId]),
  ).toEqual([{ state: 'ended', outcome: 'no_answer' }]);
  expect(
    await b.query('select type from events.events where subject_id=$1 order by recorded_at', [
      b.callId,
    ]),
  ).toEqual([{ type: 'call.progressed' }, { type: 'call.progressed' }]);
  const audit = await b.query('select input from audit.commands where command=$1', [
    'call.apply_voice_callback',
  ]);
  expect(audit).toHaveLength(4);
  expect(JSON.stringify(audit)).not.toContain('+1202555');
  expect(JSON.stringify(audit)).not.toContain('synthetic-worker-auth-token');
  expect(
    await b.query('select event_type from crm.timeline_entries where record_id=$1', [b.contact.id]),
  ).toHaveLength(2);
});

it('rechecks connection state after opening the signature secret and before committing progress', async () => {
  const b = await world();
  const opening: Vault = {
    ...vault,
    async read(...args) {
      const plaintext = await vault.read(...args);
      await b.query("update messaging.provider_connections set status='disconnected' where id=$1", [
        b.connectionId,
      ]);
      return plaintext;
    },
  };
  const worker = createVoiceCallbackWorker(services, opening, publicUrl, allowCalls);
  const report = b.request(
    'progress',
    { CallbackSource: 'call-progress-events', SequenceNumber: '1' },
    b.legId,
  );
  expect((await worker.handle(report)).statusCode).toBe(404);
  expect(
    await b.query('select sequence from messaging.call_progress where leg_id=$1', [b.legId]),
  ).toEqual([]);
});

it('refuses malformed, unbound and disconnected callbacks without changing a call', async () => {
  const b = await world();
  const other = await world();
  const worker = createVoiceCallbackWorker(services, vault, publicUrl, allowCalls);
  expect((await worker.handle(b.request('progress'))).statusCode).toBe(400);
  expect(
    (
      await worker.handle(
        b.request('progress', { CallbackSource: 'call-progress-events', SequenceNumber: '1' }),
      )
    ).statusCode,
  ).toBe(400);
  expect(
    (await worker.handle(b.request('ended', { CallStatus: 'completed' }, b.legId))).statusCode,
  ).toBe(400);
  expect((await worker.handle(b.request('progress', {}, b.legId))).statusCode).toBe(400);
  expect((await worker.handle(b.request('ended', { CallStatus: 'ringing' }))).statusCode).toBe(400);
  expect(
    (
      await worker.handle(
        b.request(
          'progress',
          { CallbackSource: 'call-progress-events', SequenceNumber: '1' },
          other.legId,
        ),
      )
    ).statusCode,
  ).toBe(404);
  expect((await worker.handle(b.request('accept'))).statusCode).toBe(503);
  await b.query("update messaging.provider_connections set status='disconnected' where id=$1", [
    b.connectionId,
  ]);
  expect((await worker.handle(b.request('ended', { CallStatus: 'completed' }))).statusCode).toBe(
    404,
  );
  expect(await b.query('select state from messaging.calls where id=$1', [b.callId])).toEqual([
    { state: 'ringing' },
  ]);
});

it('queues a waiting hang-up once when new verified progress binds the provider call', async () => {
  const b = await world(false);
  await b.query('update messaging.calls set hangup_requested_at=now() where id=$1', [b.callId]);
  const worker = createVoiceCallbackWorker(services, vault, publicUrl, allowCalls);
  const request = b.request(
    'progress',
    { CallbackSource: 'call-progress-events', SequenceNumber: '1' },
    b.legId,
  );
  expect((await worker.handle(request)).statusCode).toBe(204);
  expect((await worker.handle(request)).statusCode).toBe(204);
  const jobs = await database.as('postgres', (sql) =>
    sql.query(
      `select p.payload from graphile_worker.jobs j join graphile_worker._private_jobs p on p.id=j.id
     where j.task_identifier='calls.end' and p.payload->'data'->>'callId'=$1`,
      [b.callId],
    ),
  );
  expect(jobs).toHaveLength(1);
});

it('answers a verified dial-result callback with hangup instructions', async () => {
  const b = await world();
  const worker = createVoiceCallbackWorker(services, vault, publicUrl, allowCalls);
  const callback = b.request('dial-result', { DialCallStatus: 'completed' }, b.legId);
  expect(await worker.handle(callback)).toEqual({
    statusCode: 200,
    contentType: 'application/xml',
    body: renderHangup(),
  });
});
