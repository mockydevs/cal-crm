import {
  requireBusiness,
  requirePermission,
  runCommand,
  type ApiRoute,
  type Route,
} from '@repo/commands';
import {
  getCall,
  getCallingAvailability,
  getVoiceGrant,
  hangUpCall,
  listCallRecordings,
  listCalls,
  parseInput,
  requestCall,
  requestVoiceGrant,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';

import { listCallRecords, readCallDetail, uuidOf } from './call-records.js';
import {
  createRequestCallCommand,
  hangUpCallCommand,
  type CallingAvailability,
} from './call-requests.js';
import { readVoiceGrant, requestVoiceGrantCommand } from './voice-grants.js';
import type { RecordingFiles } from './voice/recording-fetch.js';

export const RECORDING_LINK_LIFETIME_SECONDS = 600;

export interface CallRouteOptions {
  readonly files?: RecordingFiles | undefined;
  readonly apiUrl?: string | undefined;
}

/**
 * Calls. Reading needs calls.read; asking for and ending calls need calls.place.
 * `availability` is Phone System's readPhoneCalling: until it says calls can be made, a
 * request is refused rather than stored to wait.
 */
export function createCallRoutes(
  availability: CallingAvailability,
  options: CallRouteOptions = {},
): readonly ApiRoute[] {
  const requestCallCommand = createRequestCallCommand(availability);
  const list = {
    endpoint: listCalls,
    async run({ invocation, query }, services) {
      await requirePermission(
        services,
        { name: 'call.list', permission: 'calls.read' },
        invocation,
      );
      requireBusiness(invocation.context);
      const parsed = parseInput(listCalls.query, query);
      return withTenant(services.db, invocation.context, (trx) =>
        listCallRecords(trx, invocation.context, parsed),
      );
    },
  } satisfies Route<typeof listCalls>;
  const detail = {
    endpoint: getCall,
    async run({ invocation, params }, services) {
      await requirePermission(
        services,
        { name: 'call.read', permission: 'calls.read' },
        invocation,
      );
      requireBusiness(invocation.context);
      const { id } = parseInput(getCall.params, params);
      return withTenant(services.db, invocation.context, (trx) => readCallDetail(trx, id));
    },
  } satisfies Route<typeof getCall>;
  const request = {
    endpoint: requestCall,
    command: requestCallCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, requestCallCommand, body, invocation),
  } satisfies Route<typeof requestCall>;
  const hangUp = {
    endpoint: hangUpCall,
    command: hangUpCallCommand,
    run: ({ invocation, params }, services) =>
      runCommand(services, hangUpCallCommand, parseInput(hangUpCall.params, params), invocation),
  } satisfies Route<typeof hangUpCall>;
  const grant = {
    endpoint: requestVoiceGrant,
    command: requestVoiceGrantCommand,
    run: ({ invocation }, services) =>
      runCommand(services, requestVoiceGrantCommand, {}, invocation),
  } satisfies Route<typeof requestVoiceGrant>;
  const readGrant = {
    endpoint: getVoiceGrant,
    async run({ invocation, params }, services) {
      await requirePermission(
        services,
        { name: 'call.read_voice_grant', permission: 'calls.place' },
        invocation,
      );
      requireBusiness(invocation.context);
      const { id } = parseInput(getVoiceGrant.params, params);
      return withTenant(services.db, invocation.context, (trx) => readVoiceGrant(trx, id));
    },
  } satisfies Route<typeof getVoiceGrant>;
  const callingAvailability = {
    endpoint: getCallingAvailability,
    async run({ invocation }, services) {
      await requirePermission(
        services,
        { name: 'call.read_availability', permission: 'calls.read' },
        invocation,
      );
      requireBusiness(invocation.context);
      return withTenant(services.db, invocation.context, availability);
    },
  } satisfies Route<typeof getCallingAvailability>;
  const recordings = {
    endpoint: listCallRecordings,
    async run({ invocation, params }, services) {
      await requirePermission(
        services,
        { name: 'call.read', permission: 'calls.read' },
        invocation,
      );
      requireBusiness(invocation.context);
      const { id } = parseInput(listCallRecordings.params, params);
      const rows = await withTenant(services.db, invocation.context, async (trx) => {
        await readCallDetail(trx, id);
        const callUuid = uuidOf('call', id);
        return trx
          .selectFrom('messaging.call_recordings')
          .select([
            'id',
            'kind',
            'status',
            'duration_seconds',
            'created_at',
            'file_id',
            'fetch_failure',
          ])
          .where('call_id', '=', callUuid)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(20)
          .execute();
      });

      const data = await Promise.all(
        rows.map(async (row) => {
          let unavailable: 'not_found' | 'too_large' | 'not_ready' | null = null;
          if (row.fetch_failure === 'not_found' || row.fetch_failure === 'too_large') {
            unavailable = row.fetch_failure;
          } else if (row.status === 'completed' && row.file_id === null) {
            unavailable = 'not_ready';
          }

          let audio: { url: string; expiresAt: string } | null = null;
          if (row.file_id !== null && options.files !== undefined && options.apiUrl !== undefined) {
            const link = await options.files.link(
              services,
              invocation,
              toPublicId('file', row.file_id),
              {
                seconds: RECORDING_LINK_LIFETIME_SECONDS,
                purpose: 'call_recording',
              },
            );
            audio = {
              url: `${options.apiUrl}${link.path}`,
              expiresAt: link.expiresAt,
            };
          }

          return {
            id: toPublicId('call_recording', row.id),
            kind: row.kind as 'call' | 'voicemail',
            status: row.status as 'completed' | 'in-progress' | 'absent',
            durationSeconds: row.duration_seconds,
            createdAt: row.created_at.toISOString(),
            audio,
            unavailable,
          };
        }),
      );

      return { data };
    },
  } satisfies Route<typeof listCallRecordings>;
  return [list, detail, request, hangUp, grant, readGrant, callingAvailability, recordings];
}
