import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import { listTrash, parseInput, purgeRecord, restoreDeal, trashDeal } from '@repo/contracts';
import { withTenant } from '@repo/db';

import { restoreDealCommand, trashDealCommand } from './deals.js';
import { purgeRecordCommand, readTrash } from './trash.js';

const list = {
  endpoint: listTrash,
  run: ({ invocation, query }, { db }) => {
    const parsed = parseInput(listTrash.query, query);
    return withTenant(db, invocation.context, (trx) => readTrash(trx, invocation, parsed));
  },
} satisfies Route<typeof listTrash>;

const purge = {
  endpoint: purgeRecord,
  command: purgeRecordCommand,
  run: ({ invocation, params }, services) =>
    runCommand(services, purgeRecordCommand, parseInput(purgeRecord.params, params), invocation),
} satisfies Route<typeof purgeRecord>;

const trash = {
  endpoint: trashDeal,
  command: trashDealCommand,
  run: ({ invocation, params }, services) =>
    runCommand(services, trashDealCommand, parseInput(trashDeal.params, params), invocation),
} satisfies Route<typeof trashDeal>;

const restore = {
  endpoint: restoreDeal,
  command: restoreDealCommand,
  run: ({ invocation, params }, services) =>
    runCommand(services, restoreDealCommand, parseInput(restoreDeal.params, params), invocation),
} satisfies Route<typeof restoreDeal>;

export const trashRoutes: readonly ApiRoute[] = [list, purge, trash, restore];
