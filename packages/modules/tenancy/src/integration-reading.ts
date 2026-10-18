// What Settings → Integrations shows for apps and the API in a business: the API keys that
// still work and the marketplace apps installed. Neither can fail on its own, so nothing
// here ever needs attention, and there is no one account to name.
import type { IntegrationReading } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';

export async function readAppsIntegration(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<IntegrationReading> {
  // The business's own keys, as the API keys page lists them: an installed app's key is
  // the install's and is counted with it, and the agency's keys are the agency's. A key
  // past its expiry no longer signs anyone in, so it is left out as a revoked one is.
  const keys = await trx
    .selectFrom('tenancy.api_keys')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('business_id', '=', businessId)
    .where('marketplace_install_id', 'is', null)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', sql<Date>`now()`)]))
    .executeTakeFirstOrThrow();
  const installs = await trx
    .selectFrom('tenancy.marketplace_installs')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('business_id', '=', businessId)
    .where('uninstalled_at', 'is', null)
    .executeTakeFirstOrThrow();
  return { connected: keys.count + installs.count, attention: 0, label: null };
}
