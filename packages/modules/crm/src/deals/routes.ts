import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createDeal,
  updateDeal,
  updateDealInput,
  getDeal,
  getDeals,
  getDealStageSummary,
  getOpportunityReport,
  parseInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { createDealCommand, updateDealCommand, readDeal, listDeals } from './deals.js';
import type { DealPeopleOptions } from './details.js';
import { readOpportunityReport } from './report.js';
import { readDealStageSummary } from './summary.js';

const create = {
  endpoint: createDeal,
  command: createDealCommand,
  run: ({ invocation, body }, services) =>
    runCommand(services, createDealCommand, body, invocation),
} satisfies Route<typeof createDeal>;
const update = {
  endpoint: updateDeal,
  command: updateDealCommand,
  async run({ invocation, params, body }, services) {
    const { id } = parseInput(updateDeal.params, params);
    // Match every record route's 404 boundary before inspecting a foreign record's body.
    await withTenant(services.db, invocation.context, (trx) => readDeal(trx, invocation, id));
    return runCommand(
      services,
      updateDealCommand,
      { ...parseInput(updateDealInput, body), id },
      invocation,
    );
  },
} satisfies Route<typeof updateDeal>;
const read = {
  endpoint: getDeal,
  run: ({ invocation, params }, { db }) =>
    withTenant(db, invocation.context, (trx) =>
      readDeal(trx, invocation, parseInput(getDeal.params, params).id),
    ),
} satisfies Route<typeof getDeal>;
// A row's owner is named by the modules that own the team and people's names: the server
// hands their lookups over (details.ts). Without them a list answers no owners.
const list = (people?: DealPeopleOptions) =>
  ({
    endpoint: getDeals,
    run: ({ invocation, query }, { db }) =>
      withTenant(db, invocation.context, (trx) =>
        listDeals(trx, invocation, parseInput(getDeals.query, query), people),
      ),
  }) satisfies Route<typeof getDeals>;
// What the board's column headers show, over the same filters as the cards.
const summary = {
  endpoint: getDealStageSummary,
  run: ({ invocation, query }, { db }) =>
    withTenant(db, invocation.context, (trx) =>
      readDealStageSummary(trx, invocation, parseInput(getDealStageSummary.query, query)),
    ),
} satisfies Route<typeof getDealStageSummary>;
// The numbers behind the Dashboard's opportunity widgets.
const report = {
  endpoint: getOpportunityReport,
  run: ({ invocation, query }, { db }) =>
    withTenant(db, invocation.context, (trx) =>
      readOpportunityReport(trx, invocation, parseInput(getOpportunityReport.query, query)),
    ),
} satisfies Route<typeof getOpportunityReport>;
export const createDealRoutes = (people?: DealPeopleOptions): readonly ApiRoute[] => [
  create,
  update,
  read,
  list(people),
  summary,
  report,
];
export const dealRoutes: readonly ApiRoute[] = createDealRoutes();
