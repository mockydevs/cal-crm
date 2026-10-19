import { randomBytes, randomUUID } from 'node:crypto';
import { allowEveryone, type Services } from '@repo/commands';
import type { Permission } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { createVault, newSecretsKey, parseSecretsKeys, type Vault } from '@repo/module-vault';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { ReadCallGrants } from '../call-ledger.js';
import { SMS_CREDENTIALS } from '../sms-connect.js';
import { newWebhookToken, webhookDigest } from '../sms-webhook-url.js';
import { expectedSignature } from '../twilio-signature.js';
import { createVoiceCallbackWorker } from './voice-worker.js';

let database: TestDatabase;
let db: Database;
let vault: Vault;
let services: Services;
const publicUrl = 'https://crm.example.test';
const sid = (prefix: string) => `${prefix}${randomBytes(16).toString('hex')}`;
let numberSequence = 500;

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
  const from = '+12025550199';
  const to = `+1202555${String(numberSequence++).padStart(4, '0')}`;

  const user = await database.fixtures.user();
  const role = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.roles (agency_id, scope, key, name, permissions) values ($1, 'business', $2, 'Team', array['calls.place']) returning id`,
      [agency.id, `team_${randomUUID().replaceAll('-', '_')}`],
    ),
  );
  const membership = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into tenancy.memberships (agency_id, business_id, user_id, role_id) values ($1, $2, $3, $4) returning id`,
      [agency.id, business.id, user.id, role.id],
    ),
  );
  const memberPublicId = toPublicId('membership', membership.id);

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
        label: 'Voice Line',
        account_ref: accountSid,
        secret_id: secretId,
        status: 'connected',
        webhook_digest: webhookDigest(token),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('messaging.voice_setups')
      .values({
        business_id: business.id,
        connection_id: connection.id,
        status: 'ready',
        key_sid: sid('SK'),
        secret_id: secretId,
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
    database.withTenant(business.context, (sql) => sql.query<T>(text, values));

  const queryFirst = async <T extends object>(text: string, values: readonly unknown[] = []) => {
    const rows = await query<T>(text, values);
    const row = rows[0];
    if (row === undefined) throw new Error(`Query returned no rows: ${text}`);
    return row;
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
  };
}

describe('recording callback', () => {
  it('stores a completed recording of an incoming call once, however often it is reported', async () => {
    const b = await world();
    const inboundRes = await b.worker.handle(b.inboundRequest());
    expect(inboundRes.statusCode).toBe(200);

    const recordingSid = sid('RE');
    const req = b.recordingRequest({
      RecordingSid: recordingSid,
      RecordingStatus: 'completed',
      RecordingDuration: '24',
      RecordingChannels: '2',
      RecordingSource: 'DialVerb',
    });

    const res1 = await b.worker.handle(req);
    expect(res1.statusCode).toBe(204);

    const recordings1 = await b.query<{
      provider_recording_sid: string;
      kind: string;
      status: string;
      duration_seconds: number;
      channels: number;
    }>(
      'select provider_recording_sid, kind, status, duration_seconds, channels from messaging.call_recordings where business_id = $1',
      [b.business.id],
    );
    expect(recordings1).toHaveLength(1);
    expect(recordings1[0]).toMatchObject({
      provider_recording_sid: recordingSid,
      kind: 'call',
      status: 'completed',
      duration_seconds: 24,
      channels: 2,
    });

    // Repeating the same report produces no second row
    const res2 = await b.worker.handle(req);
    expect(res2.statusCode).toBe(204);

    const recordings2 = await b.query(
      'select id from messaging.call_recordings where business_id = $1',
      [b.business.id],
    );
    expect(recordings2).toHaveLength(1);
  });

  it('stores a voicemail as a voicemail', async () => {
    const b = await world();
    await b.worker.handle(b.inboundRequest());

    const recordingSid = sid('RE');
    const req = b.recordingRequest({
      RecordingSid: recordingSid,
      RecordingStatus: 'completed',
      RecordingDuration: '45',
      RecordingChannels: '1',
      RecordingSource: 'RecordVerb',
    });

    const res = await b.worker.handle(req);
    expect(res.statusCode).toBe(204);

    const row = await b.queryFirst<{
      kind: string;
      status: string;
      duration_seconds: number;
      channels: number;
    }>(
      'select kind, status, duration_seconds, channels from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );
    expect(row).toMatchObject({
      kind: 'voicemail',
      status: 'completed',
      duration_seconds: 45,
      channels: 1,
    });
  });

  it('keeps a completed recording completed when an older report arrives late', async () => {
    const b = await world();
    await b.worker.handle(b.inboundRequest());

    const recordingSid = sid('RE');
    const completedReq = b.recordingRequest({
      RecordingSid: recordingSid,
      RecordingStatus: 'completed',
      RecordingDuration: '30',
      RecordingChannels: '2',
    });
    const res1 = await b.worker.handle(completedReq);
    expect(res1.statusCode).toBe(204);

    // Later in-progress report arrives out of order
    const lateInProgressReq = b.recordingRequest({
      RecordingSid: recordingSid,
      RecordingStatus: 'in-progress',
      RecordingDuration: '',
      RecordingChannels: '2',
    });
    const res2 = await b.worker.handle(lateInProgressReq);
    expect(res2.statusCode).toBe(204);

    const row = await b.queryFirst<{ status: string; duration_seconds: number }>(
      'select status, duration_seconds from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );
    expect(row.status).toBe('completed');
    expect(row.duration_seconds).toBe(30);
  });

  it('stores an absent recording without a duration', async () => {
    const b = await world();
    await b.worker.handle(b.inboundRequest());

    const recordingSid = sid('RE');
    const req = b.recordingRequest({
      RecordingSid: recordingSid,
      RecordingStatus: 'absent',
      RecordingDuration: '',
      RecordingChannels: '1',
    });
    const res = await b.worker.handle(req);
    expect(res.statusCode).toBe(204);

    const row = await b.queryFirst<{ status: string; duration_seconds: number | null }>(
      'select status, duration_seconds from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );
    expect(row.status).toBe('absent');
    expect(row.duration_seconds).toBeNull();
  });

  it("answers 404 for a recording of a call it doesn't know", async () => {
    const b = await world();
    const req = b.recordingRequest({
      CallSid: sid('CA'),
    });
    const res = await b.worker.handle(req);
    expect(res.statusCode).toBe(404);
  });

  it("never stores the recording's address", async () => {
    const b = await world();
    await b.worker.handle(b.inboundRequest());

    const recordingSid = sid('RE');
    const secretAddress = `https://api.twilio.com/2010-04-01/Accounts/${b.accountSid}/Recordings/${recordingSid}_secret_url`;
    const req = b.recordingRequest({
      RecordingSid: recordingSid,
      RecordingUrl: secretAddress,
    });
    const res = await b.worker.handle(req);
    expect(res.statusCode).toBe(204);

    // Assert no column in messaging.call_recordings holds the RecordingUrl
    const recordingRow = await b.queryFirst<Record<string, unknown>>(
      'select * from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );
    for (const [, value] of Object.entries(recordingRow)) {
      expect(String(value)).not.toContain('_secret_url');
      expect(String(value)).not.toContain(secretAddress);
    }

    // Assert no audit row holds the RecordingUrl
    const audits = await database.as('crm_owner', (sql) =>
      sql.query<{ input: unknown }>(
        "select input from audit.commands where business_id = $1 and command = 'call.record_recording'",
        [b.business.id],
      ),
    );
    expect(audits.length).toBeGreaterThan(0);
    for (const audit of audits) {
      const inputStr = JSON.stringify(audit.input);
      expect(inputStr).not.toContain('_secret_url');
      expect(inputStr).not.toContain(secretAddress);
      expect(inputStr).toContain(recordingSid);
    }
  });

  it("keeps two businesses' recordings apart", async () => {
    const b1 = await world();
    const b2 = await world();

    await b1.worker.handle(b1.inboundRequest());
    await b2.worker.handle(b2.inboundRequest());

    const rec1Sid = sid('RE');
    const rec1 = b1.recordingRequest({ RecordingSid: rec1Sid });
    const res1 = await b1.worker.handle(rec1);
    expect(res1.statusCode).toBe(204);

    // b2 cannot see b1's recording
    const b2RecordingsBefore = await b2.query(
      'select id from messaging.call_recordings where business_id = $1',
      [b2.business.id],
    );
    expect(b2RecordingsBefore).toHaveLength(0);

    // b2 webhook handling b1's callSid returns 404 (b1's call is not on b2's connection)
    const crossReq = b2.recordingRequest({
      CallSid: b1.callSid,
    });
    const crossRes = await b2.worker.handle(crossReq);
    expect(crossRes.statusCode).toBe(404);

    // b2 records its own call
    const rec2Sid = sid('RE');
    const rec2 = b2.recordingRequest({ RecordingSid: rec2Sid });
    const res2 = await b2.worker.handle(rec2);
    expect(res2.statusCode).toBe(204);

    const b1Final = await b1.query<{ provider_recording_sid: string }>(
      'select provider_recording_sid from messaging.call_recordings where business_id = $1',
      [b1.business.id],
    );
    const b2Final = await b2.query<{ provider_recording_sid: string }>(
      'select provider_recording_sid from messaging.call_recordings where business_id = $1',
      [b2.business.id],
    );
    expect(b1Final).toHaveLength(1);
    expect(b1Final[0]?.provider_recording_sid).toBe(rec1Sid);
    expect(b2Final).toHaveLength(1);
    expect(b2Final[0]?.provider_recording_sid).toBe(rec2Sid);
  });

  it('stores a completed recording of an outbound call', async () => {
    const b = await world();
    const outboundCallSid = sid('CA');

    // Create an outbound call and root leg
    const call = await withTenant(db, b.business.context, async (trx) => {
      const c = await trx
        .insertInto('messaging.calls')
        .values({
          business_id: b.business.id,
          direction: 'outbound',
          phone_number_id: b.phoneNumberId,
          provider_connection_id: b.connectionId,
          local_e164: b.to,
          remote_e164: b.from,
          requested_by_kind: 'user',
          requested_by_id: b.user.id,
          state: 'dialing',
          idempotency_key: 'idem-test-recording',
          request_hash: 'c'.repeat(64),
          reserved_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('messaging.call_legs')
        .values({
          business_id: b.business.id,
          call_id: c.id,
          party: 'remote',
          provider_connection_id: b.connectionId,
          provider_call_sid: outboundCallSid,
          status: 'ringing',
        })
        .execute();

      return c;
    });

    const recordingSid = sid('RE');
    const req = b.recordingRequest({
      CallSid: outboundCallSid,
      RecordingSid: recordingSid,
      RecordingStatus: 'completed',
      RecordingDuration: '50',
      RecordingChannels: '2',
      RecordingSource: 'DialVerb',
    });

    const res = await b.worker.handle(req);
    expect(res.statusCode).toBe(204);

    const row = await b.queryFirst<{
      call_id: string;
      kind: string;
      status: string;
      duration_seconds: number;
    }>(
      'select call_id, kind, status, duration_seconds from messaging.call_recordings where provider_recording_sid = $1',
      [recordingSid],
    );
    expect(row).toMatchObject({
      call_id: call.id,
      kind: 'call',
      status: 'completed',
      duration_seconds: 50,
    });
  });
});
