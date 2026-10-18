// A contact's time zone and do-not-contact flag, as the contact's own endpoints take and
// show them (crm.contacts.timezone and do_not_contact). Sending reads both: with quiet
// hours on, a contact with no time zone gets nothing, and a contact marked do not contact
// gets nothing on any channel.
import { isTimeZone } from '@repo/kernel';
import * as z from 'zod';

import { DO_NOT_CONTACT_REASON_MAX, DO_NOT_CONTACT_REASON_MIN } from './do-not-contact-reason.js';
import { defineEndpoint } from './endpoints.js';

export { DO_NOT_CONTACT_REASON_MAX, DO_NOT_CONTACT_REASON_MIN };

const preferencesRevision = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * The fields a change to a contact may carry besides its names and identities. All are
 * optional, as the rest of a contact change is; refineContactPreferences says which go
 * together.
 */
export const contactPreferenceChanges = {
  timeZone: z
    .string()
    .trim()
    .max(64, { error: 'Use at most 64 characters.' })
    .refine(isTimeZone, { error: "This isn't a time zone, such as Africa/Nairobi." })
    .nullable()
    .optional()
    .meta({
      description:
        'An IANA name the server knows, in any letter case; it is saved in its usual spelling. Null clears it. Offsets such as +03:00 are refused.',
      examples: ['Africa/Nairobi'],
    }),
  doNotContact: z.boolean().optional().meta({
    description: 'True stops every message to the contact, on every channel, whatever the consent.',
  }),
  doNotContactReason: z
    .string()
    .trim()
    .min(DO_NOT_CONTACT_REASON_MIN, {
      error: `Say why, in at least ${String(DO_NOT_CONTACT_REASON_MIN)} characters.`,
    })
    .max(DO_NOT_CONTACT_REASON_MAX, {
      error: `Use at most ${String(DO_NOT_CONTACT_REASON_MAX)} characters.`,
    })
    .optional()
    .meta({
      description:
        'Why do not contact is turned on or off. Required with doNotContact, and kept with the change.',
      examples: ['Asked by phone on 9 October not to be contacted again.'],
    }),
  preferencesRevision: preferencesRevision.optional().meta({
    description:
      "The contact's preferencesRevision as you read it. Required with timeZone or doNotContact; a stale one returns 409.",
  }),
} as const;

/** What refineContactPreferences reads of a contact change. */
export interface ContactPreferenceInput {
  readonly timeZone?: string | null | undefined;
  readonly doNotContact?: boolean | undefined;
  readonly doNotContactReason?: string | undefined;
  readonly preferencesRevision?: string | undefined;
}

/**
 * Which of the fields go together: a change to the time zone or to do not contact names
 * the revision it was based on, and a change to do not contact says why.
 */
export function refineContactPreferences(
  input: ContactPreferenceInput,
  context: z.RefinementCtx,
): void {
  const changesPreferences = input.timeZone !== undefined || input.doNotContact !== undefined;
  if (changesPreferences && input.preferencesRevision === undefined)
    context.addIssue({
      code: 'custom',
      path: ['preferencesRevision'],
      message: "Send the contact's preferencesRevision with this change.",
      params: { code: 'revision_required' },
    });
  if (input.doNotContact !== undefined && input.doNotContactReason === undefined)
    context.addIssue({
      code: 'custom',
      path: ['doNotContactReason'],
      message: `Say why, in at least ${String(DO_NOT_CONTACT_REASON_MIN)} characters.`,
      params: { code: 'reason_required' },
    });
  if (input.doNotContact === undefined && input.doNotContactReason !== undefined)
    context.addIssue({
      code: 'custom',
      path: ['doNotContactReason'],
      message: 'A reason goes with a change to do not contact.',
      params: { code: 'reason_unexpected' },
    });
}

/** The contact change's preference fields on their own, for a caller that sends only these. */
export const contactPreferencesInput = z
  .strictObject(contactPreferenceChanges)
  .superRefine(refineContactPreferences)
  .meta({ id: 'ContactPreferencesInput' });

export type ContactPreferencesInput = z.input<typeof contactPreferencesInput>;

/** What a contact shows of them. */
export const contactPreferences = {
  timeZone: z
    .string()
    .nullable()
    .meta({
      description:
        'Without one, messages to the contact are refused while quiet hours are on. With one, quiet hours follow its local time.',
      examples: ['Africa/Nairobi'],
    }),
  doNotContact: z.boolean().meta({
    description: 'Stops every message to the contact, whatever the consent.',
  }),
  preferencesRevision: preferencesRevision.meta({
    description:
      'Changes when the time zone or do not contact does. Send it back with a change to either.',
  }),
} as const;

export const timeZoneList = z
  .looseObject({
    items: z.array(z.string()).meta({
      description:
        "Every name a contact's timeZone can be, as this server spells them, in order. The list is the database's own, so it can differ between servers.",
      examples: [['Africa/Nairobi', 'America/New_York', 'UTC']],
    }),
  })
  .meta({ id: 'TimeZoneList' });

export type TimeZoneList = z.infer<typeof timeZoneList>;

export const listTimeZones = defineEndpoint({
  operationId: 'listTimeZones',
  method: 'get',
  path: '/time-zones',
  summary: 'List the time zones a contact can have',
  group: 'Contacts',
  response: {
    status: 200,
    description: 'The time zone names this server takes.',
    schema: timeZoneList,
  },
});
