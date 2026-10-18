import { requireBusiness } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { NotFoundError, type TenantContext } from '@repo/kernel';

export async function lockActiveBusiness(
  trx: DatabaseTransaction,
  context: TenantContext,
): Promise<void> {
  const row = await trx
    .selectFrom('tenancy.businesses')
    .select('id')
    .where('agency_id', '=', context.agencyId)
    .where('id', '=', requireBusiness(context))
    .where('status', '=', 'active')
    // Serialize business state changes while allowing contact event/audit FKs to take
    // KEY SHARE before releasing a contact row booking must subsequently acquire.
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('Booking calendar', 'unavailable');
}
