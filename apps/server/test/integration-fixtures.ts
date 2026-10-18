// Settings → Integrations as the server's suites compose it: the stand-in provider (its
// address need not answer for a matrix run, which never reaches it), the routes' options, and
// a connected account made as the callback and the worker would leave one.
import { toPublicId } from '@repo/kernel';
import type { IntegrationOptions } from '@repo/module-integrations';
import type { SealingVault } from '@repo/module-vault';
import type { TestDatabase } from '@repo/testing';

import { standInProvider } from '../../../packages/modules/integrations/test/fake-provider.js';

/** Every command Settings → Integrations runs: integrations.manage, owners' and admins'. */
export const INTEGRATION_COMMANDS = [
  'integration.connect',
  'integration.update',
  'integration.test',
  'integration.disconnect',
] as const;

export function integrationRouteOptions(
  vault: SealingVault,
  origin = 'http://127.0.0.1:9',
  publicUrl = 'https://crm.example.test',
): IntegrationOptions {
  return {
    providers: [standInProvider(origin)],
    vault,
    redirectUri: (key) => `${publicUrl}/api/v1/integrations/${key}/callback`,
    elsewhere: [],
    webhooks: { publicUrl, secret: 'a-public-intake-secret-of-32-characters-or-more' },
    people: () => Promise.resolve(new Map()),
  };
}

/** A connected stand-in account of the business, with a sealed secret no worker opens here. */
export async function integrationConnection(
  database: TestDatabase,
  businessId: string,
): Promise<{ id: string; revision: number }> {
  const made = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string; revision: number }>(
      `with secret as (
         insert into vault.secrets (agency_id, business_id, purpose, key_version, enc, ciphertext)
         select agency_id, id, 'integrations.standin.credentials', 1,
                decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex')
         from tenancy.businesses where id = $1
         returning business_id, id)
       insert into integrations.connections
         (business_id, provider, account_ref, account_label, status, secret_id)
       select business_id, 'standin', 'acct-' || gen_random_uuid()::text, 'Matrix Workspace',
              'connected', id
       from secret
       returning id, revision`,
      [businessId],
    ),
  );
  return { id: toPublicId('integration_connection', made.id), revision: made.revision };
}
