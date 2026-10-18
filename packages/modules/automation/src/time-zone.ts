// The time zone a run reads its waits and dates in.
import type { DatabaseTransaction } from '@repo/db';

/**
 * The time zone an enrolment's waits and dates use: the business's, or the contact's own
 * when the automation says so and the contact has one.
 */
export async function timeZoneOf(
  trx: DatabaseTransaction,
  businessId: string,
  recordId: string | undefined,
  setting: 'contact' | 'business',
): Promise<string> {
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select('timezone')
    .where('id', '=', businessId)
    .executeTakeFirstOrThrow();
  if (setting === 'business' || recordId === undefined) return business.timezone;
  const contact = await trx
    .selectFrom('crm.contacts')
    .select('timezone')
    .where('id', '=', recordId)
    .executeTakeFirst();
  return contact?.timezone ?? business.timezone;
}
