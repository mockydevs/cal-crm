import {
  requireBusiness,
  runCommand,
  type ApiRoute,
  type Route,
  type RouteRequest,
  type Services,
} from '@repo/commands';
import {
  createCustomValue,
  createCustomValueFolder,
  deleteCustomValue,
  deleteCustomValueFolder,
  deleteCustomValues,
  getCustomValue,
  listCustomValueFolders,
  listCustomValues,
  moveCustomValues,
  parseInput,
  renameCustomValueFolder,
  renameCustomValueFolderInput,
  updateCustomValue,
  updateCustomValueInput,
} from '@repo/contracts';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { NotFoundError } from '@repo/kernel';
import {
  createCustomValueCommand,
  customValueExists,
  deleteCustomValueCommand,
  deleteCustomValuesCommand,
  moveCustomValuesCommand,
  readCustomValue,
  readCustomValues,
  updateCustomValueCommand,
} from './custom-values.js';
import {
  createCustomValueFolderCommand,
  customValueFolderExists,
  deleteCustomValueFolderCommand,
  readCustomValueFolders,
  renameCustomValueFolderCommand,
} from './folders.js';

/**
 * What a path names, checked before the body is read: another business's value or folder
 * is not found, whatever was sent with it, so nothing about it is described (API isolation
 * suite).
 */
async function found(
  { invocation }: RouteRequest,
  services: Services,
  what: string,
  id: string,
  exists: (trx: DatabaseTransaction, id: string) => Promise<boolean>,
): Promise<void> {
  requireBusiness(invocation.context);
  await withTenant(services.db, invocation.context, async (trx) => {
    if (!(await exists(trx, id))) throw new NotFoundError(what, id);
  });
}

export const customValueRoutes: readonly ApiRoute[] = [
  {
    endpoint: listCustomValues,
    run: async ({ invocation, query }, { db }) => {
      requireBusiness(invocation.context);
      const parsed = parseInput(listCustomValues.query, query);
      return withTenant(db, invocation.context, (trx) => readCustomValues(trx, invocation, parsed));
    },
  } satisfies Route<typeof listCustomValues>,
  {
    endpoint: createCustomValue,
    command: createCustomValueCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, createCustomValueCommand, body, invocation),
  } satisfies Route<typeof createCustomValue>,
  {
    endpoint: moveCustomValues,
    command: moveCustomValuesCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, moveCustomValuesCommand, body, invocation),
  } satisfies Route<typeof moveCustomValues>,
  {
    endpoint: deleteCustomValues,
    command: deleteCustomValuesCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, deleteCustomValuesCommand, body, invocation),
  } satisfies Route<typeof deleteCustomValues>,
  {
    endpoint: getCustomValue,
    run: async ({ invocation, params }, { db }) => {
      requireBusiness(invocation.context);
      const { valueId } = parseInput(getCustomValue.params, params);
      return withTenant(db, invocation.context, (trx) => readCustomValue(trx, invocation, valueId));
    },
  } satisfies Route<typeof getCustomValue>,
  {
    endpoint: updateCustomValue,
    command: updateCustomValueCommand,
    run: async (request, services) => {
      const parsed = parseInput(updateCustomValue.params, request.params);
      await found(request, services, 'Custom value', parsed.valueId, customValueExists);
      return runCommand(
        services,
        updateCustomValueCommand,
        { ...parseInput(updateCustomValueInput, request.body), ...parsed },
        request.invocation,
      );
    },
  } satisfies Route<typeof updateCustomValue>,
  {
    endpoint: deleteCustomValue,
    command: deleteCustomValueCommand,
    run: async (request, services) => {
      const parsed = parseInput(deleteCustomValue.params, request.params);
      await found(request, services, 'Custom value', parsed.valueId, customValueExists);
      await runCommand(services, deleteCustomValueCommand, parsed, request.invocation);
      return undefined;
    },
  } satisfies Route<typeof deleteCustomValue>,
  {
    endpoint: listCustomValueFolders,
    run: async ({ invocation, query }, { db }) => {
      requireBusiness(invocation.context);
      const parsed = parseInput(listCustomValueFolders.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readCustomValueFolders(trx, invocation, parsed),
      );
    },
  } satisfies Route<typeof listCustomValueFolders>,
  {
    endpoint: createCustomValueFolder,
    command: createCustomValueFolderCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, createCustomValueFolderCommand, body, invocation),
  } satisfies Route<typeof createCustomValueFolder>,
  {
    endpoint: renameCustomValueFolder,
    command: renameCustomValueFolderCommand,
    run: async (request, services) => {
      const parsed = parseInput(renameCustomValueFolder.params, request.params);
      await found(
        request,
        services,
        'Custom value folder',
        parsed.folderId,
        customValueFolderExists,
      );
      return runCommand(
        services,
        renameCustomValueFolderCommand,
        { ...parseInput(renameCustomValueFolderInput, request.body), ...parsed },
        request.invocation,
      );
    },
  } satisfies Route<typeof renameCustomValueFolder>,
  {
    endpoint: deleteCustomValueFolder,
    command: deleteCustomValueFolderCommand,
    run: async (request, services) => {
      const parsed = parseInput(deleteCustomValueFolder.params, request.params);
      await found(
        request,
        services,
        'Custom value folder',
        parsed.folderId,
        customValueFolderExists,
      );
      await runCommand(services, deleteCustomValueFolderCommand, parsed, request.invocation);
      return undefined;
    },
  } satisfies Route<typeof deleteCustomValueFolder>,
];
