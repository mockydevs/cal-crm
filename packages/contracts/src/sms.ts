// SMS through a provider account the business already has (Twilio). Formats marked "spec"
// are Twilio's own, from its OpenAPI file (twilio-oai, twilio_api_v2010.json).
import * as z from 'zod';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

// spec: the AccountSid path parameter.
const accountSid = z.string().regex(/^AC[0-9a-fA-F]{32}$/, { error: 'Not a Twilio Account SID.' });
// spec: the sid of a Key.
const apiKeySid = z.string().regex(/^SK[0-9a-fA-F]{32}$/, { error: 'Not a Twilio API key SID.' });
// Twilio publishes no format for its secrets: anything printable, without spaces.
const secret = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}\s]+$/u)
  .meta({ writeOnly: true });
const e164 = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
const capability = z.enum(['sms', 'mms', 'voice']);

export const connectSmsInput = z
  .strictObject({
    provider: z.literal('twilio'),
    label: z.string().trim().min(1).max(80),
    accountSid,
    /** Always needed: it is the only key that verifies Twilio's webhooks. */
    authToken: secret,
    /** Optional: used for sending and reading instead of the Auth Token. */
    apiKey: z.strictObject({ sid: apiKeySid, secret }).optional(),
  })
  .meta({ id: 'ConnectSmsInput' });
export type ConnectSmsInput = z.output<typeof connectSmsInput>;

export const smsConnectionResult = z
  .strictObject({
    accountType: z.enum(['trial', 'full']),
    accountStatus: z.enum(['active', 'suspended', 'closed']),
    subaccount: z.boolean(),
    numbersFound: z.number().int().min(0),
  })
  .meta({ id: 'SmsConnectionResult' });
export type SmsConnectionResult = z.output<typeof smsConnectionResult>;

const attemptCommon = { id: publicId('sms_attempt'), createdAt: timestamp };
export const smsConnectionAttempt = z
  .discriminatedUnion('status', [
    z.strictObject({
      ...attemptCommon,
      status: z.literal('pending'),
      connectionId: z.null(),
      result: z.null(),
    }),
    z.strictObject({
      ...attemptCommon,
      status: z.literal('connected'),
      connectionId: publicId('sms_connection'),
      result: smsConnectionResult,
    }),
    z.strictObject({
      ...attemptCommon,
      status: z.literal('failed'),
      connectionId: z.null(),
      failure: z.enum([
        'authentication',
        'account_inactive',
        'provider_unavailable',
        'already_connected',
        'expired',
        'credentials_unreadable',
      ]),
      result: z.null(),
    }),
  ])
  .meta({ id: 'SmsConnectionAttempt' });
export type SmsConnectionAttempt = z.output<typeof smsConnectionAttempt>;

/**
 * What connecting answers: the attempt, and the address to give Twilio for inbound
 * messages. The address is shown this once; it can't be read back later.
 */
export const smsConnectionStarted = z
  .strictObject({
    attempt: smsConnectionAttempt,
    inboundWebhookUrl: z.url().nullable(),
  })
  .meta({ id: 'SmsConnectionStarted' });
export type SmsConnectionStarted = z.output<typeof smsConnectionStarted>;

export const smsConnection = z
  .strictObject({
    id: publicId('sms_connection'),
    provider: z.literal('twilio'),
    label: z.string(),
    /** Not a secret. */
    accountSid,
    status: z.enum(['connected', 'failing', 'disconnected']),
    accountType: z.enum(['trial', 'full']).nullable(),
    accountStatus: z.enum(['active', 'suspended', 'closed']).nullable(),
    warnings: z.array(z.enum(['trial_account', 'account_not_active'])),
    lastCheckedAt: timestamp.nullable(),
    createdAt: timestamp,
  })
  .meta({ id: 'SmsConnection' });
export type SmsConnection = z.output<typeof smsConnection>;
/** Every reason an install can give for not sending or receiving text messages at all. */
export const smsUnavailableCodes = ['public_address_unsuitable'] as const;
export type SmsUnavailableCode = (typeof smsUnavailableCodes)[number];
export const smsConnectionList = z
  .strictObject({
    data: z.array(smsConnection),
    unavailable: z
      .strictObject({
        code: z.enum(smsUnavailableCodes),
        message: z.string().meta({ description: 'In plain words, for people.' }),
      })
      .nullable()
      .meta({
        description:
          'Why this install can send and receive no text message at all, whatever is connected: the provider reports deliveries and incoming messages to the public address of the install, which must be https. Null when it can.',
      }),
  })
  .meta({ id: 'SmsConnectionList' });

/** A number the provider account owns, as last read from the provider. */
export const smsProviderNumber = z
  .strictObject({
    // spec: the sid of an IncomingPhoneNumber.
    providerNumberRef: z.string().regex(/^PN[0-9a-fA-F]{32}$/),
    e164,
    friendlyName: z.string(),
    capabilities: z.array(capability),
    /** The phone number it is registered as in this business, if it is. */
    registeredAs: publicId('phone_number').nullable(),
    seenAt: timestamp,
  })
  .meta({ id: 'SmsProviderNumber' });
export type SmsProviderNumber = z.output<typeof smsProviderNumber>;
export const smsProviderNumberList = z
  .strictObject({ data: z.array(smsProviderNumber) })
  .meta({ id: 'SmsProviderNumberList' });

export const registerPhoneNumberInput = z
  .strictObject({
    connectionId: publicId('sms_connection'),
    /** One of the connection's listed numbers; a number is never typed in. */
    providerNumberRef: z.string().regex(/^PN[0-9a-fA-F]{32}$/),
    name: z.string().trim().min(1).max(120),
  })
  .meta({ id: 'RegisterPhoneNumberInput' });
export type RegisterPhoneNumberInput = z.output<typeof registerPhoneNumberInput>;

export const phoneNumber = z
  .strictObject({
    id: publicId('phone_number'),
    name: z.string(),
    e164,
    connectionId: publicId('sms_connection'),
    capabilities: z.array(capability),
    status: z.enum(['active', 'paused', 'failing', 'disconnected']),
    createdAt: timestamp,
  })
  .meta({ id: 'PhoneNumber' });
export type PhoneNumber = z.output<typeof phoneNumber>;
export const phoneNumberList = z
  .strictObject({ data: z.array(phoneNumber) })
  .meta({ id: 'PhoneNumberList' });

export const connectSms = defineEndpoint({
  operationId: 'connectSms',
  method: 'post',
  path: '/sms-connection-attempts',
  summary: 'Check Twilio credentials and connect the account if they work.',
  group: 'SMS',
  body: connectSmsInput,
  response: {
    status: 201,
    description: 'The connection attempt was queued; poll its status.',
    schema: smsConnectionStarted,
  },
});
export const getSmsConnectionAttempt = defineEndpoint({
  operationId: 'getSmsConnectionAttempt',
  method: 'get',
  path: '/sms-connection-attempts/{id}',
  summary: 'Read the status of an SMS connection attempt.',
  group: 'SMS',
  params: z.strictObject({ id: publicId('sms_attempt') }),
  response: { status: 200, description: 'The connection attempt.', schema: smsConnectionAttempt },
});
export const listSmsConnections = defineEndpoint({
  operationId: 'listSmsConnections',
  method: 'get',
  path: '/sms-connections',
  summary: 'List the business’s SMS provider connections.',
  group: 'SMS',
  response: {
    status: 200,
    description: 'The connections, without credentials.',
    schema: smsConnectionList,
  },
});
export const listSmsProviderNumbers = defineEndpoint({
  operationId: 'listSmsProviderNumbers',
  method: 'get',
  path: '/sms-connections/{id}/numbers',
  summary: 'List the numbers the provider account owns, as last read.',
  group: 'SMS',
  params: z.strictObject({ id: publicId('sms_connection') }),
  response: {
    status: 200,
    description: 'The account’s numbers and which are registered.',
    schema: smsProviderNumberList,
  },
});
export const refreshSmsProviderNumbers = defineEndpoint({
  operationId: 'refreshSmsProviderNumbers',
  method: 'post',
  path: '/sms-connections/{id}/number-refreshes',
  summary: 'Read the provider account’s numbers again.',
  group: 'SMS',
  params: z.strictObject({ id: publicId('sms_connection') }),
  response: { status: 204, description: 'The read was queued.' },
});
export const registerPhoneNumber = defineEndpoint({
  operationId: 'registerPhoneNumber',
  method: 'post',
  path: '/phone-numbers',
  summary: 'Register one of the provider account’s numbers for sending and receiving SMS.',
  group: 'SMS',
  body: registerPhoneNumberInput,
  response: { status: 201, description: 'The registered number.', schema: phoneNumber },
});
export const listPhoneNumbers = defineEndpoint({
  operationId: 'listPhoneNumbers',
  method: 'get',
  path: '/phone-numbers',
  summary: 'List the business’s registered phone numbers.',
  group: 'SMS',
  response: { status: 200, description: 'The registered numbers.', schema: phoneNumberList },
});
