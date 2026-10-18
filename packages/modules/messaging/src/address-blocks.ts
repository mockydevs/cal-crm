// Which of a contact's addresses nothing can be sent to: the suppressions the outbound
// policy matches at every send (outbound.ts), read for the contact page. It is what this
// install honestly knows about an address. Nothing here verifies one before it is used, so
// there is no "verified" to report.
import { requireBusiness } from '@repo/commands';
import { suppressionReasons } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import type { TenantContext } from '@repo/kernel';
import type { AddressBlock } from '@repo/module-crm';
import { sql } from 'kysely';

/**
 * The contact's blocked addresses, each with why and since when. An address blocked for
 * more than one reason is given its oldest block, the one that first stopped it.
 */
export async function readContactAddressBlocks(
  trx: DatabaseTransaction,
  context: TenantContext,
  contactId: string,
): Promise<AddressBlock[]> {
  const businessId = requireBusiness(context);
  const rows = await trx
    .selectFrom('crm.contact_identities as i')
    .innerJoin('messaging.suppressions as s', (join) =>
      join
        .onRef('s.business_id', '=', 'i.business_id')
        .onRef('s.address_normalized', '=', 'i.value_normalized'),
    )
    .select(['i.kind', 'i.value_normalized', 's.reason', 's.created_at'])
    .where('i.business_id', '=', businessId)
    .where('i.contact_id', '=', contactId)
    // As sending matches them: an email address by email, a phone number by SMS.
    .where(
      sql<boolean>`s.channel = case i.kind when 'email' then 'email' when 'phone' then 'sms' end`,
    )
    .where(sql<boolean>`(s.expires_at is null or s.expires_at > now())`)
    .orderBy('s.created_at')
    .orderBy('s.id')
    .execute();
  const blocks: AddressBlock[] = [];
  for (const row of rows) {
    const kind = row.kind === 'email' ? 'email' : 'phone';
    const reason = suppressionReasons.find((each) => each === row.reason);
    if (reason === undefined) continue;
    if (blocks.some((each) => each.kind === kind && each.value === row.value_normalized)) continue;
    blocks.push({ kind, value: row.value_normalized, reason, since: row.created_at });
  }
  return blocks;
}
