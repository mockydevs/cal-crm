import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { allowEveryone, type Services } from '@repo/commands';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { SMS_CREDENTIALS } from '../sms-connect.js';
import { newWebhookToken, webhookDigest } from '../sms-webhook-url.js';
import { VOICE_SIGNING_KEY } from '../voice-setup.js';
import { expireCallRecordings, type RecordingRetentionFiles } from './recording-retention.js';

let database: TestDatabase;
let db: Database;
let vault: Vault;
let services: Services;
let numberSequence = 800;

const sid = (prefix: string) => `${prefix}${randomBytes(16).toString('hex')}`;

function createFakeFiles() {
  const discarded: string[] = [];
  const files: RecordingRetentionFiles = {
    async discard(_trx, _command, fileId) {
      await Promise.resolve();
      discarded.push(fileId);
    },
  };
  return { files, discarded };
}

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  vault = await createVault(parseSecretsKeys((await newSecretsKey(1)).secretsKey));
  services = { db, authorize: allowEveryone };
});

beforeEach(async () => {
  await database.as('crm_owner', (s) => s.query('delete from messaging.call_recordings'));
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

interface SeedWorldOptions {
  readonly retentionDays: number | null;
  readonly connectionStatus?: 'connected' | 'disconnected';
}

async function seedWorld(options: SeedWorldOptions) {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const token = newWebhookToken();
  const accountSid = sid('AC');
  const authToken = 'synthetic-auth-token';
  const keySid = sid('SK');
  const keySecret = 'synthetic-key-secret';
  const e164 = `+1202555${String(numberSequence++).padStart(4, '0')}`;

  const setup = await withTenant(db, business.context, async (trx) => {
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
        status: options.connectionStatus ?? 'connected',
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
        e164,
        provider_connection_id: connection.id,
        provider_number_ref: sid('PN'),
        capabilities: ['voice'],
      })
      .execute();

    await trx
      .insertInto('messaging.phone_system_settings')
      .values({
        business_id: business.id,
        default_phone_number_id: channel.id,
        recording_retention_days: options.retentionDays,
      })
      .execute();

    return {
      connectionId: connection.id,
      phoneNumberId: channel.id,
      accountSid,
    };
  });

  async function createCall() {
    return withTenant(db, business.context, async (trx) => {
      const call = await trx
        .insertInto('messaging.calls')
        .values({
          business_id: business.id,
          direction: 'inbound',
          state: 'ended',
          outcome: 'completed',
          phone_number_id: setup.phoneNumberId,
          provider_connection_id: setup.connectionId,
          local_e164: e164,
          remote_e164: '+14155550199',
          requested_by_kind: 'system',
          idempotency_key: `call-${randomUUID()}`,
          request_hash: randomBytes(32).toString('hex'),
          ended_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return call.id;
    });
  }

  async function createRecording(
    callId: string,
    recordingOptions: {
      readonly createdAt: Date;
      readonly file?: boolean;
      readonly recordingSid?: string;
    },
  ) {
    return withTenant(db, business.context, async (trx) => {
      let fileId: string | null = null;
      if (recordingOptions.file) {
        const { id } = await trx
          .selectNoFrom(sql<string>`uuidv7()`.as('id'))
          .executeTakeFirstOrThrow();
        fileId = id;
        await trx
          .insertInto('files.files')
          .values({
            id: fileId,
            agency_id: agency.id,
            business_id: business.id,
            storage: 'local',
            storage_key: fileId,
            filename: `call-recording-${fileId}.mp3`,
            content_type: 'audio/mpeg',
            size_bytes: 512,
            sha256: createHash('sha256').update('sample-audio').digest(),
            uploaded_by_kind: 'system',
            uploaded_by_id: null,
            purpose: 'call_recording',
          })
          .execute();
      }

      const recSid = recordingOptions.recordingSid ?? sid('RE');
      const row = await trx
        .insertInto('messaging.call_recordings')
        .values({
          business_id: business.id,
          call_id: callId,
          provider_connection_id: setup.connectionId,
          provider_recording_sid: recSid,
          kind: 'call',
          status: 'completed',
          duration_seconds: 25,
          channels: 2,
          file_id: fileId,
          created_at: recordingOptions.createdAt,
          updated_at: recordingOptions.createdAt,
        })
        .returning(['id', 'file_id', 'provider_recording_sid'])
        .executeTakeFirstOrThrow();

      return row;
    });
  }

  return {
    agency,
    business,
    setup,
    createCall,
    createRecording,
  };
}

describe('recording retention sweep', () => {
  it('deletes a recording older than the business keeps them, from the provider and its files', async () => {
    const world = await seedWorld({ retentionDays: 7 });
    const callId = await world.createCall();
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    const recording = await world.createRecording(callId, {
      createdAt: eightDaysAgo,
      file: true,
    });

    const { files, discarded } = createFakeFiles();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    const expired = await expireCallRecordings(services, {
      vault,
      files,
      fetcher,
    });

    expect(expired).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetcher.mock.calls[0] ?? [];
    const calledUrlString =
      typeof calledUrl === 'string' ? calledUrl : calledUrl instanceof URL ? calledUrl.href : '';
    expect(calledUrlString).toContain(
      `/Accounts/${world.setup.accountSid}/Recordings/${recording.provider_recording_sid}.json`,
    );
    expect(calledInit?.method).toBe('DELETE');
    expect(discarded).toEqual([recording.file_id]);

    const updated = await withTenant(db, world.business.context, async (trx) =>
      trx
        .selectFrom('messaging.call_recordings')
        .select(['id', 'file_id', 'deleted_at'])
        .where('id', '=', recording.id)
        .executeTakeFirstOrThrow(),
    );
    expect(updated.file_id).toBeNull();
    expect(updated.deleted_at).toBeInstanceOf(Date);
  });

  it('keeps a recording younger than the limit', async () => {
    const world = await seedWorld({ retentionDays: 7 });
    const callId = await world.createCall();
    const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000);
    const recording = await world.createRecording(callId, {
      createdAt: sixDaysAgo,
      file: true,
    });

    const { files, discarded } = createFakeFiles();
    const fetcher = vi.fn<typeof fetch>();

    const expired = await expireCallRecordings(services, {
      vault,
      files,
      fetcher,
    });

    expect(expired).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(discarded).toHaveLength(0);

    const check = await withTenant(db, world.business.context, async (trx) =>
      trx
        .selectFrom('messaging.call_recordings')
        .select(['id', 'file_id', 'deleted_at'])
        .where('id', '=', recording.id)
        .executeTakeFirstOrThrow(),
    );
    expect(check.file_id).toBe(recording.file_id);
    expect(check.deleted_at).toBeNull();
  });

  it("keeps a business's younger recordings while deleting its older ones", async () => {
    const world = await seedWorld({ retentionDays: 7 });
    const callId = await world.createCall();
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000);
    const oldRecording = await world.createRecording(callId, {
      createdAt: eightDaysAgo,
      file: true,
    });
    const youngRecording = await world.createRecording(callId, {
      createdAt: sixDaysAgo,
      file: true,
    });

    const { files, discarded } = createFakeFiles();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    const expired = await expireCallRecordings(services, {
      vault,
      files,
      fetcher,
    });

    expect(expired).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetcher.mock.calls[0] ?? [];
    const calledUrlString =
      typeof calledUrl === 'string' ? calledUrl : calledUrl instanceof URL ? calledUrl.href : '';
    expect(calledUrlString).toContain(
      `/Accounts/${world.setup.accountSid}/Recordings/${oldRecording.provider_recording_sid}.json`,
    );
    expect(calledInit?.method).toBe('DELETE');
    expect(discarded).toEqual([oldRecording.file_id]);

    const rows = await withTenant(db, world.business.context, async (trx) =>
      trx
        .selectFrom('messaging.call_recordings')
        .select(['id', 'file_id', 'deleted_at'])
        .where('id', 'in', [oldRecording.id, youngRecording.id])
        .execute(),
    );
    const oldRow = rows.find((r) => r.id === oldRecording.id);
    const youngRow = rows.find((r) => r.id === youngRecording.id);

    expect(oldRow?.file_id).toBeNull();
    expect(oldRow?.deleted_at).toBeInstanceOf(Date);

    expect(youngRow?.file_id).toBe(youngRecording.file_id);
    expect(youngRow?.deleted_at).toBeNull();
  });

  it('keeps every recording when the business keeps them forever', async () => {
    const world = await seedWorld({ retentionDays: null });
    const callId = await world.createCall();
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
    const recording = await world.createRecording(callId, {
      createdAt: sixtyDaysAgo,
      file: true,
    });

    const { files, discarded } = createFakeFiles();
    const fetcher = vi.fn<typeof fetch>();

    const expired = await expireCallRecordings(services, {
      vault,
      files,
      fetcher,
    });

    expect(expired).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(discarded).toHaveLength(0);

    const check = await withTenant(db, world.business.context, async (trx) =>
      trx
        .selectFrom('messaging.call_recordings')
        .select(['id', 'file_id', 'deleted_at'])
        .where('id', '=', recording.id)
        .executeTakeFirstOrThrow(),
    );
    expect(check.file_id).toBe(recording.file_id);
    expect(check.deleted_at).toBeNull();
  });

  it("retries a recording the provider's answer was lost for", async () => {
    const world = await seedWorld({ retentionDays: 7 });
    const callId = await world.createCall();
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    const recording = await world.createRecording(callId, {
      createdAt: eightDaysAgo,
      file: true,
    });

    const { files, discarded } = createFakeFiles();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 }));

    const expired = await expireCallRecordings(services, {
      vault,
      files,
      fetcher,
    });

    expect(expired).toBe(0);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(discarded).toHaveLength(0);

    const check = await withTenant(db, world.business.context, async (trx) =>
      trx
        .selectFrom('messaging.call_recordings')
        .select(['id', 'file_id', 'deleted_at'])
        .where('id', '=', recording.id)
        .executeTakeFirstOrThrow(),
    );
    expect(check.file_id).toBe(recording.file_id);
    expect(check.deleted_at).toBeNull();
  });

  it('still removes the file when the account was disconnected', async () => {
    const world = await seedWorld({ retentionDays: 7, connectionStatus: 'disconnected' });
    const callId = await world.createCall();
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
    const recording = await world.createRecording(callId, {
      createdAt: eightDaysAgo,
      file: true,
    });

    const { files, discarded } = createFakeFiles();
    const fetcher = vi.fn<typeof fetch>();

    const expired = await expireCallRecordings(services, {
      vault,
      files,
      fetcher,
    });

    expect(expired).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(discarded).toEqual([recording.file_id]);

    const updated = await withTenant(db, world.business.context, async (trx) =>
      trx
        .selectFrom('messaging.call_recordings')
        .select(['id', 'file_id', 'deleted_at'])
        .where('id', '=', recording.id)
        .executeTakeFirstOrThrow(),
    );
    expect(updated.file_id).toBeNull();
    expect(updated.deleted_at).toBeInstanceOf(Date);
  });

  it('takes at most 200 a run, oldest first', async () => {
    const world = await seedWorld({ retentionDays: 7 });
    const callId = await world.createCall();

    const createdIds: string[] = [];
    // Insert 205 recordings, each 1 second apart, starting 15 days ago.
    const baseTime = Date.now() - 15 * 86_400_000;
    for (let i = 0; i < 205; i++) {
      const rec = await world.createRecording(callId, {
        createdAt: new Date(baseTime + i * 1000),
        file: false,
      });
      createdIds.push(rec.id);
    }

    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    const expired = await expireCallRecordings(services, {
      vault,
      fetcher,
    });

    expect(expired).toBe(200);

    const remainingRows = await withTenant(db, world.business.context, async (trx) =>
      trx
        .selectFrom('messaging.call_recordings')
        .select(['id', 'deleted_at'])
        .where('business_id', '=', world.business.id)
        .where('deleted_at', 'is', null)
        .execute(),
    );

    expect(remainingRows).toHaveLength(5);
    const remainingIds = new Set(remainingRows.map((r) => r.id));
    // The remaining 5 must be the newest 5 (indices 200 to 204).
    const unexpired = createdIds.slice(200, 205);
    for (const id of unexpired) {
      expect(remainingIds.has(id)).toBe(true);
    }
  });

  it("never touches another business's recordings", async () => {
    const worldA = await seedWorld({ retentionDays: 7 });
    const worldB = await seedWorld({ retentionDays: 30 });

    const callA = await worldA.createCall();
    const callB = await worldB.createCall();

    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    const recordingA = await worldA.createRecording(callA, {
      createdAt: tenDaysAgo,
      file: true,
    });
    // recordingB is 10 days old, but worldB keeps for 30 days.
    const recordingB = await worldB.createRecording(callB, {
      createdAt: tenDaysAgo,
      file: true,
    });

    const { files, discarded } = createFakeFiles();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    const expired = await expireCallRecordings(services, {
      vault,
      files,
      fetcher,
    });

    expect(expired).toBe(1);
    expect(discarded).toEqual([recordingA.file_id]);

    const checkA = await withTenant(db, worldA.business.context, async (trx) =>
      trx
        .selectFrom('messaging.call_recordings')
        .select(['id', 'deleted_at'])
        .where('id', '=', recordingA.id)
        .executeTakeFirstOrThrow(),
    );
    expect(checkA.deleted_at).toBeInstanceOf(Date);

    const checkB = await withTenant(db, worldB.business.context, async (trx) =>
      trx
        .selectFrom('messaging.call_recordings')
        .select(['id', 'deleted_at'])
        .where('id', '=', recordingB.id)
        .executeTakeFirstOrThrow(),
    );
    expect(checkB.deleted_at).toBeNull();
  });
});
