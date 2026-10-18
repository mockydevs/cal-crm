import { requireBusiness, type CommandContext } from '@repo/commands';
import { parseInput } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { isTimeZone, NotFoundError } from '@repo/kernel';
import * as z from 'zod';

import { findTimeZone } from './contact-settings.js';

const timezoneInput = z.strictObject({
  contactId: z.uuid(),
  timezone: z.string().refine(isTimeZone),
});

/**
 * Called only by a scoped booking command with the contact its canonical intake resolved.
 * Gives the contact the zone the booking page reported, if it has none: stored as
 * PostgreSQL spells it, since the send check matches that name exactly. A zone this server
 * doesn't have is left unset rather than refused, so the booking still goes through; the
 * contact then shows no time zone, and someone can set it.
 */
export async function setBookingContactTimezone(
  trx: DatabaseTransaction,
  input: { readonly contactId: string; readonly timezone: string },
  command: CommandContext,
): Promise<boolean> {
  const { contactId, timezone } = parseInput(timezoneInput, input);
  const businessId = requireBusiness(command.context);
  const contact = await trx
    .selectFrom('crm.contacts')
    .select(['id', 'timezone', 'deleted_at'])
    .where('business_id', '=', businessId)
    .where('id', '=', contactId)
    // Leaves foreign keys to the contact free, as lockLiveContact (details.ts) explains.
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (contact?.deleted_at !== null) throw new NotFoundError('Booking contact', 'unavailable');
  if (contact.timezone !== null) return false;
  const zone = await findTimeZone(trx, timezone);
  if (zone === undefined) return false;
  await trx
    .updateTable('crm.contacts')
    .set({ timezone: zone })
    .where('business_id', '=', businessId)
    .where('id', '=', contactId)
    .execute();
  await command.emit({
    type: 'contact.updated',
    subject: { kind: 'contact', id: contactId },
    payload: { changed: ['timeZone'] },
    records: [contactId],
  });
  return true;
}
