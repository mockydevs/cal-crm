import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createObject,
  deleteObject,
  deleteObjectInput,
  getObject,
  listObjects,
  parseInput,
  updateObject,
  updateObjectInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import {
  createObjectCommand,
  deleteObjectCommand,
  objectInPath,
  readObject,
  readObjects,
  updateObjectCommand,
  type ObjectOptions,
} from './objects.js';

/** Settings → Objects: the routes, with the reader of what uses an object being deleted. */
export function createObjectRoutes(options: ObjectOptions): readonly ApiRoute[] {
  const remove = deleteObjectCommand(options);
  return [
    {
      endpoint: listObjects,
      run: ({ invocation }, { db }) =>
        withTenant(db, invocation.context, (trx) => readObjects(trx, invocation)),
    } satisfies Route<typeof listObjects>,
    {
      endpoint: createObject,
      command: createObjectCommand,
      run: ({ invocation, body }, services) =>
        runCommand(services, createObjectCommand, body, invocation),
    } satisfies Route<typeof createObject>,
    {
      endpoint: getObject,
      run: ({ invocation, params }, { db }) => {
        const { key } = parseInput(getObject.params, params);
        return withTenant(db, invocation.context, (trx) => readObject(trx, invocation, key));
      },
    } satisfies Route<typeof getObject>,
    {
      endpoint: updateObject,
      command: updateObjectCommand,
      async run({ invocation, params, body }, services) {
        const { key } = parseInput(updateObject.params, params);
        // Visibility precedes body validation, so another business's object reveals nothing.
        await withTenant(services.db, invocation.context, (trx) => objectInPath(trx, key));
        return runCommand(
          services,
          updateObjectCommand,
          { ...parseInput(updateObjectInput, body), key },
          invocation,
        );
      },
    } satisfies Route<typeof updateObject>,
    {
      endpoint: deleteObject,
      command: remove,
      async run({ invocation, params, body }, services) {
        const { key } = parseInput(deleteObject.params, params);
        await withTenant(services.db, invocation.context, (trx) => objectInPath(trx, key));
        await runCommand(
          services,
          remove,
          { ...parseInput(deleteObjectInput, body), key },
          invocation,
        );
        return undefined;
      },
    } satisfies Route<typeof deleteObject>,
  ];
}
