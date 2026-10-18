import type { ApiRoute, Route } from '@repo/commands';
import { parseInput, searchRecords as searchEndpoint } from '@repo/contracts';
import { withTenant } from '@repo/db';

import { searchRecords } from './search.js';

const search = {
  endpoint: searchEndpoint,
  run: ({ invocation, query }, { db }) => {
    const parsed = parseInput(searchEndpoint.query, query);
    return withTenant(db, invocation.context, (trx) => searchRecords(trx, invocation, parsed));
  },
} satisfies Route<typeof searchEndpoint>;

export const searchRoutes: readonly ApiRoute[] = [search];
