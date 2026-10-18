import {
  requireBusiness,
  runCommand,
  type ApiRoute,
  type RouteRequest,
  type Route,
  type Services,
} from '@repo/commands';
import {
  createFieldFolder,
  deleteFieldFolder,
  listCustomFields,
  listFieldFolders,
  moveFieldsInput,
  moveFieldsToFolder,
  parseInput,
  renameFieldFolder,
  renameFieldFolderInput,
  reorderFieldFolders,
  reorderFolderFields,
  reorderFolderFieldsInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { NotFoundError } from '@repo/kernel';
import { readCustomFields } from './field-list.js';
import {
  createFieldFolderCommand,
  deleteFieldFolderCommand,
  fieldFolderExists,
  moveFieldsCommand,
  readFieldFolders,
  renameFieldFolderCommand,
  reorderFieldFoldersCommand,
  reorderFolderFieldsCommand,
} from './folders.js';

/**
 * The folder a path names, checked before the body is read: another business's folder is
 * not found, whatever was sent with it, so nothing about it is described (API isolation
 * suite).
 */
async function folderInPath(
  { invocation, params }: RouteRequest,
  services: Services,
): Promise<{ folderId: string }> {
  requireBusiness(invocation.context);
  const parsed = parseInput(renameFieldFolder.params, params);
  await withTenant(services.db, invocation.context, async (trx) => {
    if (!(await fieldFolderExists(trx, parsed.folderId)))
      throw new NotFoundError('Field folder', parsed.folderId);
  });
  return parsed;
}

export const fieldFolderRoutes: readonly ApiRoute[] = [
  {
    endpoint: listCustomFields,
    run: async ({ invocation, query }, { db }) => {
      requireBusiness(invocation.context);
      const parsed = parseInput(listCustomFields.query, query);
      return withTenant(db, invocation.context, (trx) => readCustomFields(trx, invocation, parsed));
    },
  } satisfies Route<typeof listCustomFields>,
  {
    endpoint: listFieldFolders,
    run: async ({ invocation, query }, { db }) => {
      requireBusiness(invocation.context);
      const parsed = parseInput(listFieldFolders.query, query);
      return withTenant(db, invocation.context, (trx) => readFieldFolders(trx, invocation, parsed));
    },
  } satisfies Route<typeof listFieldFolders>,
  {
    endpoint: createFieldFolder,
    command: createFieldFolderCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, createFieldFolderCommand, body, invocation),
  } satisfies Route<typeof createFieldFolder>,
  {
    endpoint: reorderFieldFolders,
    command: reorderFieldFoldersCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, reorderFieldFoldersCommand, body, invocation),
  } satisfies Route<typeof reorderFieldFolders>,
  {
    endpoint: renameFieldFolder,
    command: renameFieldFolderCommand,
    run: async (request, services) => {
      const parsed = await folderInPath(request, services);
      return runCommand(
        services,
        renameFieldFolderCommand,
        { ...parseInput(renameFieldFolderInput, request.body), ...parsed },
        request.invocation,
      );
    },
  } satisfies Route<typeof renameFieldFolder>,
  {
    endpoint: deleteFieldFolder,
    command: deleteFieldFolderCommand,
    run: async (request, services) => {
      const parsed = await folderInPath(request, services);
      await runCommand(services, deleteFieldFolderCommand, parsed, request.invocation);
      return undefined;
    },
  } satisfies Route<typeof deleteFieldFolder>,
  {
    endpoint: moveFieldsToFolder,
    command: moveFieldsCommand,
    run: async (request, services) => {
      const parsed = await folderInPath(request, services);
      return runCommand(
        services,
        moveFieldsCommand,
        { ...parseInput(moveFieldsInput, request.body), ...parsed },
        request.invocation,
      );
    },
  } satisfies Route<typeof moveFieldsToFolder>,
  {
    endpoint: reorderFolderFields,
    command: reorderFolderFieldsCommand,
    run: async (request, services) => {
      const parsed = await folderInPath(request, services);
      return runCommand(
        services,
        reorderFolderFieldsCommand,
        { ...parseInput(reorderFolderFieldsInput, request.body), ...parsed },
        request.invocation,
      );
    },
  } satisfies Route<typeof reorderFolderFields>,
];
