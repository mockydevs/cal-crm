import { requireBusiness, type CommandContext } from '@repo/commands';
import { BOOKING_WORDING_LENGTH, parseInput } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { countryOf, normalizePhone } from '@repo/module-crm';
import { NotFoundError } from '@repo/kernel';
import { sql } from 'kysely';
import { isIP } from 'node:net';
import * as z from 'zod';

import { recordConsent } from './consent-record.js';
import {
  addressConsentStatus,
  lockAddressConsent,
  lockContactConsent,
  type CurrentConsent,
} from './consent-state.js';

const consentInput = z.strictObject({
  contactId: z.uuid(),
  appointmentId: z.uuid(),
  notificationConsent: z.literal(true),
  ipAddress: z
    .string()
    .max(45)
    .refine((value) => isIP(value) !== 0),
  /** The wording of the box the visitor ticked: the calendar's own, or the standard one. */
  wording: z.string().trim().min(1).max(BOOKING_WORDING_LENGTH),
});

export interface BookingNotificationConsentInput {
  readonly contactId: string;
  readonly appointmentId: string;
  readonly notificationConsent: true;
  readonly ipAddress: string;
  readonly wording: string;
}

export async function recordBookingNotificationConsent(
  trx: DatabaseTransaction,
  input: BookingNotificationConsentInput,
  command: CommandContext,
): Promise<void> {
  const { contactId, appointmentId, ipAddress, wording } = parseInput(consentInput, input);
  const businessId = requireBusiness(command.context);
  // Only the scoped booking command supplies the contact/appointment it resolved and
  // server-observed IP. No public command accepts arbitrary contact IDs or proof text.
  const contact = await trx
    .selectFrom('crm.contacts')
    .select(['id', 'deleted_at'])
    .where('business_id', '=', businessId)
    .where('id', '=', contactId)
    .forUpdate()
    .executeTakeFirst();
  if (contact?.deleted_at !== null) throw new NotFoundError('Booking contact', 'unavailable');
  await trx
    .insertInto('messaging.consents')
    .values({
      business_id: businessId,
      contact_id: contactId,
      channel: 'email',
      purpose: 'transactional',
      status: 'granted',
      source: 'booking',
      proof: sql`${JSON.stringify({ appointmentId, wording, ipAddress, recordedAt: new Date().toISOString() })}::jsonb`,
      recorded_by_kind: 'contact',
      recorded_by_id: contactId,
    })
    .execute();
  await command.emit({
    type: 'consent.granted',
    subject: { kind: 'contact', id: contactId },
    records: [contactId],
    payload: { channel: 'email', purpose: 'transactional', source: 'booking' },
  });
}

const textConsentInput = z.strictObject({
  contactId: z.uuid(),
  appointmentId: z.uuid(),
  /** The number the visitor typed on the booking page, as they typed it. */
  phone: z.string().trim().min(1).max(40),
  ipAddress: consentInput.shape.ipAddress,
  /** The words beside the box, as the server renders them (bookingTextWording). */
  wording: z.string().trim().min(1).max(BOOKING_WORDING_LENGTH),
});

export interface BookingTextConsentInput {
  readonly contactId: string;
  readonly appointmentId: string;
  readonly phone: string;
  readonly ipAddress: string;
  readonly wording: string;
}

/**
 * "Text me reminders" ticked on a booking page: transactional consent for text messages to
 * the number the visitor gave, with the box's words, the appointment and the address the
 * booking came from as the proof. Only for that number, and only if the contact holds it. A
 * number that sent STOP stays opted out: the box is not a way round a STOP, and the
 * provider would refuse the text anyway until START (CTIA Messaging Principles 5.1.3).
 * Returns what came of it; nothing is refused.
 */
export async function recordBookingTextConsent(
  trx: DatabaseTransaction,
  input: BookingTextConsentInput,
  command: CommandContext,
): Promise<'granted' | 'no_address' | 'withdrawn_kept'> {
  const { contactId, appointmentId, phone, ipAddress, wording } = parseInput(
    textConsentInput,
    input,
  );
  const businessId = requireBusiness(command.context);
  // As the contact's identities hold it: E.164, read in the business's country as the
  // booking's intake read it.
  const normalized = normalizePhone(phone, await countryOf(trx, businessId));
  if (typeof normalized !== 'string') return 'no_address';
  const held = await trx
    .selectFrom('crm.contact_identities')
    .select('value_normalized')
    .where('contact_id', '=', contactId)
    .where('kind', '=', 'phone')
    .where('value_normalized', '=', normalized)
    .executeTakeFirst();
  if (held === undefined) return 'no_address';
  // Held from the check to the insert, so a STOP can't slip between them.
  await lockContactConsent(trx, contactId);
  await lockAddressConsent(trx, businessId, 'sms', normalized);
  const {
    rows: [row],
  } = await sql<{ status: CurrentConsent }>`
    select ${addressConsentStatus(sql`${businessId}::uuid`, sql`${contactId}::uuid`, sql`${normalized}::text`, 'sms', 'transactional')} as status
  `.execute(trx);
  if (row?.status === 'withdrawn') return 'withdrawn_kept';
  await recordConsent(trx, command, {
    contactId,
    channel: 'sms',
    purpose: 'transactional',
    status: 'granted',
    address: normalized,
    evidence: { source: 'booking', appointmentId, wording, ipAddress },
  });
  return 'granted';
}
