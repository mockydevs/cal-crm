// Twilio recording status callback (Phone System stage PS5).
// https://www.twilio.com/docs/voice/api/recording#recordingstatuscallback
// Authenticated at the worker boundary; this command records the provider's
// recording SID without saving the provider URL.
import { defineCommand, type Command } from '@repo/commands';
import { ForbiddenError } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';
import { lockBusiness } from '../outbound.js';
import { fetchCallRecordingReference } from './recording-fetch.js';
import type { VoiceCallbackReply } from './voice-worker.js';

export const reply = (statusCode: number): VoiceCallbackReply => ({
  statusCode,
  contentType: 'text/plain',
  body: '',
});

const input = z.strictObject({
  connectionId: z.uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  params: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});

const firstParam = (v: string | readonly string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : v?.[0];

const cleanParam = (v: string | readonly string[] | undefined): string | undefined => {
  const s = firstParam(v);
  return s === undefined || s === '' ? undefined : s;
};

const recordingParamsSchema = z.object({
  RecordingSid: z.string().regex(/^RE[0-9a-fA-F]{32}$/),
  RecordingStatus: z.enum(['in-progress', 'completed', 'absent']),
  RecordingDuration: z
    .string()
    .regex(/^[0-9]+$/)
    .transform((val) => Number.parseInt(val, 10))
    .refine((n) => Number.isSafeInteger(n) && n >= 0)
    .optional(),
  RecordingChannels: z
    .string()
    .regex(/^[12]$/)
    .transform((val) => Number.parseInt(val, 10))
    .refine((n) => n === 1 || n === 2)
    .optional(),
  RecordingSource: z.string().min(1),
  CallSid: z.string().regex(/^CA[0-9a-fA-F]{32}$/),
});

export const recordRecordingCommand: Command<typeof input, VoiceCallbackReply> = defineCommand({
  name: 'call.record_recording',
  permission: 'phone.manage',
  input,
  audit: ({ connectionId, params }) => {
    const rawSid = cleanParam(params['RecordingSid']);
    return { connectionId, recordingSid: rawSid ?? null };
  },
  async handle(trx, value, command): Promise<VoiceCallbackReply> {
    if (command.context.actorKind !== 'system')
      throw new ForbiddenError('Only the voice worker records call recordings.');

    const parsed = recordingParamsSchema.safeParse({
      RecordingSid: cleanParam(value.params['RecordingSid']),
      RecordingStatus: cleanParam(value.params['RecordingStatus']),
      RecordingDuration: cleanParam(value.params['RecordingDuration']),
      RecordingChannels: cleanParam(value.params['RecordingChannels']),
      RecordingSource: cleanParam(value.params['RecordingSource']),
      CallSid: cleanParam(value.params['CallSid']),
    });
    if (!parsed.success) return reply(400);

    const businessId = await lockBusiness(trx, command.context);

    const connection = await trx
      .selectFrom('messaging.provider_connections as c')
      .innerJoin('tenancy.businesses as b', 'b.id', 'c.business_id')
      .select('c.account_ref')
      .where('c.id', '=', value.connectionId)
      .where('c.provider', '=', 'twilio')
      .where('c.status', '=', 'connected')
      .where('c.webhook_digest', '=', value.digest)
      .where('b.status', '=', 'active')
      .forShare('c')
      .executeTakeFirst();
    if (connection === undefined) return reply(404);

    const leg = await trx
      .selectFrom('messaging.call_legs')
      .select('call_id')
      .where('provider_connection_id', '=', value.connectionId)
      .where('provider_call_sid', '=', parsed.data.CallSid)
      .where('business_id', '=', businessId)
      .executeTakeFirst();
    if (leg === undefined) return reply(404);

    const kind = parsed.data.RecordingSource === 'RecordVerb' ? 'voicemail' : 'call';
    const durationSeconds =
      parsed.data.RecordingStatus === 'completed' ? (parsed.data.RecordingDuration ?? null) : null;
    const channels = parsed.data.RecordingChannels ?? null;

    const existing = await trx
      .selectFrom('messaging.call_recordings')
      .selectAll()
      .where('provider_connection_id', '=', value.connectionId)
      .where('provider_recording_sid', '=', parsed.data.RecordingSid)
      .forUpdate()
      .executeTakeFirst();

    let recordingId: string;
    let isNew = false;
    let statusChanged = false;

    if (existing === undefined) {
      isNew = true;
      const inserted = await trx
        .insertInto('messaging.call_recordings')
        .values({
          business_id: businessId,
          call_id: leg.call_id,
          provider_connection_id: value.connectionId,
          provider_recording_sid: parsed.data.RecordingSid,
          kind,
          status: parsed.data.RecordingStatus,
          duration_seconds: durationSeconds,
          channels,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      recordingId = inserted.id;
    } else {
      recordingId = existing.id;
      const shouldKeepCompleted =
        existing.status === 'completed' && parsed.data.RecordingStatus === 'in-progress';
      const newStatus = shouldKeepCompleted ? existing.status : parsed.data.RecordingStatus;
      const newDuration = shouldKeepCompleted
        ? existing.duration_seconds
        : newStatus === 'completed'
          ? (parsed.data.RecordingDuration ?? existing.duration_seconds)
          : null;
      const newChannels = parsed.data.RecordingChannels ?? existing.channels;

      if (newStatus !== existing.status) {
        statusChanged = true;
      }

      await trx
        .updateTable('messaging.call_recordings')
        .set({
          status: newStatus,
          duration_seconds: newDuration,
          channels: newChannels,
          updated_at: sql`now()`,
        })
        .where('id', '=', existing.id)
        .execute();
    }

    const becameCompleted =
      (isNew && parsed.data.RecordingStatus === 'completed') ||
      (!isNew && statusChanged && parsed.data.RecordingStatus === 'completed');
    if (becameCompleted) {
      command.enqueue(fetchCallRecordingReference, { recordingId });
    }

    if (isNew || statusChanged) {
      const call = await trx
        .selectFrom('messaging.calls')
        .select(['state', 'outcome', 'contact_id'])
        .where('id', '=', leg.call_id)
        .where('business_id', '=', businessId)
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'call.progressed',
        subject: { kind: 'call', id: leg.call_id },
        payload: { state: call.state, outcome: call.outcome },
        records: call.contact_id === null ? [] : [call.contact_id],
      });
    }

    return reply(204);
  },
});
