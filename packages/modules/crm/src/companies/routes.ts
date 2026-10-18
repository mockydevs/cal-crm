import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createCompany,
  listCompanies,
  getCompany,
  updateCompany,
  updateCompanyInput,
  trashCompany,
  restoreCompany,
  parseInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import type { ActorNames } from '../activity/activity.js';
import { companyCommands, readCompany } from './companies.js';
import { readCompanyList } from './list.js';

/** The Companies routes. `actorNames` is how a company names who made it. */
export function createCompanyRoutes(actorNames: ActorNames = {}): readonly ApiRoute[] {
  const commands = companyCommands(actorNames);
  return [
    {
      endpoint: listCompanies,
      run: ({ invocation, query }, { db }) => {
        const parsed = parseInput(listCompanies.query, query);
        return withTenant(db, invocation.context, (trx) =>
          readCompanyList(trx, invocation, parsed, actorNames),
        );
      },
    } satisfies Route<typeof listCompanies>,
    {
      endpoint: createCompany,
      command: commands.create,
      run: ({ invocation, body }, services) =>
        runCommand(services, commands.create, body, invocation),
    } satisfies Route<typeof createCompany>,
    {
      endpoint: getCompany,
      run: ({ invocation, params }, { db }) => {
        const { id } = parseInput(getCompany.params, params);
        return withTenant(db, invocation.context, (trx) =>
          readCompany(trx, invocation, id, actorNames),
        );
      },
    } satisfies Route<typeof getCompany>,
    {
      endpoint: updateCompany,
      command: commands.update,
      async run({ invocation, params, body }, services) {
        const parsed = parseInput(updateCompany.params, params);
        // Visibility precedes body validation, so a foreign id cannot reveal mutation details.
        await withTenant(services.db, invocation.context, (trx) =>
          readCompany(trx, invocation, parsed.id),
        );
        return runCommand(
          services,
          commands.update,
          { ...parseInput(updateCompanyInput, body), ...parsed },
          invocation,
        );
      },
    } satisfies Route<typeof updateCompany>,
    {
      endpoint: trashCompany,
      command: commands.trash,
      run: ({ invocation, params }, services) =>
        runCommand(services, commands.trash, parseInput(trashCompany.params, params), invocation),
    } satisfies Route<typeof trashCompany>,
    {
      endpoint: restoreCompany,
      command: commands.restore,
      run: ({ invocation, params }, services) =>
        runCommand(
          services,
          commands.restore,
          parseInput(restoreCompany.params, params),
          invocation,
        ),
    } satisfies Route<typeof restoreCompany>,
  ];
}
