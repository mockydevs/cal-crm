// Setting up browser calling on each connected Twilio account: the worker creates the API
// key that signs a person's calling token. Setting up is not calling; whether calls can be
// made is `PhoneCalling`, which also says when setup is what is missing.
import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const callingSetupStatuses = [
  'requested',
  'creating',
  'ready',
  'failed',
  'unknown',
] as const;
export type CallingSetupStatus = (typeof callingSetupStatuses)[number];
export const callingSetupFailureCodes = [
  'credentials_unreadable',
  'connection_unavailable',
  'provider_rejected',
] as const;

export const callingSetup = z
  .strictObject({
    connectionId: publicId('sms_connection'),
    label: z.string(),
    connectionStatus: z.enum(['connected', 'failing', 'disconnected']),
    voiceNumbers: z.number().int().min(0).meta({
      description: 'Registered numbers on this account that can take calls.',
    }),
    setup: z
      .strictObject({
        status: z.enum(callingSetupStatuses).meta({
          description:
            'requested and creating: in progress. ready: done. failed: nothing was created; set up again. unknown: Twilio may have created a key whose answer was lost; check before setting up again.',
        }),
        failure: z
          .strictObject({
            code: z.enum(callingSetupFailureCodes),
            providerErrorCode: z.number().int().nullable(),
            message: z.string().meta({ description: 'In plain words, for people.' }),
          })
          .nullable(),
        requestedAt: timestamp,
        finishedAt: timestamp.nullable(),
      })
      .nullable()
      .meta({ description: 'Null when calling was never set up on this account.' }),
    canSetUp: z.boolean().meta({
      description:
        'Whether asking now would start setting it up: connected, and not ready or in progress.',
    }),
  })
  .meta({ id: 'CallingSetup' });
export type CallingSetup = z.output<typeof callingSetup>;

export const callingSetupList = z
  .strictObject({ data: z.array(callingSetup) })
  .meta({ id: 'CallingSetupList' });
export type CallingSetupList = z.output<typeof callingSetupList>;

export const listCallingSetups = defineEndpoint({
  operationId: 'listCallingSetups',
  method: 'get',
  path: '/phone-system/calling-setups',
  summary: 'List the connected Twilio accounts and whether calling is set up on each.',
  group: 'Phone System',
  response: {
    status: 200,
    description: 'Every Twilio account of the business, in the order it was connected.',
    schema: callingSetupList,
  },
});
export const setUpCalling = defineEndpoint({
  operationId: 'setUpCalling',
  method: 'post',
  path: '/sms-connections/{id}/calling-setup',
  summary: 'Set up browser calling on a connected Twilio account.',
  group: 'Phone System',
  params: z.strictObject({ id: publicId('sms_connection') }),
  response: {
    status: 201,
    description: 'Setting up was queued, or is already under way; read it again for its result.',
    schema: callingSetup,
  },
});
