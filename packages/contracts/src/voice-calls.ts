// Calls: the business's call records and the requests to place or
// end one. A request answers a call in state "requested"; nothing reads as a connected call
// until the provider reports that the other party answered. Placing and ending are the
// worker's, through the provider, after the call is reserved.
import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { phoneCalling } from './phone-system.js';
import { getVoiceGrant, requestVoiceGrant } from './voice-grants.js';

const e164 = z
  .string()
  .regex(/^\+[1-9][0-9]{6,14}$/)
  .meta({ examples: ['+14155550123'] });
const timestamp = z.iso.datetime({ offset: true });

/**
 * Where a call is. requested: accepted, nothing sent. reserved: the provider is being asked.
 * unknown: the provider's answer was lost, so it may or may not ring; it is never placed
 * again by itself. dialing/ringing: the provider has it. connected: the other party
 * answered. ended has an outcome. refused, rejected and canceled ended before any ringing.
 */
export const callStates = [
  'requested',
  'reserved',
  'unknown',
  'dialing',
  'ringing',
  'connected',
  'ended',
  'refused',
  'rejected',
  'canceled',
] as const;
export type CallState = (typeof callStates)[number];
export const callOutcomes = ['completed', 'busy', 'no_answer', 'failed', 'canceled'] as const;
export type CallOutcome = (typeof callOutcomes)[number];

/** Why a call was refused before it was placed, or rejected by the provider. */
export const callFailureCodes = [
  'contact_unavailable',
  'do_not_call',
  'call_consent_withdrawn',
  'number_unavailable',
  'connection_unavailable',
  'member_unavailable',
  'provider_rejected',
] as const;
export type CallFailureCode = (typeof callFailureCodes)[number];

/** Why a request is refused at once (422), with nothing stored. */
export const callRequestRefusalCodes = [
  'calling_unavailable',
  'user_required',
  'number_required',
  ...callFailureCodes.filter((code) => code !== 'provider_rejected'),
] as const;
export type CallRequestRefusalCode = (typeof callRequestRefusalCodes)[number];

/** A leg's status: ours (reserved, unknown, rejected), then the provider's own words. */
export const callLegStatuses = [
  'reserved',
  'unknown',
  'rejected',
  'queued',
  'initiated',
  'ringing',
  'in-progress',
  'completed',
  'busy',
  'failed',
  'no-answer',
  'canceled',
] as const;
export type CallLegStatus = (typeof callLegStatuses)[number];

export const callLeg = z
  .strictObject({
    id: publicId('call_leg'),
    parentId: publicId('call_leg').nullable(),
    party: z.enum(['remote', 'member']).meta({
      description: 'Who the leg reaches: the other party, or a member of the business.',
    }),
    membershipId: publicId('membership').nullable().meta({
      description: 'The member a member leg reaches, while they are on the team.',
    }),
    status: z.enum(callLegStatuses),
    providerDirection: z.enum(['inbound', 'outbound-api', 'outbound-dial']).nullable(),
    providerCallId: z
      .string()
      .regex(/^CA[0-9a-fA-F]{32}$/)
      .nullable()
      .meta({ description: 'The provider’s id for this leg, once it is known.' }),
    durationSeconds: z.int().min(0).nullable(),
    conflict: z.boolean().meta({
      description: 'A progress report contradicted an earlier one; check the provider.',
    }),
    answeredAt: timestamp.nullable(),
    endedAt: timestamp.nullable(),
  })
  .meta({ id: 'CallLeg' });
export type CallLeg = z.output<typeof callLeg>;

export const call = z
  .strictObject({
    id: publicId('call'),
    direction: z.enum(['outbound', 'inbound']),
    state: z.enum(callStates),
    outcome: z.enum(callOutcomes).nullable().meta({ description: 'Set once state is ended.' }),
    failure: z.enum(callFailureCodes).nullable().meta({
      description: 'Why a refused or rejected call never rang.',
    }),
    phoneNumberId: publicId('phone_number').nullable().meta({
      description: 'The business’s number, while it stays registered.',
    }),
    localNumber: e164,
    remoteNumber: e164.nullable().meta({ description: 'Null for a caller who hid their number.' }),
    contactId: publicId('contact').nullable(),
    contactIdentityId: publicId('contact_identity').nullable(),
    membershipId: publicId('membership').nullable().meta({
      description:
        'The member on the business’s side, while they are on the team: who asked for an outbound call, or who took an inbound one.',
    }),
    needsReconciliation: z.boolean().meta({
      description: 'The provider’s reports disagree with this record; check the provider.',
    }),
    hangUpRequested: z.boolean(),
    createdAt: timestamp,
    connectedAt: timestamp.nullable(),
    endedAt: timestamp.nullable(),
  })
  .meta({ id: 'Call' });
export type Call = z.output<typeof call>;

export const callDetail = call
  .extend({ legs: z.array(callLeg).max(100) })
  .meta({ id: 'CallDetail' });
export type CallDetail = z.output<typeof callDetail>;

export const callList = z
  .strictObject({
    items: z.array(call).max(50),
    nextCursor: publicId('call').nullable(),
  })
  .meta({ id: 'CallList' });
export type CallList = z.output<typeof callList>;

export const listCallsQuery = z.strictObject({
  after: publicId('call').optional().meta({ description: 'The `nextCursor` of the page before.' }),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  contactId: publicId('contact').optional(),
  direction: z.enum(['outbound', 'inbound']).optional(),
});
export type ListCallsQuery = z.input<typeof listCallsQuery>;

export const requestCallInput = z
  .strictObject({
    contactIdentityId: publicId('contact_identity').meta({
      description: 'The contact’s phone number to call.',
    }),
    phoneNumberId: publicId('phone_number').nullable().default(null).meta({
      description: 'The business’s number to call from. Null uses the Phone System default number.',
    }),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,64}$/)
      .meta({
        description:
          'Made once for each press of Call, and sent again unchanged on a retry, so a retry never places a second call.',
      }),
  })
  .meta({ id: 'RequestCallInput' });
export type RequestCallInput = z.input<typeof requestCallInput>;

const callParams = z.strictObject({ id: publicId('call') });

export const listCalls = defineEndpoint({
  operationId: 'listCalls',
  method: 'get',
  path: '/calls',
  summary: 'List the business’s calls, newest first.',
  group: 'Calls',
  query: listCallsQuery,
  response: { status: 200, description: 'A page of calls.', schema: callList },
});
export const getCall = defineEndpoint({
  operationId: 'getCall',
  method: 'get',
  path: '/calls/{id}',
  summary: 'Read one call with its legs.',
  group: 'Calls',
  params: callParams,
  response: { status: 200, description: 'The call and its legs.', schema: callDetail },
});
export const requestCall = defineEndpoint({
  operationId: 'requestCall',
  method: 'post',
  path: '/calls',
  summary: 'Ask for an outbound call to a contact.',
  group: 'Calls',
  body: requestCallInput,
  response: {
    status: 201,
    description:
      'The call, requested and not yet placed. Sending the same idempotencyKey again answers the same call.',
    schema: call,
  },
});
export const hangUpCall = defineEndpoint({
  operationId: 'hangUpCall',
  method: 'post',
  path: '/calls/{id}/hang-up',
  summary: 'End a call, or cancel it before it is placed.',
  group: 'Calls',
  params: callParams,
  response: {
    status: 200,
    description:
      'The call. One not yet placed is canceled; otherwise the hang-up is asked of the provider and the call ends when it reports so.',
    schema: call,
  },
});

export const getCallingAvailability = defineEndpoint({
  operationId: 'getCallingAvailability',
  method: 'get',
  path: '/calls/availability',
  summary: 'Whether calls can be made from this business now.',
  group: 'Calls',
  response: {
    status: 200,
    description: 'Whether calls can be made from this business now.',
    schema: phoneCalling,
  },
});

export const voiceCallEndpoints = [
  listCalls,
  getCall,
  requestCall,
  hangUpCall,
  requestVoiceGrant,
  getVoiceGrant,
  getCallingAvailability,
] as const;
