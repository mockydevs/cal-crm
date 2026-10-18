// A person's browser calling token. The browser asks for one, then reads the answer: only the
// worker can sign a token, so the first answer is the request, and a read shortly after holds
// the token. Only the person who asked can read it, and only until it expires.
import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

export const voiceGrantStatuses = ['requested', 'issued', 'failed'] as const;
export const voiceGrantFailureCodes = [
  'expired',
  'member_unavailable',
  'not_set_up',
  'key_unreadable',
] as const;
export type VoiceGrantFailureCode = (typeof voiceGrantFailureCodes)[number];

export const voiceGrant = z
  .strictObject({
    id: publicId('voice_grant'),
    status: z.enum(voiceGrantStatuses).meta({
      description:
        'requested: the worker is signing it. issued: the token is ready, until it expires. failed: see failure.',
    }),
    token: z.string().min(1).nullable().meta({
      description: 'The access token for the browser; null until issued, and once it has expired.',
    }),
    expiresAt: timestamp.nullable().meta({ description: 'When the token stops working.' }),
    failure: z
      .strictObject({
        code: z.enum(voiceGrantFailureCodes),
        message: z.string().meta({ description: 'In plain words, for people.' }),
      })
      .nullable(),
  })
  .meta({ id: 'VoiceGrant' });
export type VoiceGrant = z.output<typeof voiceGrant>;

export const requestVoiceGrant = defineEndpoint({
  operationId: 'requestVoiceGrant',
  method: 'post',
  path: '/voice-grants',
  summary: 'Ask for a browser calling token for the signed-in person.',
  group: 'Calls',
  response: {
    status: 201,
    description: 'The request; read it again shortly for the token.',
    schema: voiceGrant,
  },
});
export const getVoiceGrant = defineEndpoint({
  operationId: 'getVoiceGrant',
  method: 'get',
  path: '/voice-grants/{id}',
  summary: 'Read a browser calling token request, and its token once it is signed.',
  group: 'Calls',
  params: z.strictObject({ id: publicId('voice_grant') }),
  response: {
    status: 200,
    description: 'The request, with its token once the worker has signed it.',
    schema: voiceGrant,
  },
});
