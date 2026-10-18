// Settings → Phone System: how the business wants calls handled, and each
// registered number's name, owner, routing, recording and advanced options. These are
// settings only. The answers say whether calls can be made or taken at all, so nothing
// here reads as a working phone line before the voice transport exists.
import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { listCallingSetups, setUpCalling } from './phone-system-calling.js';

const e164 = z
  .string()
  .regex(/^\+[1-9][0-9]{6,14}$/, {
    error: 'Use the full number with its country code, such as +14155550123.',
  })
  .meta({ examples: ['+14155550123'] });
const revision = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .meta({
    description: 'Names the settings a save is based on; a save over newer settings is refused.',
  });
const member = publicId('membership');
const capability = z.enum(['sms', 'mms', 'voice']);

/** Every reason the business can't make or take calls yet, in the order they apply. */
export const phoneCallingUnavailableCodes = [
  'no_voice_number',
  'calling_not_set_up',
  'calling_setup_pending',
  'calling_setup_failed',
  'calling_setup_unknown',
] as const;

const phoneSystemSettingsFields = z.strictObject({
  defaultNumberId: publicId('phone_number').nullable().meta({
    description: 'The number calls go out from when nothing else chooses one. It must take calls.',
  }),
  inbound: z.strictObject({
    preferAssignedUser: z.boolean().meta({
      description: 'Ring the person a called number is assigned to before anyone else.',
    }),
    allowAnonymousCallers: z.boolean().meta({
      description: 'Let callers who hide their number through.',
    }),
    fallbackNumber: e164.nullable().meta({
      description:
        'Where a number set to fall back forwards a call nobody took. Not one of the business’s own numbers.',
    }),
  }),
  outbound: z.strictObject({
    callerId: z.enum(['account_default', 'user_assigned', 'local_presence']).meta({
      description:
        'The number a call shows when the person calling picks none: the default number, the number assigned to them, or one with the contact’s area code.',
    }),
    connectAgent: z.enum(['before_announcement', 'after_announcement']).meta({
      description: 'Connect the person calling before or after the recording announcement.',
    }),
    quietHoursWarning: z.boolean().meta({
      description: 'Warn before calling a contact during their quiet hours.',
    }),
  }),
  recording: z.strictObject({
    retentionDays: z.number().int().min(1).max(3650).nullable().meta({
      description: 'Recordings older than this are deleted. Null keeps them.',
    }),
    transcriptionEnabled: z.boolean().meta({
      description: 'Transcribe recorded calls. A call is recorded only where its number records.',
    }),
  }),
  missedCallText: z
    .strictObject({
      enabled: z.boolean(),
      message: z.string().trim().min(1).max(640).nullable(),
    })
    .refine((text) => !text.enabled || text.message !== null, {
      path: ['message'],
      error: 'Write the text a caller gets after a missed call.',
      params: { code: 'message_required' },
    })
    .meta({
      description:
        'One text to the caller after a missed call, sent through the same consent and quiet-hours checks as any message.',
    }),
});

export const updatePhoneSystemSettingsInput = phoneSystemSettingsFields
  .extend({ revision })
  .meta({ id: 'UpdatePhoneSystemSettingsInput' });
export type UpdatePhoneSystemSettingsInput = z.output<typeof updatePhoneSystemSettingsInput>;

export const phoneCalling = z
  .strictObject({
    available: z.boolean(),
    unavailable: z
      .strictObject({
        code: z.enum(phoneCallingUnavailableCodes),
        message: z.string().meta({ description: 'In plain words, for people.' }),
      })
      .nullable(),
  })
  .meta({
    id: 'PhoneCalling',
    description:
      'Whether calls can be made or taken now. Settings save either way and apply once they can.',
  });
export type PhoneCalling = z.output<typeof phoneCalling>;

export const phoneSystemSettings = phoneSystemSettingsFields
  .extend({ revision, calling: phoneCalling })
  .meta({ id: 'PhoneSystemSettings' });
export type PhoneSystemSettings = z.output<typeof phoneSystemSettings>;

/** What a number's settings may hold that needs no saving to correct, but should be seen. */
export const phoneNumberWarningCodes = [
  'no_destination',
  'short_ring_timeout',
  'member_left',
  'fallback_not_set',
] as const;

const voiceSettings = z
  .strictObject({
    recording: z
      .strictObject({
        enabled: z.boolean(),
        announcement: z.strictObject({
          enabled: z.boolean(),
          message: z.string().trim().min(1).max(500).nullable(),
        }),
      })
      .refine((recording) => !recording.announcement.enabled || recording.enabled, {
        path: ['announcement', 'enabled'],
        error: 'Turn recording on to play a recording announcement.',
        params: { code: 'recording_required' },
      })
      .refine(
        (recording) => !recording.announcement.enabled || recording.announcement.message !== null,
        {
          path: ['announcement', 'message'],
          error: 'Write the announcement callers hear.',
          params: { code: 'message_required' },
        },
      ),
    routing: z
      .strictObject({
        primaryMemberId: member.nullable().meta({
          description: 'Rung first: someone on this business’s team.',
        }),
        forwardTo: e164.nullable().meta({
          description: 'Second: an outside number. Not one of the business’s own numbers.',
        }),
        useBusinessFallback: z.boolean().meta({
          description: 'Third: the business’s fallback number from the Phone System settings.',
        }),
        ringAlso: z.array(member).max(6).meta({
          description: 'Rung at the same time as the first person: up to six more people.',
        }),
        ringTimeoutSeconds: z.number().int().min(5).max(120).meta({
          description: 'How long a call rings before the next step. 20 seconds or more is advised.',
        }),
        voicemailBackup: z.boolean().meta({
          description: 'Take a voicemail when nobody answers.',
        }),
      })
      .refine((routing) => new Set(routing.ringAlso).size === routing.ringAlso.length, {
        path: ['ringAlso'],
        error: 'Choose each person once.',
        params: { code: 'duplicate_member' },
      })
      .refine(
        (routing) =>
          routing.primaryMemberId === null || !routing.ringAlso.includes(routing.primaryMemberId),
        {
          path: ['ringAlso'],
          error: 'The first person already rings.',
          params: { code: 'duplicate_member' },
        },
      ),
    advanced: z
      .strictObject({
        callConnectConfirmation: z.boolean().meta({
          description: 'Whoever answers presses a key to take the call, so a voicemail can’t.',
        }),
        whisper: z.strictObject({
          enabled: z.boolean(),
          message: z.string().trim().min(1).max(500).nullable(),
        }),
        forwardedCallerId: z.enum(['caller', 'business_number']).meta({
          description: 'What a forwarded call shows: the caller’s number, or this number.',
        }),
        preferContactOwner: z.boolean().meta({
          description: 'Ring the calling contact’s owner before this number’s own routing.',
        }),
      })
      .refine((advanced) => !advanced.whisper.enabled || advanced.whisper.message !== null, {
        path: ['whisper', 'message'],
        error: 'Write the whisper the person answering hears.',
        params: { code: 'message_required' },
      }),
  })
  .meta({ id: 'PhoneNumberVoiceSettings' });
export type PhoneNumberVoiceSettings = z.output<typeof voiceSettings>;

const phoneNumberSettingsFields = z.strictObject({
  name: z.string().trim().min(1).max(120),
  ownerId: member.nullable().meta({
    description: 'The person this number is assigned to, on this business’s team.',
  }),
  voice: voiceSettings.nullable().meta({
    description: 'Call handling. Null exactly when the number can’t take calls.',
  }),
});

export const updatePhoneNumberSettingsInput = phoneNumberSettingsFields
  .extend({ revision })
  .meta({ id: 'UpdatePhoneNumberSettingsInput' });
export type UpdatePhoneNumberSettingsInput = z.output<typeof updatePhoneNumberSettingsInput>;

export const phoneNumberSettings = phoneNumberSettingsFields
  .extend({
    id: publicId('phone_number'),
    e164,
    capabilities: z.array(capability),
    status: z.enum(['active', 'paused', 'failing', 'disconnected']),
    isDefault: z.boolean(),
    revision,
    warnings: z.array(z.enum(phoneNumberWarningCodes)).meta({
      description:
        'no_destination: a call reaches nobody and no voicemail. short_ring_timeout: under 20 seconds. member_left: someone saved here left the team and is no longer rung. fallback_not_set: the business fallback is used but none is set.',
    }),
  })
  .meta({ id: 'PhoneNumberSettings' });
export type PhoneNumberSettings = z.output<typeof phoneNumberSettings>;
export type PhoneNumberWarningCode = (typeof phoneNumberWarningCodes)[number];

export const phoneSystemNumberList = z
  .strictObject({ data: z.array(phoneNumberSettings) })
  .meta({ id: 'PhoneSystemNumberList' });

const numberParams = z.strictObject({ id: publicId('phone_number') });

export const phoneSystemMemberList = z
  .strictObject({
    data: z.array(z.strictObject({ id: member, name: z.string(), email: z.string() })),
    nextCursor: member.nullable(),
  })
  .meta({ id: 'PhoneSystemMemberList' });
export const listPhoneSystemMembers = defineEndpoint({
  operationId: 'listPhoneSystemMembers',
  method: 'get',
  path: '/phone-system/members',
  summary: 'List current business members eligible to own or receive calls.',
  group: 'Phone System',
  query: z.strictObject({
    after: member.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
  }),
  response: {
    status: 200,
    description: 'Selectable members in membership-ID order; disabled users omitted.',
    schema: phoneSystemMemberList,
  },
});

export const getPhoneSystemSettings = defineEndpoint({
  operationId: 'getPhoneSystemSettings',
  method: 'get',
  path: '/phone-system/settings',
  summary: 'Read the business’s calling defaults.',
  group: 'Phone System',
  response: {
    status: 200,
    description: 'The settings, with the defaults when none were saved.',
    schema: phoneSystemSettings,
  },
});
export const updatePhoneSystemSettings = defineEndpoint({
  operationId: 'updatePhoneSystemSettings',
  method: 'put',
  path: '/phone-system/settings',
  summary: 'Set the business’s calling defaults.',
  group: 'Phone System',
  body: updatePhoneSystemSettingsInput,
  response: { status: 200, description: 'The settings as saved.', schema: phoneSystemSettings },
});
export const listPhoneSystemNumbers = defineEndpoint({
  operationId: 'listPhoneSystemNumbers',
  method: 'get',
  path: '/phone-system/numbers',
  summary: 'List the business’s registered numbers with their settings.',
  group: 'Phone System',
  response: {
    status: 200,
    description: 'Every registered number, in the order it was registered.',
    schema: phoneSystemNumberList,
  },
});
export const getPhoneNumberSettings = defineEndpoint({
  operationId: 'getPhoneNumberSettings',
  method: 'get',
  path: '/phone-numbers/{id}/settings',
  summary: 'Read one number’s settings.',
  group: 'Phone System',
  params: numberParams,
  response: { status: 200, description: 'The number’s settings.', schema: phoneNumberSettings },
});
export const updatePhoneNumberSettings = defineEndpoint({
  operationId: 'updatePhoneNumberSettings',
  method: 'put',
  path: '/phone-numbers/{id}/settings',
  summary: 'Set one number’s name, owner, routing, recording and advanced options.',
  group: 'Phone System',
  params: numberParams,
  body: updatePhoneNumberSettingsInput,
  response: {
    status: 200,
    description: 'The number’s settings as saved.',
    schema: phoneNumberSettings,
  },
});

export const phoneSystemEndpoints = [
  listPhoneSystemMembers,
  getPhoneSystemSettings,
  updatePhoneSystemSettings,
  listPhoneSystemNumbers,
  getPhoneNumberSettings,
  updatePhoneNumberSettings,
  listCallingSetups,
  setUpCalling,
] as const;
