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
  listCalls,
  parseInput,
  requestCall,
  requestVoiceGrant,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import { listCallRecords, readCallDetail } from './call-records.js';
import {
  createRequestCallCommand,
  hangUpCallCommand,
  type CallingAvailability,
} from './call-requests.js';
import { readVoiceGrant, requestVoiceGrantCommand } from './voice-grants.js';

/**
 * Calls. Reading needs calls.read; asking for and ending calls need calls.place.
 * `availability` is Phone System's readPhoneCalling: until it says calls can be made, a
 * request is refused rather than stored to wait.
 */
export function createCallRoutes(availability: CallingAvailability): readonly ApiRoute[] {
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
  return [list, detail, request, hangUp, grant, readGrant, callingAvailability];
}
