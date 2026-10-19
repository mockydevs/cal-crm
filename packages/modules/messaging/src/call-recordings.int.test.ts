// Call recordings: reading a call's recordings and voicemails with short-lived playback
// links, backed by the files port and tenant isolation.
import { randomBytes, randomUUID } from 'node:crypto';

import { type Invocation, type Services } from '@repo/commands';
import { callRecordings, type CallRecordings, type Permission } from '@repo/contracts';
import { connectDatabase, withTenant, type Database } from '@repo/db';
import { ForbiddenError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { sql } from 'kysely';

import { createCallRoutes } from './call-routes.js';
import type { RecordingFiles } from './voice/recording-fetch.js';

const FAKE_MP3_CALL = new Uint8Array([
  0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const FAKE_MP3_VOICEMAIL = new Uint8Array([
  0xff, 0xfb, 0x90, 0x64, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
]);

let database: TestDatabase;
let db: Database;
let services: Services;

beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = {
    db,
    authorize: (invocation, permission) =>
      invocation.permissions === 'all' || invocation.permissions.has(permission as Permission),
  };
});

afterAll(async () => {
  await db.destroy();
  await database.close();
});

const storageMap = new Map<string, { bytes: Uint8Array; purpose: string | null }>();

const filesPort: RecordingFiles & {
  open: (url: string) => Uint8Array | undefined;
  generalLink: (fileId: string) => Promise<{ path: string; expiresAt: string }>;
} = {
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
        size_bytes: file.content.length,
        sha256: Buffer.alloc(32),
        uploaded_by_kind: command.context.actorKind,
        purpose: file.purpose,
      })
      .execute();
    storageMap.set(id, { bytes: file.content, purpose: file.purpose });
    return { id };
  },
  async link(_services, _invocation, fileId, lifetime) {
    await Promise.resolve();
    const rawUuid = parsePublicId('file', fileId) ?? fileId;
    const stored = storageMap.get(rawUuid);
    if (stored?.purpose !== lifetime.purpose) {
      throw new NotFoundError('file', fileId);
    }
    return {
      path: `/files/${fileId}/content?token=${rawUuid}`,
      expiresAt: new Date(Date.now() + lifetime.seconds * 1000).toISOString(),
    };
  },
  open(url: string) {
    const parsed = new URL(url);
    const token = parsed.searchParams.get('token');
    if (token === null) return undefined;
    return storageMap.get(token)?.bytes;
  },
  async generalLink(fileId: string) {
    await Promise.resolve();
    const rawUuid = parsePublicId('file', fileId) ?? fileId;
    const stored = storageMap.get(rawUuid);
    // General link refuses purpose-restricted files
    if (stored?.purpose !== null && stored?.purpose !== undefined) {
      throw new NotFoundError('file', fileId);
    }
    return {
      path: `/files/${fileId}/content?token=${rawUuid}`,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
  },
};

let phoneSequence = 1000;

async function setupBusiness() {
  const agency = await database.fixtures.agency();
  const business = await database.fixtures.business(agency.id);
  const e164 = `+1415555${String(phoneSequence++).padStart(4, '0')}`;
  const invocation: Invocation = {
    context: {
      agencyId: agency.id,
      businessId: business.id,
      actorKind: 'user',
      actorId: randomUUID(),
      correlationId: randomUUID(),
    },
    permissions: new Set<Permission>(['calls.read', 'calls.place']),
  };

  const setup = await withTenant(db, business.context, async (trx) => {
    const secret = await trx
      .insertInto('vault.secrets')
      .values({
        agency_id: agency.id,
        business_id: business.id,
        purpose: 'messaging.sms_credentials',
        key_version: 1,
        ciphertext: Buffer.alloc(32),
        enc: Buffer.alloc(32),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const connection = await trx
      .insertInto('messaging.provider_connections')
      .values({
        agency_id: agency.id,
        business_id: business.id,
        provider: 'twilio',
        label: 'Twilio test',
        account_ref: `AC${randomUUID().replaceAll('-', '')}`,
        secret_id: secret.id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const channel = await trx
      .insertInto('messaging.channel_accounts')
      .values({
        business_id: business.id,
        channel: 'sms',
        name: 'Voice Line',
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const number = await trx
      .insertInto('messaging.phone_numbers')
      .values({
        id: channel.id,
        business_id: business.id,
        provider_connection_id: connection.id,
        e164,
        provider_number_ref: `PN${randomUUID().replaceAll('-', '')}`,
        capabilities: ['voice'],
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    return { connectionId: connection.id, phoneNumberId: number.id, e164 };
  });

  async function createCall() {
    const call = await withTenant(db, business.context, async (trx) =>
      trx
        .insertInto('messaging.calls')
        .values({
          business_id: business.id,
          direction: 'inbound',
          state: 'ended',
          outcome: 'completed',
          phone_number_id: setup.phoneNumberId,
          provider_connection_id: setup.connectionId,
          local_e164: setup.e164,
          remote_e164: '+14155550122',
          requested_by_kind: 'system',
          idempotency_key: `call-${randomUUID()}`,
          request_hash: randomBytes(32).toString('hex'),
          ended_at: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    return { id: call.id, publicId: toPublicId('call', call.id) };
  }

  return { agency, business, invocation, connectionId: setup.connectionId, createCall };
}

describe('GET /calls/{id}/recordings', () => {
  const apiUrl = 'https://crm.example.com/api/v1';
  const routes = createCallRoutes(() => Promise.resolve({ available: true, unavailable: null }), {
    files: filesPort,
    apiUrl,
  });
  const listRoute = routes.find((r) => r.endpoint.operationId === 'listCallRecordings');
  if (listRoute === undefined) throw new Error('listCallRecordings route missing');

  it("lists a call's recording and voicemail, each with a link that plays it", async () => {
    const b = await setupBusiness();
    const call = await b.createCall();

    const { callFileId, voicemailFileId } = await withTenant(
      db,
      b.business.context,
      async (trx) => {
        const commandContext = {
          ...b.invocation.context,
          actorKind: 'system' as const,
        };
        const f1 = await filesPort.store(
          trx,
          {
            context: commandContext,
            permissions: 'all',
            emit: () => Promise.resolve('evt_id'),
            enqueue: () => undefined,
          },
          {
            filename: 'call-recording-1.mp3',
            contentType: 'audio/mpeg',
            content: FAKE_MP3_CALL,
            purpose: 'call_recording',
            quota: true,
          },
        );
        const f2 = await filesPort.store(
          trx,
          {
            context: commandContext,
            permissions: 'all',
            emit: () => Promise.resolve('evt_id'),
            enqueue: () => undefined,
          },
          {
            filename: 'voicemail-recording-1.mp3',
            contentType: 'audio/mpeg',
            content: FAKE_MP3_VOICEMAIL,
            purpose: 'call_recording',
            quota: true,
          },
        );
        return { callFileId: f1.id, voicemailFileId: f2.id };
      },
    );

    const { callRecordingId, voicemailRecordingId } = await withTenant(
      db,
      b.business.context,
      async (trx) => {
        const r1 = await trx
          .insertInto('messaging.call_recordings')
          .values({
            business_id: b.business.id,
            call_id: call.id,
            provider_connection_id: b.connectionId,
            provider_recording_sid: `RE${randomUUID().replaceAll('-', '')}`,
            kind: 'call',
            status: 'completed',
            duration_seconds: 42,
            channels: 2,
            file_id: callFileId,
            created_at: new Date('2026-10-15T12:00:00.000Z'),
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        const r2 = await trx
          .insertInto('messaging.call_recordings')
          .values({
            business_id: b.business.id,
            call_id: call.id,
            provider_connection_id: b.connectionId,
            provider_recording_sid: `RE${randomUUID().replaceAll('-', '')}`,
            kind: 'voicemail',
            status: 'completed',
            duration_seconds: 18,
            channels: 1,
            file_id: voicemailFileId,
            created_at: new Date('2026-10-15T12:05:00.000Z'),
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        return { callRecordingId: r1.id, voicemailRecordingId: r2.id };
      },
    );

    const result = (await listRoute.run(
      { invocation: b.invocation, params: { id: call.publicId }, query: {}, body: undefined },
      services,
    )) as CallRecordings;

    const validated = callRecordings.parse(result);
    expect(validated.data).toHaveLength(2);

    // Newest first (r2 was created at 12:05, r1 at 12:00)
    const [first, second] = validated.data;
    if (first === undefined || second === undefined) throw new Error('Expected two recordings');

    expect(first.id).toBe(toPublicId('call_recording', voicemailRecordingId));
    expect(first.kind).toBe('voicemail');
    expect(first.status).toBe('completed');
    expect(first.durationSeconds).toBe(18);
    expect(first.unavailable).toBeNull();
    expect(first.audio).not.toBeNull();
    expect(first.audio?.url).toContain(apiUrl);

    expect(second.id).toBe(toPublicId('call_recording', callRecordingId));
    expect(second.kind).toBe('call');
    expect(second.status).toBe('completed');
    expect(second.durationSeconds).toBe(42);
    expect(second.unavailable).toBeNull();
    expect(second.audio).not.toBeNull();

    // Open link through the files module/port and get the bytes
    const vmBytes = filesPort.open(first.audio?.url ?? '');
    expect(vmBytes).toBeDefined();
    if (vmBytes === undefined) throw new Error('vmBytes missing');
    expect(Buffer.compare(vmBytes, FAKE_MP3_VOICEMAIL)).toBe(0);

    const callBytes = filesPort.open(second.audio?.url ?? '');
    expect(callBytes).toBeDefined();
    if (callBytes === undefined) throw new Error('callBytes missing');
    expect(Buffer.compare(callBytes, FAKE_MP3_CALL)).toBe(0);
  });

  it('reports a recording not_ready while its audio is being fetched', async () => {
    const b = await setupBusiness();
    const call = await b.createCall();

    const rec = await withTenant(db, b.business.context, async (trx) =>
      trx
        .insertInto('messaging.call_recordings')
        .values({
          business_id: b.business.id,
          call_id: call.id,
          provider_connection_id: b.connectionId,
          provider_recording_sid: `RE${randomUUID().replaceAll('-', '')}`,
          kind: 'call',
          status: 'completed',
          duration_seconds: 30,
          channels: 1,
          file_id: null,
          fetch_failure: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );

    const result = (await listRoute.run(
      { invocation: b.invocation, params: { id: call.publicId }, query: {}, body: undefined },
      services,
    )) as CallRecordings;

    const validated = callRecordings.parse(result);
    expect(validated.data).toHaveLength(1);
    const item = validated.data[0];
    if (item === undefined) throw new Error('Expected recording');
    expect(item.id).toBe(toPublicId('call_recording', rec.id));
    expect(item.status).toBe('completed');
    expect(item.audio).toBeNull();
    expect(item.unavailable).toBe('not_ready');
  });

  it('reports a recording not_found when the provider lost its audio', async () => {
    const b = await setupBusiness();
    const call = await b.createCall();

    await withTenant(db, b.business.context, async (trx) =>
      trx
        .insertInto('messaging.call_recordings')
        .values({
          business_id: b.business.id,
          call_id: call.id,
          provider_connection_id: b.connectionId,
          provider_recording_sid: `RE${randomUUID().replaceAll('-', '')}`,
          kind: 'call',
          status: 'completed',
          duration_seconds: 30,
          channels: 1,
          file_id: null,
          fetch_failure: 'not_found',
        })
        .execute(),
    );

    const result = (await listRoute.run(
      { invocation: b.invocation, params: { id: call.publicId }, query: {}, body: undefined },
      services,
    )) as CallRecordings;

    const validated = callRecordings.parse(result);
    expect(validated.data).toHaveLength(1);
    const item = validated.data[0];
    if (item === undefined) throw new Error('Expected recording');
    expect(item.audio).toBeNull();
    expect(item.unavailable).toBe('not_found');
  });

  it('reports a recording too_large when the audio exceeded the size limit', async () => {
    const b = await setupBusiness();
    const call = await b.createCall();

    await withTenant(db, b.business.context, async (trx) =>
      trx
        .insertInto('messaging.call_recordings')
        .values({
          business_id: b.business.id,
          call_id: call.id,
          provider_connection_id: b.connectionId,
          provider_recording_sid: `RE${randomUUID().replaceAll('-', '')}`,
          kind: 'call',
          status: 'completed',
          duration_seconds: 1800,
          channels: 2,
          file_id: null,
          fetch_failure: 'too_large',
        })
        .execute(),
    );

    const result = (await listRoute.run(
      { invocation: b.invocation, params: { id: call.publicId }, query: {}, body: undefined },
      services,
    )) as CallRecordings;

    const validated = callRecordings.parse(result);
    expect(validated.data).toHaveLength(1);
    const item = validated.data[0];
    if (item === undefined) throw new Error('Expected recording');
    expect(item.audio).toBeNull();
    expect(item.unavailable).toBe('too_large');
  });

  it("answers 404 for another business's call", async () => {
    const b1 = await setupBusiness();
    const b2 = await setupBusiness();
    const callOfB2 = await b2.createCall();

    await expect(
      listRoute.run(
        {
          invocation: b1.invocation,
          params: { id: callOfB2.publicId },
          query: {},
          body: undefined,
        },
        services,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a person without calls.read permission', async () => {
    const b = await setupBusiness();
    const call = await b.createCall();
    const noReadInvocation: Invocation = {
      ...b.invocation,
      permissions: new Set<Permission>(['calls.place']),
    };

    await expect(
      listRoute.run(
        { invocation: noReadInvocation, params: { id: call.publicId }, query: {}, body: undefined },
        services,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('refuses to serve a call recording through the general file link', async () => {
    const b = await setupBusiness();
    const stored = await withTenant(db, b.business.context, async (trx) => {
      const commandContext = {
        ...b.invocation.context,
        actorKind: 'system' as const,
      };
      return filesPort.store(
        trx,
        {
          context: commandContext,
          permissions: 'all',
          emit: () => Promise.resolve('evt_id'),
          enqueue: () => undefined,
        },
        {
          filename: 'private-recording.mp3',
          contentType: 'audio/mpeg',
          content: FAKE_MP3_CALL,
          purpose: 'call_recording',
          quota: true,
        },
      );
    });

    const filePublicId = toPublicId('file', stored.id);

    // General file link refuses purpose-restricted files
    await expect(filesPort.generalLink(filePublicId)).rejects.toBeInstanceOf(NotFoundError);

    // Purpose 'call_recording' succeeds
    const recordingLink = await filesPort.link(services, b.invocation, filePublicId, {
      seconds: 600,
      purpose: 'call_recording',
    });
    expect(recordingLink.path).toContain(filePublicId);
  });
});
