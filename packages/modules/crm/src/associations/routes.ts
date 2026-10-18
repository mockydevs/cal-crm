import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createAssociation,
  deleteAssociation,
  getAssociation,
  listAssociations,
  parseInput,
  updateAssociation,
  updateAssociationInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import {
  associationInPath,
  createAssociationCommand,
  deleteAssociationCommand,
  readAssociation,
  readAssociations,
  updateAssociationCommand,
} from './types.js';

/** Settings → Objects → Associations. */
export const associationRoutes: readonly ApiRoute[] = [
  {
    endpoint: listAssociations,
    run: ({ invocation, query }, { db }) => {
      const parsed = parseInput(listAssociations.query, query);
      return withTenant(db, invocation.context, (trx) => readAssociations(trx, invocation, parsed));
    },
  } satisfies Route<typeof listAssociations>,
  {
    endpoint: createAssociation,
    command: createAssociationCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, createAssociationCommand, body, invocation),
  } satisfies Route<typeof createAssociation>,
  {
    endpoint: getAssociation,
    run: ({ invocation, params }, { db }) => {
      const { id } = parseInput(getAssociation.params, params);
      return withTenant(db, invocation.context, (trx) => readAssociation(trx, invocation, id));
    },
  } satisfies Route<typeof getAssociation>,
  {
    endpoint: updateAssociation,
    command: updateAssociationCommand,
    async run({ invocation, params, body }, services) {
      const { id } = parseInput(updateAssociation.params, params);
      // Visibility precedes body validation, so another business's association reveals nothing.
      await withTenant(services.db, invocation.context, (trx) => associationInPath(trx, id));
      return runCommand(
        services,
        updateAssociationCommand,
        { ...parseInput(updateAssociationInput, body), id },
        invocation,
      );
    },
  } satisfies Route<typeof updateAssociation>,
  {
    endpoint: deleteAssociation,
    command: deleteAssociationCommand,
    async run({ invocation, params }, services) {
      await runCommand(
        services,
        deleteAssociationCommand,
        parseInput(deleteAssociation.params, params),
        invocation,
      );
      return undefined;
    },
  } satisfies Route<typeof deleteAssociation>,
];
