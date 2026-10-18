import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  apiKeyScopes,
  agencyApiKeyScopes,
  apiKeySelectableReadGroups,
  getApiKeyContext,
  createApiKey,
  listApiKeys,
  parseInput,
  revokeApiKey,
  type Permission,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import {
  createApiKeyCommand,
  readApiKeys,
  keyDelegationGrants,
  revokeApiKeyCommand,
  type PeopleNames,
} from './api-keys.js';
import { readApiKeyContext } from './context.js';

export interface ApiKeyOptions {
  /** How to name the people who made keys; the server passes the auth module's lookup. */
  readonly people: PeopleNames;
}

/** The routes for a business's API keys. */
export function apiKeyRoutes({ people }: ApiKeyOptions): readonly ApiRoute[] {
  const createCommand = createApiKeyCommand(people);

  const list = {
    endpoint: listApiKeys,
    async run({ invocation }, { db }) {
      const businessId = invocation.context.businessId;
      const { permissions } = invocation;
      const canManage = permissions === 'all' || permissions.has('apps.manage');
      return withTenant(db, invocation.context, async (trx) => {
        const grants = canManage
          ? await keyDelegationGrants(trx, invocation.context, permissions)
          : permissions;
        const holds = (permission: Permission) => grants === 'all' || grants.has(permission);
        return {
          items: await readApiKeys(trx, businessId, people),
          canManage: holds('apps.manage'),
          scopes: (businessId === undefined ? agencyApiKeyScopes : apiKeyScopes).filter(holds),
          scope: businessId === undefined ? ('agency' as const) : ('business' as const),
          readGroups: [...apiKeySelectableReadGroups],
        };
      });
    },
  } satisfies Route<typeof listApiKeys>;

  const create = {
    endpoint: createApiKey,
    command: createCommand,
    run: ({ invocation, body }, services) => runCommand(services, createCommand, body, invocation),
  } satisfies Route<typeof createApiKey>;

  const revoke = {
    endpoint: revokeApiKey,
    command: revokeApiKeyCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        revokeApiKeyCommand,
        parseInput(revokeApiKey.params, params),
        invocation,
      ),
  } satisfies Route<typeof revokeApiKey>;

  const context = {
    endpoint: getApiKeyContext,
    run: ({ invocation }, { db }) =>
      withTenant(db, invocation.context, (trx) => readApiKeyContext(trx, invocation.context)),
  } satisfies Route<typeof getApiKeyContext>;

  return [list, create, revoke, context];
}
