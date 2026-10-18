// A booking's touch, and what the business's own lead source rules add to its contact.
// Apart from touches.ts because applying a rule writes tags and field values through the
// CRM's commands, which themselves read contacts: touches.ts is what making a contact
// calls, and must not lead back to it.
import { requireBusiness, type CommandContext } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';

import { readArrival, type SaidVisit } from './arrival.js';
import { applyLeadSourceRules } from './lead-source-apply.js';
import { recordTouch } from './touches.js';

/**
 * The touch of a booking made on the public booking page, for the calendar module, which
 * owns no table of the CRM's: what the page said of the visit, read as any visit is, and
 * how the visit began when the booking page was reached from another page of the same
 * address (arrival.ts).
 */
export async function recordBookingTouch(
  trx: DatabaseTransaction,
  input: {
    readonly contactId: string;
    readonly appointmentId: string;
    readonly visit?: SaidVisit | undefined;
  },
  command: CommandContext,
): Promise<void> {
  const arrival = readArrival(input.visit ?? {});
  const decision = await recordTouch(trx, requireBusiness(command.context), {
    contactId: input.contactId,
    medium: 'calendar',
    visit: arrival.visit,
    page: { url: arrival.pageUrl, carried: arrival.carried },
    address: arrival.address,
    subject: { kind: 'appointment', id: input.appointmentId },
  });
  // What the business's matching rules add to the contact: their tags and field values.
  // A booking writes no Source of its own; the touch carries the name.
  if (decision !== undefined) await applyLeadSourceRules(trx, command, input.contactId, decision);
}
