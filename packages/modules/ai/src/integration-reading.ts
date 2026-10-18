// What Settings → Integrations shows for AI models in a business: the connections the AI
// models page lists for it, which are its own keys and its agency's shared ones.
import type { IntegrationReading } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';

import { isConnectable } from './connections.js';

/**
 * A key that works or has not been tested yet is usable, as the gateway uses it either
 * way; a key whose last test failed needs someone. The label names the one key when it
 * has one; most keys are saved without.
 */
export async function readAiModelsIntegration(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<IntegrationReading> {
  // Row-level security shows a business its agency's keys too; the agency is matched
  // explicitly all the same, as the AI models page does.
  const rows = await trx
    .selectFrom('ai.provider_keys')
    .select(['provider', 'status', 'label'])
    .where((eb) =>
      eb(
        'agency_id',
        '=',
        eb.selectFrom('tenancy.businesses').select('agency_id').where('id', '=', businessId),
      ),
    )
    .where((eb) => eb.or([eb('business_id', 'is', null), eb('business_id', '=', businessId)]))
    .execute();
  // The page leaves out providers it does not offer, so they are not counted either.
  const listed = rows.filter((row) => isConnectable(row.provider));
  // The status is untested, working or failing (the column's check), so every key that
  // is not failing is usable.
  const attention = listed.filter((row) => row.status === 'failing').length;
  const only = listed.length === 1 ? listed[0] : undefined;
  return {
    connected: listed.length - attention,
    attention,
    label: only === undefined || only.label === '' ? null : only.label,
  };
}
