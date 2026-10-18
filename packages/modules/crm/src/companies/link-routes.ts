import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  companyLinkInput,
  getContactCompanies,
  linkContactCompany,
  unlinkContactCompany,
  parseInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { requireRecord } from '../records/access.js';
import {
  linkContactCompanyCommand,
  readContactCompanies,
  unlinkContactCompanyCommand,
} from './links.js';

export const companyLinkRoutes: readonly ApiRoute[] = [
  {
    endpoint: getContactCompanies,
    run: ({ invocation, params, query }, { db }) => {
      const { id } = parseInput(getContactCompanies.params, params);
      const { after } = parseInput(getContactCompanies.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readContactCompanies(trx, invocation, id, after),
      );
    },
  } satisfies Route<typeof getContactCompanies>,
  {
    endpoint: linkContactCompany,
    command: linkContactCompanyCommand,
    async run({ invocation, params, body }, services) {
      const parsed = parseInput(linkContactCompany.params, params);
      await withTenant(services.db, invocation.context, async (trx) => {
        await requireRecord(trx, parsed.id);
        await requireRecord(trx, parsed.companyId);
      });
      return runCommand(
        services,
        linkContactCompanyCommand,
        { ...parseInput(companyLinkInput, body), ...parsed },
        invocation,
      );
    },
  } satisfies Route<typeof linkContactCompany>,
  {
    endpoint: unlinkContactCompany,
    command: unlinkContactCompanyCommand,
    run: ({ invocation, params }, services) =>
      runCommand(
        services,
        unlinkContactCompanyCommand,
        parseInput(unlinkContactCompany.params, params),
        invocation,
      ),
  } satisfies Route<typeof unlinkContactCompany>,
];
