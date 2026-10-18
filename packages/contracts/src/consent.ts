// Consent and quiet hours. Consent is an append-only ledger per contact, channel and
// purpose, and its latest row is the current state. A change is a new row with proof;
// nothing here edits or deletes one.
import * as z from 'zod';
import { actor } from './activity.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';

/** As messaging.consents allows them (consents_channel_valid and the like). */
export const consentChannels = ['email', 'sms', 'whatsapp', 'call'] as const;
export const consentPurposes = ['marketing', 'transactional'] as const;
export const consentStatuses = ['granted', 'withdrawn'] as const;
export const consentSources = [
  'form',
  'keyword',
  'unsubscribe_link',
  'booking',
  'import',
  'api',
  'user',
] as const;

export type ConsentChannel = (typeof consentChannels)[number];
export type ConsentPurpose = (typeof consentPurposes)[number];
export type ConsentStatus = (typeof consentStatuses)[number];
export type ConsentSource = (typeof consentSources)[number];

/** The shortest note that can say how consent was obtained. */
export const CONSENT_NOTE_MIN = 10;
export const CONSENT_NOTE_MAX = 1000;
/** How many ledger rows a contact's consent read returns, newest first. */
export const CONSENT_HISTORY_LIMIT = 100;

export const recordConsentInput = z
  .strictObject({
    channel: z.enum(consentChannels),
    purpose: z.enum(consentPurposes),
    status: z.enum(consentStatuses),
    note: z
      .string()
      .trim()
      .min(CONSENT_NOTE_MIN, {
        error: `Say how you know, in at least ${String(CONSENT_NOTE_MIN)} characters.`,
      })
      .max(CONSENT_NOTE_MAX, {
        error: `Use at most ${String(CONSENT_NOTE_MAX)} characters.`,
      })
      .meta({
        description:
          'How the consent or the withdrawal was obtained. It is kept as proof with the change.',
        examples: ['Asked by phone on 9 October to get the monthly newsletter.'],
      }),
    replacesWithdrawal: z.boolean().default(false).meta({
      description:
        'Required to grant consent that is currently withdrawn, so a withdrawal is never undone by accident.',
    }),
  })
  .meta({ id: 'RecordConsentInput' });
export type RecordConsentInput = z.input<typeof recordConsentInput>;

export const consentState = z
  .looseObject({
    channel: z.enum(consentChannels),
    purpose: z.enum(consentPurposes),
    status: z.enum([...consentStatuses, 'unknown']).meta({
      description: 'Unknown when nothing was ever recorded. Sending needs granted.',
    }),
    source: z.enum(consentSources).nullable(),
    recordedAt: timestamp.nullable(),
  })
  .meta({ id: 'ConsentState' });
export type ConsentState = z.output<typeof consentState>;

export const consentProof = z
  .looseObject({
    note: z.string().nullable().meta({ description: 'What the person who recorded it wrote.' }),
    wording: z.string().nullable().meta({ description: 'The words the contact agreed to.' }),
    keyword: z.string().nullable().meta({ description: 'The keyword the contact sent.' }),
    ipAddress: z.string().nullable(),
    pageUrl: z.string().nullable(),
    linked: z.enum(['message', 'appointment', 'form']).nullable().meta({
      description: 'The kind of record the change came from, when one is kept with it.',
    }),
  })
  .meta({ id: 'ConsentProof' });
export type ConsentProof = z.output<typeof consentProof>;

export const consentChange = z
  .looseObject({
    channel: z.enum(consentChannels),
    purpose: z.enum(consentPurposes),
    status: z.enum(consentStatuses),
    source: z.enum(consentSources),
    recordedAt: timestamp,
    recordedBy: actor,
    proof: consentProof,
  })
  .meta({ id: 'ConsentChange' });
export type ConsentChange = z.output<typeof consentChange>;

export const suppressionReasons = [
  'hard_bounce',
  'complaint',
  'unsubscribe',
  'invalid',
  'manual',
] as const;

export const contactSuppression = z
  .looseObject({
    channel: z.enum(['email', 'sms']),
    address: z.string(),
    reason: z.enum(suppressionReasons),
    since: timestamp,
    until: timestamp.nullable(),
  })
  .meta({ id: 'ContactSuppression' });
export type ContactSuppression = z.output<typeof contactSuppression>;

export const contactConsent = z
  .looseObject({
    canManage: z.boolean().meta({ description: 'Whether you may record a change.' }),
    doNotContact: z.boolean().meta({ description: 'Stops every message, whatever the consent.' }),
    timeZone: z.string().nullable().meta({
      description:
        "The contact's time zone. Without one, messages are refused while quiet hours are on.",
    }),
    current: z.array(consentState).meta({ description: 'One entry for each channel and purpose.' }),
    suppressions: z.array(contactSuppression).meta({
      description: "Addresses of this contact that can't be sent to, such as after a hard bounce.",
    }),
    history: z.array(consentChange).meta({ description: 'Newest first.' }),
    historyTruncated: z.boolean(),
  })
  .meta({ id: 'ContactConsent' });
export type ContactConsent = z.output<typeof contactConsent>;

const contactParams = z.strictObject({ id: publicId('contact') });

export const getContactConsent = defineEndpoint({
  operationId: 'getContactConsent',
  method: 'get',
  path: '/contacts/{id}/consent',
  summary: "Read a contact's consent, with its proof and history",
  group: 'Consent',
  params: contactParams,
  response: {
    status: 200,
    description:
      'The current consent for each channel and purpose, as sending checks it, and every change behind it.',
    schema: contactConsent,
  },
});

export const recordContactConsent = defineEndpoint({
  operationId: 'recordContactConsent',
  method: 'post',
  path: '/contacts/{id}/consent',
  summary: 'Record that a contact gave or withdrew consent, with proof',
  group: 'Consent',
  params: contactParams,
  body: recordConsentInput,
  response: {
    status: 201,
    description: 'The consent after the change. The change is a new entry; none is edited.',
    schema: contactConsent,
  },
});

const clockTime = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, { error: 'Use a 24-hour time, such as 21:00.' })
  .meta({ examples: ['21:00'] });
const settingsRevision = z.string().regex(/^[0-9a-f]{64}$/);

const messagingSettingsFields = z.strictObject({
  quietHoursEnabled: z.boolean(),
  quietHoursStart: clockTime,
  quietHoursEnd: clockTime,
  contactDailyLimit: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .meta({ description: 'Messages one contact may get in any 24 hours, across channels.' }),
});

export const updateMessagingSettingsInput = messagingSettingsFields
  .extend({ revision: settingsRevision })
  // The same start and end would hold every message all day, which reads as a mistake
  // rather than a choice: turning quiet hours off is the way to send at any time.
  .refine((input) => !input.quietHoursEnabled || input.quietHoursStart !== input.quietHoursEnd, {
    path: ['quietHoursEnd'],
    error: "Quiet hours can't start and end at the same time.",
    params: { code: 'empty_window' },
  })
  .meta({ id: 'UpdateMessagingSettingsInput' });
export type UpdateMessagingSettingsInput = z.output<typeof updateMessagingSettingsInput>;

export const messagingSettings = z
  .looseObject({
    ...messagingSettingsFields.shape,
    revision: settingsRevision,
    canManage: z.boolean(),
    heldMessages: z.number().int().min(0).meta({
      description: 'Messages waiting for quiet hours to end.',
    }),
    contactsWithoutTimeZone: z.number().int().min(0).meta({
      description:
        "Contacts with no region time zone of their own (none, or an abbreviation such as EST): their workflow and campaign messages keep quiet hours by the business's time zone.",
    }),
  })
  .meta({ id: 'MessagingSettings' });
export type MessagingSettings = z.output<typeof messagingSettings>;

export const getMessagingSettings = defineEndpoint({
  operationId: 'getMessagingSettings',
  method: 'get',
  path: '/messaging-settings',
  summary: "Read the business's quiet hours and per-contact daily limit",
  group: 'Consent',
  response: {
    status: 200,
    description: 'The settings sending checks, with the defaults when none were saved.',
    schema: messagingSettings,
  },
});

export const updateMessagingSettings = defineEndpoint({
  operationId: 'updateMessagingSettings',
  method: 'put',
  path: '/messaging-settings',
  summary: 'Set quiet hours and the per-contact daily limit',
  group: 'Consent',
  body: updateMessagingSettingsInput,
  response: {
    status: 200,
    description: 'The saved settings. They apply from the next send check.',
    schema: messagingSettings,
  },
});
