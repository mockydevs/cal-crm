// Inbound do not disturb, as GoHighLevel has it: one switch on a contact for what they
// send in. Text messages from them are blocked (sms-inbound.ts): not shown in conversations,
// not passed on to the team, and they start nothing, while a STOP, START or HELP still
// changes their consent. Their calls are also blocked: the phone system checks this when an
// incoming call arrives. It stops nothing the business sends them; the outbound policy
// (outbound-policy.ts) is for that.
//
// It is a block on a number, read when something arrives from it.
import type { DatabaseTransaction } from '@repo/db';

/**
 * Whether inbound do not disturb blocks what this number sends the business: true when a
 * contact of the business who has the number has it on, in the trash or not, since a
 * number someone blocked stays blocked until they unblock it. Only this business is asked,
 * by its id and by row-level security both.
 */
export async function inboundDoNotDisturbFrom(
  trx: DatabaseTransaction,
  businessId: string,
  e164: string,
): Promise<boolean> {
  const blocked = await trx
    .selectFrom('crm.contact_identities as identity')
    .innerJoin('crm.contacts as contact', (join) =>
      join
        .onRef('contact.business_id', '=', 'identity.business_id')
        .onRef('contact.id', '=', 'identity.contact_id'),
    )
    .select('contact.id')
    .where('identity.business_id', '=', businessId)
    .where('identity.kind', '=', 'phone')
    .where('identity.value_normalized', '=', e164)
    .where('contact.dnd_inbound', '=', true)
    .limit(1)
    .executeTakeFirst();
  return blocked !== undefined;
}
