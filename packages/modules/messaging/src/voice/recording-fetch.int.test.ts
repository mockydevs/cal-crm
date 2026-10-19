import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { allowEveryone, type Invocation, type Services } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import type { ReadCallGrants } from '../call-ledger.js';
import { SMS_CREDENTIALS } from '../sms-connect.js';
import { newWebhookToken, webhookDigest } from '../sms-webhook-url.js';
import { expectedSignature } from '../twilio-signature.js';
import { VOICE_SIGNING_KEY } from '../voice-setup.js';
import { createFetchCallRecordingTask, type RecordingFiles } from './recording-fetch.js';
import { createVoiceCallbackWorker } from './voice-worker.js';

let database: TestDatabase;
let db: Database;
let vault: Vault;
let services: Services;
const publicUrl = 'https://crm.example.test';
const sid = (prefix: string) => `${prefix}${randomBytes(16).toString('hex')}`;
let numberSequence = 900;

const storageMap = new Map<string, Uint8Array>();

const filesPort: RecordingFiles = {
  async store(trx, command, file) {
    const { id } = await trx.selectNoFrom(sql<string>`uuidv7()`.as('id')).executeTakeFirstOrThrow();
    await trx
      .insertInto('files.files')
      .values({
        id,
        agency_id: command.context.agencyId,
        business_id: command.context.businessId ?? null,
        storage: 'local',
        storage_key: id,
        filename: file.filename,
        content_type: file.contentType,
        size_bytes: file.content.byteLength,
        sha256: createHash('sha256').update(file.content).digest(),
        uploaded_by_kind: command.context.actorKind,
        uploaded_by_id: command.context.actorId ?? null,
        purpose: file.purpose,
      })
      .execute();
    storageMap.set(id, file.content);
    return { id };
  },
};

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

const defaultGrants: ReadCallGrants = async (trx, context, userId) => {
  const row = await trx
    .selectFrom('tenancy.memberships as m')
    .innerJoin('tenancy.roles as r', 'r.id', 'm.role_id')
    .select('r.permissions')
    .where('m.business_id', '=', context.businessId ?? '')
    .where('m.user_id', '=', userId)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : new Set(row.permissions.filter((each): each is Permission => each === 'calls.place'));
};

async function world() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const token = newWebhookToken();
  const accountSid = sid('AC');
  const authToken = 'synthetic-recording-auth-token';
  const callSid = sid('CA');
  const keySid = sid('SK');
  const keySecret = 'synthetic-voice-key-secret';
  const from = '+12025550199';
  const to = `+1202555${String(numberSequence++).padStart(4, '0')}`;

  const user = await database.fixtures.user();
  const role = await database.as('crm_owner', (s) =>
    s.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, permissions) values ($1, 'business', $2, 'Team', array['calls.place']) returning id`,
      [agency.id, `team_${randomUUID().replaceAll('-', '_')}`],
    ),
  );
  const membership = await database.as('crm_owner', (s) =>
    s.one<{ id: string }>(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4) returning id`,
      [agency.id, business.id, user.id, role.id],
    ),
  );
  const memberPublicId = toPublicId('membership', membership.id);

  const made = await withTenant(db, business.context, async (trx) => {
    const secretId = await vault.store(
      trx,
      { agencyId: agency.id, businessId: business.id, purpose: SMS_CREDENTIALS },
      JSON.stringify({ accountSid, authToken, webhookToken: token }),
    );
    const connection = await trx
      .insertInto('messaging.provider_connections')
      .values({
        agency_id: agency.id,
        business_id: business.id,
        provider: 'twilio',
        label: 'Voice Line',
        account_ref: accountSid,
        secret_id: secretId,
        status: 'connected',
        webhook_digest: webhookDigest(token),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const keySecretId = await vault.store(
      trx,
      { agencyId: agency.id, businessId: business.id, purpose: VOICE_SIGNING_KEY },
      JSON.stringify({ sid: keySid, secret: keySecret, type: 'standard' }),
    );

    await trx
      .insertInto('messaging.voice_setups')
      .values({
        business_id: business.id,
        connection_id: connection.id,
        status: 'ready',
        key_sid: keySid,
        secret_id: keySecretId,
        finished_at: new Date(),
      })
      .execute();

    const channel = await trx
      .insertInto('messaging.channel_accounts')
      .values({
        business_id: business.id,
        channel: 'sms',
        name: 'Inbound Line',
        status: 'active',
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

    await trx
      .insertInto('messaging.phone_number_settings')
      .values({
        business_id: business.id,
        phone_number_id: channel.id,
        primary_user_id: user.id,
        ring_timeout_seconds: 30,
        voicemail_backup: true,
        use_business_fallback: false,
        ring_also_user_ids: [],
        prefer_contact_owner: false,
        forwarded_caller_id: 'business_number',
        recording_enabled: true,
      })
      .execute();

    await trx
      .insertInto('messaging.phone_system_settings')
      .values({
        business_id: business.id,
        default_phone_number_id: channel.id,
        inbound_prefer_assigned_user: false,
        inbound_allow_anonymous: true,
      })
      .execute();

    return {
      connectionId: connection.id,
      phoneNumberId: channel.id,
    };
  });

  const worker = createVoiceCallbackWorker(services, vault, publicUrl, defaultGrants);

  const inboundRequest = () => {
    const path = `/webhooks/twilio/voice/${token}/inbound`;
    const params = {
      AccountSid: accountSid,
      CallSid: callSid,
      From: from,
      To: to,
      Direction: 'inbound',
      CallStatus: 'ringing',
    };
    return {
      path,
      body: Buffer.from(new URLSearchParams(params).toString()),
      signature: expectedSignature(authToken, publicUrl + path, params),
    };
  };

  const recordingRequest = (patch: Record<string, string> = {}) => {
    const path = `/webhooks/twilio/voice/${token}/recording`;
    const params: Record<string, string> = {
      AccountSid: accountSid,
      CallSid: callSid,
      RecordingSid: sid('RE'),
      RecordingStatus: 'completed',
      RecordingDuration: '15',
      RecordingChannels: '2',
      RecordingSource: 'DialVerb',
      RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${sid('RE')}`,
      ...patch,
    };
    return {
      path,
      body: Buffer.from(new URLSearchParams(params).toString()),
      signature: expectedSignature(authToken, publicUrl + path, params),
      params,
    };
  };

  const query = <T extends object>(text: string, values: readonly unknown[] = []) =>
    database.withTenant(business.context, (s) => s.query<T>(text, values));

  const queryFirst = async <T extends object>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T> => {
    const rows = await query<T>(text, values);
    const row = rows[0];
    if (row === undefined) throw new Error(`Query returned no rows: ${text}`);
    return row;
  };

  const systemInvocation: Invocation = {
    context: {
      agencyId: agency.id,
      businessId: business.id,
      actorKind: 'system',
      correlationId: randomUUID(),
    },
    permissions: 'all',
  };

  return {
    ...made,
    agency,
    business,
    user,
    role,
    membership,
    memberPublicId,
    token,
    accountSid,
    authToken,
    callSid,
    from,
    to,
    worker,
    inboundRequest,
    recordingRequest,
    query,
    queryFirst,
    systemInvocation,
  };
}

describe('recording fetch task', () => {
  it("keeps a completed recording's audio as a private file of the business", async () => {
    const b = await world();
    const inboundRes = await b.worker.handle(b.inboundRequest());
    expect(inboundRes.statusCode).toBe(200);

    const recordingSid = sid('RE');
    const callbackRes = await b.worker.handle(
      b.recordingRequest({
        RecordingSid: recordingSid,
        RecordingStatus: 'completed',
        RecordingDuration: '15',
      }),
    );
    expect(callbackRes.statusCode).toBe(204);

    const recording = await b.queryFirst<{ id: string }>(
      'select id from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );

    const fakeMp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0x01, 0x02, 0x03]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(fakeMp3, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const task = createFetchCallRecordingTask(vault, filesPort, { fetcher });
    await task.run({ recordingId: recording.id }, { invocation: b.systemInvocation, services });

    const updated = await b.queryFirst<{ file_id: string | null; fetch_failure: string | null }>(
      'select file_id, fetch_failure from messaging.call_recordings where id = $1',
      [recording.id],
    );

    expect(updated.file_id).not.toBeNull();
    expect(updated.fetch_failure).toBeNull();

    const fileRow = await b.queryFirst<{
      id: string;
      business_id: string;
      purpose: string;
      content_type: string;
      size_bytes: string;
    }>('select id, business_id, purpose, content_type, size_bytes from files.files where id = $1', [
      updated.file_id,
    ]);

    expect(fileRow.business_id).toBe(b.business.id);
    expect(fileRow.purpose).toBe('call_recording');
    expect(fileRow.content_type).toBe('audio/mpeg');
    expect(Number(fileRow.size_bytes)).toBe(fakeMp3.byteLength);

    const storedBytes = storageMap.get(fileRow.id);
    expect(storedBytes).toBeDefined();
    if (storedBytes === undefined) throw new Error('storedBytes missing');
    expect(Buffer.compare(storedBytes, fakeMp3)).toBe(0);
  });

  it('fetches each recording once however often the task runs', async () => {
    const b = await world();
    await b.worker.handle(b.inboundRequest());

    const recordingSid = sid('RE');
    await b.worker.handle(
      b.recordingRequest({
        RecordingSid: recordingSid,
        RecordingStatus: 'completed',
      }),
    );

    const recording = await b.queryFirst<{ id: string }>(
      'select id from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );

    const fakeMp3 = new Uint8Array([1, 2, 3, 4]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(fakeMp3, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const task = createFetchCallRecordingTask(vault, filesPort, { fetcher });
    await task.run({ recordingId: recording.id }, { invocation: b.systemInvocation, services });
    expect(fetcher).toHaveBeenCalledOnce();

    const firstRow = await b.queryFirst<{ file_id: string }>(
      'select file_id from messaging.call_recordings where id = $1',
      [recording.id],
    );

    // Second run
    await task.run({ recordingId: recording.id }, { invocation: b.systemInvocation, services });
    expect(fetcher).toHaveBeenCalledOnce();

    const secondRow = await b.queryFirst<{ file_id: string }>(
      'select file_id from messaging.call_recordings where id = $1',
      [recording.id],
    );
    expect(secondRow.file_id).toBe(firstRow.file_id);
  });

  it('records that the provider no longer has the recording', async () => {
    const b = await world();
    await b.worker.handle(b.inboundRequest());

    const recordingSid = sid('RE');
    await b.worker.handle(
      b.recordingRequest({
        RecordingSid: recordingSid,
        RecordingStatus: 'completed',
      }),
    );

    const recording = await b.queryFirst<{ id: string }>(
      'select id from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );

    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const task = createFetchCallRecordingTask(vault, filesPort, { fetcher });
    await task.run({ recordingId: recording.id }, { invocation: b.systemInvocation, services });

    const row = await b.queryFirst<{ file_id: string | null; fetch_failure: string | null }>(
      'select file_id, fetch_failure from messaging.call_recordings where id = $1',
      [recording.id],
    );

    expect(row.file_id).toBeNull();
    expect(row.fetch_failure).toBe('not_found');
  });

  it('records that the recording was too large to keep', async () => {
    const b = await world();
    await b.worker.handle(b.inboundRequest());

    const recordingSid = sid('RE');
    await b.worker.handle(
      b.recordingRequest({
        RecordingSid: recordingSid,
        RecordingStatus: 'completed',
      }),
    );

    const recording = await b.queryFirst<{ id: string }>(
      'select id from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );

    const tooLargeContent = new Uint8Array(100);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(tooLargeContent, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const task = createFetchCallRecordingTask(vault, filesPort, { fetcher, maxBytes: 50 });
    await task.run({ recordingId: recording.id }, { invocation: b.systemInvocation, services });

    const row = await b.queryFirst<{ file_id: string | null; fetch_failure: string | null }>(
      'select file_id, fetch_failure from messaging.call_recordings where id = $1',
      [recording.id],
    );

    expect(row.file_id).toBeNull();
    expect(row.fetch_failure).toBe('too_large');
  });

  it("retries when the provider's answer was lost", async () => {
    const b = await world();
    await b.worker.handle(b.inboundRequest());

    const recordingSid = sid('RE');
    await b.worker.handle(
      b.recordingRequest({
        RecordingSid: recordingSid,
        RecordingStatus: 'completed',
      }),
    );

    const recording = await b.queryFirst<{ id: string }>(
      'select id from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );

    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('Network connection timeout'));

    const task = createFetchCallRecordingTask(vault, filesPort, { fetcher });

    await expect(
      task.run({ recordingId: recording.id }, { invocation: b.systemInvocation, services }),
    ).rejects.toThrow();

    const row = await b.queryFirst<{ file_id: string | null; fetch_failure: string | null }>(
      'select file_id, fetch_failure from messaging.call_recordings where id = $1',
      [recording.id],
    );

    expect(row.file_id).toBeNull();
    expect(row.fetch_failure).toBeNull();
  });

  it("leaves a recording that isn't completed alone", async () => {
    const b = await world();
    await b.worker.handle(b.inboundRequest());

    const recordingSid = sid('RE');
    await b.worker.handle(
      b.recordingRequest({
        RecordingSid: recordingSid,
        RecordingStatus: 'in-progress',
      }),
    );

    const recording = await b.queryFirst<{ id: string }>(
      'select id from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );

    const fetcher = vi.fn<typeof fetch>();
    const task = createFetchCallRecordingTask(vault, filesPort, { fetcher });

    await task.run({ recordingId: recording.id }, { invocation: b.systemInvocation, services });

    expect(fetcher).not.toHaveBeenCalled();

    const row = await b.queryFirst<{ file_id: string | null; fetch_failure: string | null }>(
      'select file_id, fetch_failure from messaging.call_recordings where id = $1',
      [recording.id],
    );

    expect(row.file_id).toBeNull();
    expect(row.fetch_failure).toBeNull();
  });

  it('is queued when the provider reports a recording completed', async () => {
    const b = await world();
    await b.worker.handle(b.inboundRequest());

    const recordingSid = sid('RE');
    const res = await b.worker.handle(
      b.recordingRequest({
        RecordingSid: recordingSid,
        RecordingStatus: 'completed',
        RecordingDuration: '30',
      }),
    );
    expect(res.statusCode).toBe(204);

    const recording = await b.queryFirst<{ id: string }>(
      'select id from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );

    const jobs = await database.as('crm_owner', (s) =>
      s.query<{ payload: { data: { recordingId: string } } }>(
        `select p.payload from graphile_worker.jobs j
         join graphile_worker._private_jobs p on p.id = j.id
         where j.task_identifier = 'messaging.fetch_call_recording'`,
      ),
    );

    const match = jobs.find((j) => j.payload.data.recordingId === recording.id);
    expect(match).toBeDefined();
  });

  it("never stores one business's recording in another's files", async () => {
    const b1 = await world();
    const b2 = await world();

    await b1.worker.handle(b1.inboundRequest());

    const recordingSid = sid('RE');
    await b1.worker.handle(
      b1.recordingRequest({
        RecordingSid: recordingSid,
        RecordingStatus: 'completed',
      }),
    );

    const recording = await b1.queryFirst<{ id: string }>(
      'select id from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );

    const fakeMp3 = new Uint8Array([11, 22, 33]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(fakeMp3, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    const task = createFetchCallRecordingTask(vault, filesPort, { fetcher });
    await task.run({ recordingId: recording.id }, { invocation: b1.systemInvocation, services });

    const recordingRow = await b1.queryFirst<{ file_id: string }>(
      'select file_id from messaging.call_recordings where id = $1',
      [recording.id],
    );

    const fileRow = await b1.queryFirst<{ id: string; business_id: string }>(
      'select id, business_id from files.files where id = $1',
      [recordingRow.file_id],
    );
    expect(fileRow.business_id).toBe(b1.business.id);

    // Business 2 cannot see Business 1's file under its tenant context
    const visibleToB2 = await withTenant(db, b2.business.context, (trx) =>
      trx
        .selectFrom('files.files')
        .selectAll()
        .where('id', '=', recordingRow.file_id)
        .executeTakeFirst(),
    );
    expect(visibleToB2).toBeUndefined();
  });
});
