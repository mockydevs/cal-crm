import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import { createBusiness, listBusinesses, parseInput } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';

import { createBusinessCommand, type BusinessSeeder } from './businesses.js';

/**
 * The business routes, given what every new business is seeded with: the server passes
 * each module's seeder, so this module needn't know them.
 */
export function businessRoutes(options: {
  readonly seeders: readonly BusinessSeeder[];
}): ApiRoute[] {
  const command = createBusinessCommand(options.seeders);
  const createBusinessRoute = {
    endpoint: createBusiness,
    command,
    run: ({ invocation, body }, services) => runCommand(services, command, body, invocation),
  } satisfies Route<typeof createBusiness>;
  const discovery = {
    endpoint: listBusinesses,
    run: ({ invocation, query }, { db }) => {
      const input = parseInput(listBusinesses.query, query);
      return withTenant(db, invocation.context, async (trx) => {
        let read = trx
          .selectFrom('tenancy.businesses')
          .select(['id', 'name', 'slug'])
          .where('agency_id', '=', invocation.context.agencyId)
          .where('status', '=', 'active');
        if (invocation.context.businessId !== undefined)
          read = read.where('id', '=', invocation.context.businessId);
        if (input.after !== undefined)
          read = read.where('id', '>', parsePublicId('business', input.after) ?? '');
        const rows = await read
          .orderBy('id')
          .limit(input.limit + 1)
          .execute();
        const items = rows.slice(0, input.limit).map((row) => ({
          ...row,
          id: toPublicId('business', row.id),
          status: 'active' as const,
        }));
        return { items, next: rows.length > input.limit ? (items.at(-1)?.id ?? null) : null };
      });
    },
  } satisfies Route<typeof listBusinesses>;
  return [createBusinessRoute, discovery];
}
