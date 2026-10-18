// What a contact is beside a name and addresses: a date of birth, where the contact says
// they came from, and whether they are a lead or a customer.
import * as z from 'zod';

/** The types a contact can be. GoHighLevel's API has `type` as free text; these two are its defaults. */
export const contactTypes = ['lead', 'customer'] as const;
export type ContactType = (typeof contactTypes)[number];

/** A calendar day, as YYYY-MM-DD. */
export const calendarDate = z.iso.date().meta({ examples: ['1990-04-23'] });

export const contactAttributeLimits = { source: 200 } as const;

export const contactSourceText = z
  .string()
  .trim()
  .min(1, { error: 'Enter a source, or leave it empty.' })
  .max(contactAttributeLimits.source, { error: 'Use at most 200 characters.' })
  .meta({ examples: ['Trade fair 2026'] });

/**
 * What a phone number can be labelled as: GoHighLevel's four. A label says what the number
 * is for and changes nothing else. A contact uses each label once, and an email address has
 * none.
 */
export const contactPhoneLabels = ['home', 'work', 'mobile', 'landline'] as const;
export type ContactPhoneLabel = (typeof contactPhoneLabels)[number];

/**
 * The channels do not disturb can be turned on for, one at a time: the outbound pipeline's
 * own names. Email, text messages, calls and web chat replies obey it; WhatsApp is kept for
 * when it sends.
 */
export const dndChannels = ['call', 'email', 'sms', 'webchat', 'whatsapp'] as const;
export type DndChannel = (typeof dndChannels)[number];

/**
 * The channels a person can turn do not disturb on for, in GoHighLevel's order: the ones
 * whose sends it stops today. WhatsApp sends nothing yet, so it is not offered.
 */
export const offeredDndChannels = [
  'email',
  'sms',
  'call',
  'webchat',
] as const satisfies readonly DndChannel[];
export type OfferedDndChannel = (typeof offeredDndChannels)[number];
